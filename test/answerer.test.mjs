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

// ---------------------------------------------------------------------------
// 进程内远程事件客户端路径（方案 A：browser 同款 $events 流）
// ---------------------------------------------------------------------------

/** 可控的 $events 流 + 记录 $events/result 上行的 fake carrier。 */
const makeRemoteCarrier = () => {
  const queue = []
  let waiter = null
  let closed = false
  const results = []
  const source = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift()
        if (closed) return
        await new Promise((resolve) => { waiter = resolve })
      }
    },
  }
  return {
    carrier: {
      openStream: async () => source,
      sendResult: async (args) => { results.push(args) },
    },
    results,
    push: (value) => { queue.push(value); if (waiter !== null) { waiter(); waiter = null } },
    close: () => { closed = true; if (waiter !== null) { waiter(); waiter = null } },
  }
}

const remoteSetup = async () => {
  const broadcast = []
  const logs = []
  const answerer = new Answerer(
    (json) => broadcast.push(JSON.parse(json)),
    (line) => logs.push(line),
  )
  const harness = makeRemoteCarrier()
  const dispose = await answerer.mountRemote(harness.carrier)
  return { broadcast, logs, answerer, dispose, ...harness }
}

test('remote: stream open failure rejects so the caller falls back to ctx.on listeners', async () => {
  const answerer = new Answerer(() => {}, () => {})
  await assert.rejects(
    answerer.mountRemote({
      openStream: async () => { throw new Error('gateway/service-unavailable') },
      sendResult: async () => {},
    }),
    /service-unavailable/,
  )
})

test('remote question: broadcasts old frame with agentId as sessionId, claims via $events/result', async () => {
  const { broadcast, answerer, dispose, results, push } = await remoteSetup()
  try {
    push({ type: 'ready', clientId: 'client-1', host: { home: '/home' } })
    push({
      type: 'waterfall', event: 'user-questions/request', eventId: 'ev-1', agentId: 's1',
      request: { questions: [{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }] },
    })
    await tick()
    assert.equal(answerer.pendingCount(), 1)
    const frame = broadcast[0]
    assert.equal(frame.type, 'server-request')
    assert.equal(frame.method, 'question/requested')
    assert.match(frame.rpcId, /^apigw-/)
    assert.deepEqual(frame.payload, {
      type: 'question/requested',
      sessionId: 's1', // agentId 即 sessionId（0.1.2 host agent 上下文身份实证）
      questions: [{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }],
    })

    answerer.settle({
      rpcId: frame.rpcId,
      result: { ok: true, value: { answer: { answers: [{ id: 'q1', selected: ['yes'], custom: 'why not' }] } } },
    })
    await tick()
    assert.equal(answerer.pendingCount(), 0)
    assert.deepEqual(results[0], {
      clientId: 'client-1',
      eventId: 'ev-1',
      outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['yes'], custom: 'why not' }] } },
    }, 'the claim value is the AskUserQuestionAnswer shape the waterfall returns')
    const resolved = broadcast[1]
    assert.equal(resolved.method, 'question/resolved')
    assert.equal(resolved.payload.questionRpcId, frame.rpcId)
    assert.equal(resolved.payload.outcome, 'answered')
  } finally {
    dispose()
  }
})

test('remote question decline: ASK_CANCELLED rejection rides the result frame', async () => {
  const { broadcast, answerer, dispose, results, push } = await remoteSetup()
  try {
    push({ type: 'ready', clientId: 'client-1', host: { home: '/home' } })
    push({
      type: 'waterfall', event: 'user-questions/request', eventId: 'ev-2', agentId: 's1',
      request: { questions: [{ id: 'q1', question: 'proceed?' }] },
    })
    await tick()
    const frame = broadcast[0]
    answerer.settle({
      rpcId: frame.rpcId,
      result: { ok: false, error: { code: 'cancelled', message: 'the user cancelled ask_user_question' } },
    })
    await tick()
    assert.deepEqual(results[0], {
      clientId: 'client-1',
      eventId: 'ev-2',
      outcome: {
        kind: 'rejected',
        error: { name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED' },
      },
    })
    const resolved = broadcast[1]
    assert.equal(resolved.method, 'question/resolved')
    assert.equal(resolved.payload.outcome, 'cancelled')
  } finally {
    dispose()
  }
})

test('remote approval: outcome string passthrough, resolved frame follows', async () => {
  const { broadcast, answerer, dispose, results, push } = await remoteSetup()
  try {
    push({ type: 'ready', clientId: 'client-1', host: { home: '/home' } })
    push({
      type: 'waterfall', event: 'approval/request', eventId: 'ev-3', agentId: 's2',
      request: { toolName: 'shell', callId: 'c1', reason: 'writes files' },
    })
    await tick()
    const frame = broadcast[0]
    assert.equal(frame.method, 'approval/requested')
    assert.equal(frame.payload.sessionId, 's2')
    assert.equal(frame.payload.approvalId, frame.rpcId)
    assert.equal(frame.payload.toolName, 'shell')
    assert.equal(frame.payload.callId, 'c1')
    assert.equal(frame.payload.reason, 'writes files')

    answerer.settle({ rpcId: frame.rpcId, result: { ok: true, value: { outcome: 'rejected' } } })
    await tick()
    assert.deepEqual(results[0], {
      clientId: 'client-1',
      eventId: 'ev-3',
      outcome: { kind: 'result', value: 'rejected' },
    }, 'the claim value is the bare ApprovalOutcome string')
    const resolved = broadcast[1]
    assert.equal(resolved.method, 'approval/resolved')
    assert.equal(resolved.payload.outcome, 'rejected')
  } finally {
    dispose()
  }
})

test('remote cancel frame: pending entry released, card closed with cancelled, result delegates', async () => {
  const { broadcast, answerer, dispose, results, push } = await remoteSetup()
  try {
    push({ type: 'ready', clientId: 'client-1', host: { home: '/home' } })
    push({
      type: 'waterfall', event: 'approval/request', eventId: 'ev-4', agentId: 's3',
      request: { toolName: 'shell', callId: null, reason: null },
    })
    await tick()
    assert.equal(answerer.pendingCount(), 1)
    push({ type: 'cancel', eventId: 'ev-4' })
    await tick()
    assert.equal(answerer.pendingCount(), 0, 'the host cancellation releases the pending entry')
    const resolved = broadcast.find((f) => f.method === 'approval/resolved')
    assert.equal(resolved.payload.outcome, 'cancelled', 'the manager card closes on host cancellation')
    const result = results.find((r) => r.eventId === 'ev-4')
    assert.deepEqual(result.outcome, { kind: 'next' }, 'an unanswered cancelled request delegates')
  } finally {
    dispose()
  }
})

test('remote dispose: aborts the stream and releases pending entries', async () => {
  const { broadcast, answerer, dispose, push, close } = await remoteSetup()
  push({ type: 'ready', clientId: 'client-1', host: { home: '/home' } })
  push({
    type: 'waterfall', event: 'user-questions/request', eventId: 'ev-5', agentId: 's1',
    request: { questions: [{ id: 'q1', question: 'go?' }] },
  })
  await tick()
  assert.equal(answerer.pendingCount(), 1)
  dispose()
  assert.equal(answerer.pendingCount(), 0, 'unloading releases every pending entry')
  close()
})
