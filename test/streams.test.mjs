import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildChunkFrame, buildEventFrame, buildProjectionFrame, buildProjectionFrames, ControlBridge, FollowRegistry, hostSupportsAssistantStream } from '../lib/streams.js'

test('buildEventFrame wraps a wire event in the old server-request envelope', () => {
  const frame = JSON.parse(buildEventFrame('s1', { type: 'user/message', seq: 1, data: { content: [] } }))
  assert.equal(frame.type, 'server-request')
  assert.match(frame.rpcId, /^apigw-/)
  assert.equal(frame.method, 'session/event')
  assert.deepEqual(frame.payload, {
    type: 'session/event',
    sessionId: 's1',
    event: { type: 'user/message', seq: 1, data: { content: [] } },
  })
})

test('buildProjectionFrames emits one session/projection frame per key', () => {
  const frames = buildProjectionFrames('s1', {
    asOfSeq: 3,
    values: { title: 't1', tokenUsage: { outputTokens: 1 } },
  }).map((f) => JSON.parse(f))
  assert.equal(frames.length, 2)
  assert.deepEqual(frames.map((f) => f.payload.key).sort(), ['title', 'tokenUsage'])
  for (const frame of frames) {
    assert.equal(frame.method, 'session/projection')
    assert.equal(frame.payload.type, 'session/projection')
    assert.equal(frame.payload.sessionId, 's1')
  }
  assert.deepEqual(buildProjectionFrames('s1', null), [], 'missing projections yield no frames')
})

test('FollowRegistry pumps snapshot projections and incremental events to the broadcast', async () => {
  const opened = []
  const broadcasted = []
  const registry = new FollowRegistry(
    {
      stream: async (request) => {
        opened.push(request)
        return (async function* () {
          yield { type: 'snapshot', projections: { asOfSeq: 1, values: { title: 't1' } } }
          yield { type: 'event', event: { type: 'turn/start', seq: 2, data: { turn: 1 } } }
          yield { type: 'chunks', event: { type: 'chunkrow/text', seq: 3, data: { text: 'x' } } }
        })()
      },
    },
    (json) => broadcasted.push(JSON.parse(json)),
    () => {},
  )
  registry.ensure('s1')
  registry.ensure('s1') // 幂等：不重复开流
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(opened.length, 1, 'ensure is idempotent')
  assert.deepEqual(opened[0], {
    namespace: 'session', method: 'follow',
    args: { request: { address: { kind: 'session', sessionId: 's1' } } },
  })
  assert.deepEqual(
    broadcasted.map((f) => f.method),
    ['session/projection', 'session/event'],
    'snapshot keys project, events forward, chunks records are ignored',
  )
  assert.equal(broadcasted[1].payload.event.type, 'turn/start')
})

test('buildProjectionFrame emits one old-frame per live projection update with its seq', () => {
  const frame = JSON.parse(buildProjectionFrame('s1', 'tokenUsage', { outputTokens: 7 }, 12))
  assert.equal(frame.method, 'session/projection')
  assert.deepEqual(frame.payload, {
    type: 'session/projection',
    sessionId: 's1',
    key: 'tokenUsage',
    value: { outputTokens: 7 },
    seq: 12,
  })
})

test('ControlBridge translates baseline + live projections and reconnects after stream end', async () => {
  let opens = 0
  let endStream = null
  const broadcasted = []
  const bridge = new ControlBridge(
    {
      stream: async () => {
        opens += 1
        return (async function* () {
          if (opens === 1) {
            yield {
              type: 'baseline',
              value: { projections: { s1: { asOfSeq: 3, values: { title: 't1', tokenUsage: { outputTokens: 1 } } } } },
            }
            yield { type: 'projection', sessionId: 's1', key: 'tokenUsage', value: { outputTokens: 9 }, seq: 5 }
            yield { type: 'queue', sessionId: 's1', items: [] } // 无老契约消费者：忽略
          }
          await new Promise((resolve) => { endStream = resolve })
        })()
      },
    },
    (json) => broadcasted.push(JSON.parse(json)),
    () => {},
    10,
  )
  bridge.start()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(opens, 1)
  assert.deepEqual(
    broadcasted.map((f) => [f.method, f.payload.key, f.payload.seq]),
    [['session/projection', 'title', 3], ['session/projection', 'tokenUsage', 3], ['session/projection', 'tokenUsage', 5]],
    'baseline projects every session key with asOfSeq, live deltas carry their seq',
  )
  // 流终止 → 重连（retryMs=10）
  endStream()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(opens, 2, 'the control stream reopens after the host ends it')
  bridge.dispose()
  const before = opens
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(opens, before, 'dispose stops the reconnect loop')
})

