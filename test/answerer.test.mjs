import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Answerer } from '../lib/answerer.js'

const questionRequest = {
  questions: [{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }],
  agent: { id: 's1' },
}
const approvalRequest = { agent: { id: 's1' }, toolName: 'shell', callId: 'c1', reason: 'writes files' }

const setup = () => {
  const ctx = new Context()
  const broadcast = []
  const logs = []
  const answerer = new Answerer(
    (json) => broadcast.push(JSON.parse(json)),
    (line) => logs.push(line),
  )
  const dispose = answerer.mount(ctx)
  return { ctx, broadcast, logs, answerer, dispose }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('question: broadcasts old frame, settle claims with answers, resolved frame follows', async () => {
  const { ctx, broadcast, answerer, dispose } = setup()
  try {
    let fellThrough = false
    const pending = ctx.waterfall('user-questions/request', questionRequest, () => {
      fellThrough = true
      return { answers: [] }
    })
    await tick()
    assert.equal(answerer.pendingCount(), 1, 'the pending entry is registered synchronously')
    const frame = broadcast[0]
    assert.equal(frame.type, 'server-request')
    assert.equal(frame.method, 'question/requested')
    assert.match(frame.rpcId, /^apigw-/)
    assert.deepEqual(frame.payload, {
      type: 'question/requested',
      sessionId: 's1',
      questions: questionRequest.questions,
    })

    const receipt = answerer.settle({
      rpcId: frame.rpcId,
      result: { ok: true, value: { sessionId: 's1', answer: { answers: [{ id: 'q1', selected: ['yes'], custom: 'why not' }] } } },
    })
    assert.deepEqual(receipt, { found: true })
    assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['yes'], custom: 'why not' }] })
    assert.equal(fellThrough, false, 'a claimed question must not delegate')
    assert.equal(answerer.pendingCount(), 0)
    const resolved = broadcast[1]
    assert.equal(resolved.method, 'question/resolved')
    assert.equal(resolved.payload.questionRpcId, frame.rpcId)
    assert.equal(resolved.payload.outcome, 'answered')
  } finally {
    dispose()
  }
})

test('question decline (not-ok + cancelled): ASK_CANCELLED rejection, resolved frame, accepted receipt', async () => {
  const { ctx, broadcast, answerer, dispose } = setup()
  try {
    let fellThrough = false
    const pending = ctx.waterfall('user-questions/request', questionRequest, () => {
      fellThrough = true
      return { answers: [] }
    })
    await tick()
    const frame = broadcast[0]
    const receipt = answerer.settle({
      rpcId: frame.rpcId,
      result: { ok: false, error: { code: 'cancelled', message: 'the user cancelled ask_user_question' } },
    })
    assert.deepEqual(receipt, { found: true }, 'a decline is still a claimed pending entry')
    await assert.rejects(pending, (error) => {
      assert.equal(error.name, 'UserQuestionError')
      assert.equal(error.code, 'ASK_CANCELLED')
      return true
    })
    assert.equal(fellThrough, false, 'a decline must not delegate to the next answerer')
    const resolved = broadcast[1]
    assert.equal(resolved.method, 'question/resolved')
    assert.equal(resolved.payload.outcome, 'cancelled')
  } finally {
    dispose()
  }
})

test('question abort: the pending entry is released and the request delegates', async () => {
  const { ctx, answerer, dispose } = setup()
  try {
    const controller = new AbortController()
    const pending = ctx.waterfall('user-questions/request', { ...questionRequest, signal: controller.signal }, () => 'FALLBACK')
    await tick()
    assert.equal(answerer.pendingCount(), 1)
    controller.abort()
    assert.equal(await pending, 'FALLBACK', 'aborted requests delegate to the next answerer')
    assert.equal(answerer.pendingCount(), 0)
  } finally {
    dispose()
  }
})

test('approval: broadcasts old frame, outcome passthrough, resolved frame follows', async () => {
  const { ctx, broadcast, answerer, dispose } = setup()
  try {
    let fellThrough = false
    const pending = ctx.waterfall('approval/request', approvalRequest, () => {
      fellThrough = true
      return 'unavailable'
    })
    await tick()
    assert.equal(answerer.pendingCount(), 1)
    const frame = broadcast[0]
    assert.equal(frame.method, 'approval/requested')
    assert.equal(frame.payload.approvalId, frame.rpcId, 'approvalId doubles as the respond rpcId')
    assert.equal(frame.payload.toolName, 'shell')
    assert.equal(frame.payload.callId, 'c1')
    assert.equal(frame.payload.reason, 'writes files')

    const receipt = answerer.settle({
      rpcId: frame.rpcId,
      result: { ok: true, value: { sessionId: 's1', approvalId: frame.payload.approvalId, outcome: 'rejected' } },
    })
    assert.deepEqual(receipt, { found: true })
    assert.equal(await pending, 'rejected')
    assert.equal(fellThrough, false)
    const resolved = broadcast[1]
    assert.equal(resolved.method, 'approval/resolved')
    assert.equal(resolved.payload.approvalId, frame.payload.approvalId)
    assert.equal(resolved.payload.outcome, 'rejected')
  } finally {
    dispose()
  }
})

test('settle: unknown rpcId reports not-found and changes nothing', async () => {
  const { answerer, dispose } = setup()
  try {
    assert.deepEqual(answerer.settle({ rpcId: 'apigw-nope', result: { ok: true, value: {} } }), { found: false })
    assert.deepEqual(answerer.settle({ rpcId: 42, result: { ok: true } }), { found: false }, 'non-string rpcId never matches')
    assert.equal(answerer.pendingCount(), 0)
  } finally {
    dispose()
  }
})

test('dispose removes listeners and rejects pending entries', async () => {
  const { ctx, broadcast, answerer, dispose } = setup()
  const pending = ctx.waterfall('user-questions/request', questionRequest, () => 'FALLBACK')
  await tick()
  assert.equal(answerer.pendingCount(), 1)
  dispose()
  assert.equal(await pending, 'FALLBACK', 'unloading rejects the pending entry and the request delegates')
  assert.equal(answerer.pendingCount(), 0)

  // After disposal the listeners are gone: a fresh request falls through without a frame.
  const before = broadcast.length
  const second = ctx.waterfall('user-questions/request', questionRequest, () => 'FALLBACK')
  assert.equal(await second, 'FALLBACK')
  assert.equal(broadcast.length, before, 'no frame is broadcast after disposal')
})
