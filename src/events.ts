/**
 * dsh-api-gateway — session event mapping (pure).
 *
 * Maps DeepSeek Harness session-log events onto the gateway's flat wire
 * events. Leaf-field reads only: live agent/session objects are never
 * serialized. Kept free of Cordis and Node surfaces so it is directly
 * unit-testable (see test/events.test.mjs).
 */

export type GatewayEvent = { kind: string; seq: number; [key: string]: unknown }

/**
 * Token accounting for one assistant step, as the harness reports it on
 * `assistant/message`. Counts are DISJOINT: `inputTokens` excludes cached
 * input, which `cacheReadTokens` / `cacheWriteTokens` report separately.
 */
export interface TokenUsageJson {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

const OPTIONAL_USAGE_KEYS = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/** Copy the known counters as plain finite numbers; `null` when the adapter reported no accounting. */
export const normalizeUsage = (usage: unknown): TokenUsageJson | null => {
  if (usage === null || typeof usage !== 'object') return null
  const source = usage as Record<string, unknown>
  const count = (key: string): number | undefined => {
    const value = source[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const inputTokens = count('inputTokens')
  const outputTokens = count('outputTokens')
  if (inputTokens === undefined && outputTokens === undefined) return null
  const out: TokenUsageJson = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
  for (const key of OPTIONAL_USAGE_KEYS) {
    const value = count(key)
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Accumulate step usage into a turn total. Absent counters stay absent unless one side reports them. */
export const sumUsage = (total: TokenUsageJson | null, step: TokenUsageJson | null): TokenUsageJson | null => {
  if (step === null) return total
  if (total === null) return { ...step }
  const out: TokenUsageJson = {
    inputTokens: total.inputTokens + step.inputTokens,
    outputTokens: total.outputTokens + step.outputTokens,
  }
  for (const key of OPTIONAL_USAGE_KEYS) {
    if (total[key] === undefined && step[key] === undefined) continue
    out[key] = (total[key] ?? 0) + (step[key] ?? 0)
  }
  return out
}

/** Visible text and thinking content are split, never concatenated. */
export const extractBlocks = (content: unknown): { text: string; reasoning: string } => {
  let text = ''
  let reasoning = ''
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block !== null && typeof block === 'object') {
        if ((block as any).type === 'text') text += String((block as any).text)
        else if ((block as any).type === 'reasoning') reasoning += String((block as any).text)
      }
    }
  }
  return { text, reasoning }
}

export const chunkJson = (chunk: unknown): Record<string, unknown> | null => {
  if (chunk === null || typeof chunk !== 'object') return null
  const c = chunk as any
  switch (c.type) {
    case 'text-delta': return { type: 'text-delta', text: String(c.text) }
    case 'reasoning-delta': return { type: 'reasoning-delta', text: String(c.text) }
    case 'tool-call-delta': return { type: 'tool-call-delta', id: c.id == null ? null : String(c.id), name: c.name == null ? null : String(c.name), argumentsDelta: String(c.argumentsDelta ?? '') }
    case 'usage': return { type: 'usage', usage: normalizeUsage(c.usage) }
    case 'finish': return { type: 'finish', reason: c.reason?.kind ? String(c.reason.kind) : 'unknown' }
    default: return null
  }
}

export const eventPayload = (event: unknown): GatewayEvent | null => {
  if (event === null || typeof event !== 'object') return null
  const e = event as any
  const data = e.data ?? null
  switch (e.type) {
    case 'user/message':
      return { kind: 'user', seq: e.seq, messageId: data?.id ? String(data.id) : null, text: extractBlocks(data?.content).text }
    case 'assistant/chunk': {
      const c = chunkJson(data?.chunk)
      if (c === null) return null
      return { kind: 'chunk', seq: e.seq, chunk: c }
    }
    case 'assistant/message': {
      const parts = extractBlocks(data?.message?.content)
      return { kind: 'message', seq: e.seq, text: parts.text, reasoning: parts.reasoning !== '' ? parts.reasoning : null, usage: normalizeUsage(data?.usage) }
    }
    case 'tool/call':
      return { kind: 'tool_call', seq: e.seq, name: data ? String(data.name) : '', arguments: data ? String(data.arguments) : '' }
    case 'tool/result': {
      const message = data?.message
      const block = message && Array.isArray(message.content) ? message.content[0] : null
      return {
        kind: 'tool_result',
        seq: e.seq,
        isError: Boolean(data && (data.error || (block && block.isError))),
        text: block?.content ? extractBlocks(block.content).text : '',
      }
    }
    case 'turn/start':
      return { kind: 'turn_start', seq: e.seq, turn: data?.turn ?? null }
    case 'turn/end': {
      const reason = data?.reason ?? null
      let detail = null
      if (reason?.kind === 'error' && reason.error) detail = { message: String(reason.error.message ?? ''), code: String(reason.error.code ?? '') }
      if (reason?.kind === 'aborted' && reason.reason) detail = { cause: String(reason.reason.kind ?? '') }
      return { kind: 'turn_end', seq: e.seq, turn: data?.turn ?? null, reason: reason ? String(reason.kind) : 'unknown', detail }
    }
    default:
      return null
  }
}

/** Map a whole persisted event array, dropping events with no wire form. */
export const mapEvents = (events: readonly unknown[]): GatewayEvent[] => {
  const out: GatewayEvent[] = []
  for (const event of events) {
    const payload = eventPayload(event)
    if (payload !== null) out.push(payload)
  }
  return out
}

export const sseFrame = (payload: GatewayEvent): string => 'data: ' + JSON.stringify(payload) + '\n\n'