// ---- 0.2.x opt-in assistant live stream (chunk restoration, dsh-facts §18.13) ----

test('hostSupportsAssistantStream gates on verified lines only', () => {
  assert.equal(hostSupportsAssistantStream('0.2.0-rc.2'), true)
  assert.equal(hostSupportsAssistantStream('0.2.3'), true)
  assert.equal(hostSupportsAssistantStream('1.0.0'), true)
  assert.equal(hostSupportsAssistantStream('0.1.5-rc.2'), false, 'verified legacy line keeps the proven request shape')
  assert.equal(hostSupportsAssistantStream('0.1.7-rc.2'), false, 'unverified corridor line stays conservative')
  assert.equal(hostSupportsAssistantStream('0.0.1'), false, 'protocol-constant fallback is not a host version')
  assert.equal(hostSupportsAssistantStream('garbage'), false)
})

test('buildChunkFrame wraps the live chunk in the frozen assistant/chunk wire shape', () => {
  const chunk = { type: 'text-delta', text: 'he' }
  const frame = JSON.parse(buildChunkFrame('s1', { type: 'chunk', chunk }, 5.5))
  assert.equal(frame.method, 'session/event')
  assert.deepEqual(frame.payload.event, { type: 'assistant/chunk', seq: 5.5, data: { chunk } })
  // attempt lifecycle markers carry no chunk: nothing to broadcast
  assert.equal(buildChunkFrame('s1', { type: 'start', startedAfterSeq: 5 }, 0), null)
  assert.equal(buildChunkFrame('s1', { type: 'end' }, 0), null)
  assert.equal(buildChunkFrame('s1', null, 0), null)
})

test('FollowRegistry opts into assistantStream and translates live members with fractional seqs', async () => {
  const opened = []
  const broadcasted = []
  const registry = new FollowRegistry(
    {
      stream: async (request) => {
        opened.push(request)
        return (async function* () {
          yield { type: 'snapshot', projections: { asOfSeq: 1, values: {} } }
          yield { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a1', turn: 1, step: 1, startedAfterSeq: 4 } }
          yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'he' } } }
          yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'llo' } } }
          yield { type: 'assistant-stream', frame: { type: 'end', attemptId: 'a1' } }
          yield { type: 'event', event: { type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: 'hello' }] } } } }
          // a second gap bases off the durable cursor when no start marker arrives
          yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'usage', usage: { outputTokens: 3 } } } }
        })()
      },
    },
    (json) => broadcasted.push(JSON.parse(json)),
    () => {},
    true,
  )
  registry.ensure('s1')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(opened[0].args.request, {
    address: { kind: 'session', sessionId: 's1' },
    assistantStream: true,
  }, 'the flag rides along only when the host line supports it')
  const chunks = broadcasted.filter((f) => f.payload?.event?.type === 'assistant/chunk')
  assert.deepEqual(chunks.map((f) => f.payload.event.seq), [5 - 1 / 2, 5 - 1 / 3, 5 + 1 - 1 / 2],
    'fractional seqs stack inside the gap (start base 4), never reaching the next durable seq, and rebase after it')
  assert.deepEqual(chunks.map((f) => f.payload.event.data.chunk), [
    { type: 'text-delta', text: 'he' },
    { type: 'text-delta', text: 'llo' },
    { type: 'usage', usage: { outputTokens: 3 } },
  ])
  const durable = broadcasted.filter((f) => f.payload?.event?.type === 'assistant/message')
  assert.equal(durable.length, 1, 'durable events still flow unchanged')
  const methods = broadcasted.map((f) => f.method)
  assert.ok(!methods.includes(undefined) && methods.every((m) => m === 'session/event' || m === 'session/projection'),
    'start/end markers broadcast nothing')
})

test('FollowRegistry without the flag keeps the legacy request byte-identical', async () => {
  const opened = []
  const registry = new FollowRegistry(
    { stream: async (request) => { opened.push(request); return (async function* () {})() } },
    () => {},
    () => {},
  )
  registry.ensure('s2')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(opened[0], {
    namespace: 'session', method: 'follow',
    args: { request: { address: { kind: 'session', sessionId: 's2' } } },
  })
})
