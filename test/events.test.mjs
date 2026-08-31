/**
 * Unit tests for the session-event mapping.
 *
 * Runs against the BUILT output (`lib/`) so it also guards the shape the
 * deployment actually loads. Run `pnpm build` first (CI does).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkJson, eventPayload, extractBlocks, mapEvents, normalizeUsage, sseFrame, sumUsage } from '../lib/events.js'

test('extractBlocks splits text and reasoning, never concatenating them', () => {
  const content = [
    { type: 'reasoning', text: 'thinking ' },
    { type: 'text', text: 'hello ' },
    { type: 'reasoning', text: 'more' },
    { type: 'text', text: 'world' },
    { type: 'image', url: 'ignored' },
    null,
  ]
  assert.deepEqual(extractBlocks(content), { text: 'hello world', reasoning: 'thinking more' })
})

test('extractBlocks tolerates non-array content', () => {
  for (const input of [undefined, null, 'text', 42, {}]) {
    assert.deepEqual(extractBlocks(input), { text: '', reasoning: '' })
  }
})

test('chunkJson maps known stream chunks and drops unknown ones', () => {
  assert.deepEqual(chunkJson({ type: 'text-delta', text: 'hi' }), { type: 'text-delta', text: 'hi' })
  assert.deepEqual(chunkJson({ type: 'reasoning-delta', text: 'hm' }), { type: 'reasoning-delta', text: 'hm' })
  assert.deepEqual(chunkJson({ type: 'tool-call-delta', id: 'c1', name: 'bash', argumentsDelta: '{"a' }), {
    type: 'tool-call-delta', id: 'c1', name: 'bash', argumentsDelta: '{"a',
  })
  assert.deepEqual(chunkJson({ type: 'tool-call-delta' }), {
    type: 'tool-call-delta', id: null, name: null, argumentsDelta: '',
  })
  assert.deepEqual(chunkJson({ type: 'finish', reason: { kind: 'stop' } }), { type: 'finish', reason: 'stop' })
  assert.deepEqual(chunkJson({ type: 'finish' }), { type: 'finish', reason: 'unknown' })
  assert.equal(chunkJson({ type: 'who-knows' }), null)
  assert.equal(chunkJson(null), null)
  assert.equal(chunkJson('text'), null)
})

test('eventPayload maps a user message', () => {
  const payload = eventPayload({
    type: 'user/message', seq: 3,
    data: { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
  })
  assert.deepEqual(payload, { kind: 'user', seq: 3, messageId: 'm1', text: 'hi' })
})

test('eventPayload keeps reasoning out of the answer text', () => {
  const payload = eventPayload({
    type: 'assistant/message', seq: 7,
    data: {
      message: { content: [{ type: 'reasoning', text: 'why' }, { type: 'text', text: 'because' }] },
      usage: { inputTokens: 10 },
    },
  })
  assert.deepEqual(payload, {
    kind: 'message', seq: 7, text: 'because', reasoning: 'why', usage: { inputTokens: 10, outputTokens: 0 },
  })
})

test('normalizeUsage keeps the known counters and drops everything else', () => {
  assert.deepEqual(normalizeUsage({
    inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 1,
    promptTokens: 999, nested: { live: true },
  }), { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 1 })
  // A partial report still counts: the absent side is zero, not missing.
  assert.deepEqual(normalizeUsage({ outputTokens: 7 }), { inputTokens: 0, outputTokens: 7 })
})

test('normalizeUsage returns null when no accounting was reported', () => {
  for (const input of [null, undefined, 'x', 1, {}, { cacheReadTokens: 5 }, { inputTokens: 'many' }, { inputTokens: NaN }]) {
    assert.equal(normalizeUsage(input), null)
  }
})

test('sumUsage accumulates steps into a turn total', () => {
  const first = normalizeUsage({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 })
  const second = normalizeUsage({ inputTokens: 5, outputTokens: 6, reasoningTokens: 3 })
  assert.deepEqual(sumUsage(sumUsage(null, first), second), {
    inputTokens: 15, outputTokens: 10, cacheReadTokens: 2, reasoningTokens: 3,
  })
})

test('sumUsage leaves the total untouched for steps without accounting', () => {
  const total = normalizeUsage({ inputTokens: 1, outputTokens: 2 })
  assert.deepEqual(sumUsage(total, null), total)
  assert.equal(sumUsage(null, null), null)
  // The accumulator is never the same object as either input: it must stay JSON-safe to emit.
  assert.notEqual(sumUsage(null, total), total)
})

test('chunkJson normalizes the usage chunk', () => {
  assert.deepEqual(chunkJson({ type: 'usage', usage: { inputTokens: 3, outputTokens: 1, promptTokens: 9 } }), {
    type: 'usage', usage: { inputTokens: 3, outputTokens: 1 },
  })
  assert.deepEqual(chunkJson({ type: 'usage' }), { type: 'usage', usage: null })
})

test('eventPayload reports null reasoning when the model did not think aloud', () => {
  const payload = eventPayload({
    type: 'assistant/message', seq: 8, data: { message: { content: [{ type: 'text', text: 'ok' }] } },
  })
  assert.equal(payload.reasoning, null)
  assert.equal(payload.usage, null)
})

test('eventPayload drops assistant chunks with no wire form', () => {
  assert.equal(eventPayload({ type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'nope' } } }), null)
  assert.deepEqual(eventPayload({ type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text-delta', text: 'a' } } }), {
    kind: 'chunk', seq: 2, chunk: { type: 'text-delta', text: 'a' },
  })
})

test('eventPayload maps tool calls and results', () => {
  assert.deepEqual(eventPayload({ type: 'tool/call', seq: 4, data: { name: 'bash', arguments: '{}' } }), {
    kind: 'tool_call', seq: 4, name: 'bash', arguments: '{}',
  })
  const ok = eventPayload({
    type: 'tool/result', seq: 5,
    data: { message: { content: [{ isError: false, content: [{ type: 'text', text: 'done' }] }] } },
  })
  assert.deepEqual(ok, { kind: 'tool_result', seq: 5, isError: false, text: 'done' })
  const failed = eventPayload({
    type: 'tool/result', seq: 6,
    data: { message: { content: [{ isError: true, content: [{ type: 'text', text: 'boom' }] }] } },
  })
  assert.equal(failed.isError, true)
})

test('eventPayload surfaces turn end reasons with detail', () => {
  assert.deepEqual(eventPayload({ type: 'turn/end', seq: 9, data: { turn: 2, reason: { kind: 'completed' } } }), {
    kind: 'turn_end', seq: 9, turn: 2, reason: 'completed', detail: null,
  })
  assert.deepEqual(eventPayload({
    type: 'turn/end', seq: 10,
    data: { turn: 3, reason: { kind: 'error', error: { message: 'nope', code: 'E1' } } },
  }), { kind: 'turn_end', seq: 10, turn: 3, reason: 'error', detail: { message: 'nope', code: 'E1' } })
  assert.deepEqual(eventPayload({
    type: 'turn/end', seq: 11,
    data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  }), { kind: 'turn_end', seq: 11, turn: 4, reason: 'aborted', detail: { cause: 'user' } })
  assert.equal(eventPayload({ type: 'turn/end', seq: 12, data: {} }).reason, 'unknown')
})

test('eventPayload relays the approval audit pair', () => {
  assert.deepEqual(eventPayload({
    type: 'approval/asked', seq: 13,
    data: { id: 'ap1', toolName: 'write_file', callId: 'c9', reason: 'writes outside the workspace' },
  }), {
    kind: 'approval_asked', seq: 13, id: 'ap1', toolName: 'write_file', callId: 'c9',
    reason: 'writes outside the workspace',
  })
  // The optional halves are absent, not empty strings: a client renders a
  // missing reason differently from a blank one.
  assert.deepEqual(eventPayload({ type: 'approval/asked', seq: 14, data: { id: 'ap2', toolName: 'bash' } }), {
    kind: 'approval_asked', seq: 14, id: 'ap2', toolName: 'bash', callId: null, reason: null,
  })
  assert.deepEqual(eventPayload({ type: 'approval/decided', seq: 15, data: { id: 'ap1', outcome: 'allowed-once' } }), {
    kind: 'approval_decided', seq: 15, id: 'ap1', outcome: 'allowed-once',
  })
  // 'unavailable' is the fail-closed outcome of a deployment with no answerer --
  // the one an API-driven session hits, so it must survive the mapping verbatim.
  assert.equal(eventPayload({ type: 'approval/decided', seq: 16, data: { id: 'ap2', outcome: 'unavailable' } }).outcome, 'unavailable')
  assert.equal(eventPayload({ type: 'approval/decided', seq: 17, data: {} }).outcome, 'unknown')
})

test('eventPayload relays approval policy switches', () => {
  assert.deepEqual(eventPayload({ type: 'approval/policy', seq: 18, data: { policy: 'never' } }), {
    kind: 'approval_policy', seq: 18, policy: 'never', source: null,
  })
  assert.deepEqual(eventPayload({ type: 'approval/policy', seq: 19, data: { policy: 'ask', source: 'delegation' } }), {
    kind: 'approval_policy', seq: 19, policy: 'ask', source: 'delegation',
  })
})

test('eventPayload ignores unknown and malformed events', () => {
  for (const input of [null, undefined, 'x', 1, { type: 'session/whatever', seq: 1 }]) {
    assert.equal(eventPayload(input), null)
  }
})

test('mapEvents preserves order and drops unmappable events', () => {
  const mapped = mapEvents([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'session/private', seq: 2 },
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'a' }] } } },
  ])
  assert.deepEqual(mapped.map((e) => e.kind), ['turn_start', 'message'])
  assert.deepEqual(mapped.map((e) => e.seq), [1, 3])
})

test('sseFrame emits a single data frame terminated by a blank line', () => {
  const frame = sseFrame({ kind: 'chunk', seq: 1, chunk: { type: 'text-delta', text: 'a\nb' } })
  assert.ok(frame.startsWith('data: '))
  assert.ok(frame.endsWith('\n\n'))
  // The payload must stay on one line: raw newlines would split the SSE frame.
  assert.equal(frame.trimEnd().split('\n').length, 1)
  assert.deepEqual(JSON.parse(frame.slice(6)), { kind: 'chunk', seq: 1, chunk: { type: 'text-delta', text: 'a\nb' } })
})
