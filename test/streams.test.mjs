import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEventFrame, buildProjectionFrames, FollowRegistry } from '../lib/streams.js'

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
