import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEventFrame, buildProjectionFrame, buildProjectionFrames, ControlBridge, FollowRegistry } from '../lib/streams.js'

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
