// conformance/conformance.mjs — cross-implementation conformance suite for the
// frozen apiproxy contract.
//
// One suite, any facade: ohdsh-api-facade (DSH runtime) and pi-api-facade (Pi
// runtime) both answer these assertions — that is the whole point of the frozen
// contract. Zero dependencies (probe-lib carries its own minimal WebSocket
// client); Node >= 20.
//
// Usage:
//   SMOKE_BASE=http://127.0.0.1:<port> SMOKE_KEY=<key> node conformance/conformance.mjs
//   flags/env:
//     --cwd <path>      host-side cwd for session.create (default: CONFORMANCE_CWD
//                       or /workspace/conformance — must exist on the node and be
//                       writable by it when --prompt runs)
//     --prompt          (or RUN_PROMPT=1) additionally run one real turn: needs
//                       provider credentials on a real engine; free against the
//                       pi facade's fake engine
//
// The assertions are deliberately the INTERSECTION of what both implementations
// guarantee (implementation-specific extras belong to each repo's own suite):
// envelopes, auth/whitelist carrier codes, health, host.describe, catalog shape,
// session lifecycle, sandbox-mode semantics, respond/pending receipts, mux
// envelope invariants and downstream-only rule, and — with --prompt — the billing
// invariant (usage with DSH field names on assistant/message, cost never on wire).
import {
  BASE, KEY, PREFIX, argVal, cfg, fail, hasFlag, history, log, muxUrl, passed,
  post, requireKey, rpc, step, typeOf, evOf, waitTurnEnd, wsOpen,
} from '../docker/probe-lib.mjs'

process.env.PROBE_TAG ||= 'conformance'

const CWD = argVal('--cwd') || cfg('CONFORMANCE_CWD') || '/workspace/conformance'
const RUN_PROMPT = hasFlag('--prompt') || process.env.RUN_PROMPT === '1'

log(`base=${BASE} key=${KEY ? KEY.slice(0, 8) + '…' : '(none)'} cwd=${CWD} prompt=${RUN_PROMPT}`)
requireKey()

let sessionId = ''

await step('health is open (no auth) and reports status ok', async () => {
  const res = await fetch(BASE + PREFIX + '/health', { signal: AbortSignal.timeout(10_000) })
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (body === null || typeof body !== 'object') throw new Error('health body is not an object')
  if (body.status !== undefined && body.status !== 'ok') throw new Error(`status=${body.status}`)
})

await step('missing key is 401', async () => {
  // Note: the 401 BODY is deliberately not asserted. This facade's provisioning
  // flow advertises itself in the 401 ("POST /key provisions a key…"), while
  // pi-api-facade (provisioning disabled) must never carry that string — the
  // manager retries provisioning on it. That hardening is asserted in the pi
  // repo's own suite, not here.
  const res = await post(PREFIX + '/proxy/session.list', { type: 'client-request', rpcId: 'conf-1', method: 'session.list', payload: {} })
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`)
})

await step('wrong key is 401', async () => {
  const res = await post(PREFIX + '/proxy/session.list', { type: 'client-request', rpcId: 'conf-2', method: 'session.list', payload: {} }, { 'x-api-key': 'wrong-key-conformance' })
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`)
})

await step('whitelist is fail-closed (credentials.set -> 403 method_not_allowed)', async () => {
  const res = await post(PREFIX + '/proxy/credentials.set', { type: 'client-request', rpcId: 'conf-3', method: 'credentials.set', payload: {} }, { 'x-api-key': KEY })
  if (res.status !== 403) throw new Error(`expected 403, got ${res.status}`)
  if (!res.text.includes('method_not_allowed')) throw new Error(`expected method_not_allowed, got ${res.text.slice(0, 160)}`)
})

await step('malformed envelope is a carrier-level error (non-200)', async () => {
  const res = await post(PREFIX + '/proxy/session.list', { type: 'nonsense' }, { 'x-api-key': KEY })
  if (res.status === 200) throw new Error('malformed envelope must not answer 200')
})

await step('envelope/path method mismatch is rejected (400)', async () => {
  const res = await post(PREFIX + '/proxy/session.list', { type: 'client-request', rpcId: 'conf-4', method: 'session.create', payload: {} }, { 'x-api-key': KEY })
  if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`)
})

await step('host.describe: version string + optional allowFullAccess boolean', async () => {
  const value = await rpc('host.describe', {})
  if (typeof value?.version !== 'string' || value.version === '') throw new Error(`version missing: ${JSON.stringify(value).slice(0, 160)}`)
  // allowFullAccess is informational: the contract lets hosts omit it (absent =
  // the danger tier is simply not offerable), so only its TYPE is invariant.
  if (value?.allowFullAccess !== undefined && typeof value.allowFullAccess !== 'boolean') {
    throw new Error(`allowFullAccess not boolean: ${JSON.stringify(value).slice(0, 160)}`)
  }
  log(`host.describe: version=${value.version} allowFullAccess=${value.allowFullAccess ?? '(absent)'}`)
})

await step('session.models returns a catalog envelope', async () => {
  const value = await rpc('session.models', {})
  if (!Array.isArray(value?.groups)) throw new Error(`groups missing: ${JSON.stringify(value).slice(0, 160)}`)
})

await step('session.create pins a session to the given cwd', async () => {
  const value = await rpc('session.create', { cwd: CWD })
  if (typeof value?.sessionId !== 'string' || value.sessionId === '') throw new Error(`no sessionId: ${JSON.stringify(value).slice(0, 160)}`)
  sessionId = value.sessionId
  log(`created session ${sessionId}`)
})

await step('sandbox-mode: live pin ok, unknown session 409, bad mode non-200', async () => {
  const pin = await fetch(`${BASE}${PREFIX}/sessions/${encodeURIComponent(sessionId)}/sandbox-mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ mode: 'workspace-write' }),
    signal: AbortSignal.timeout(10_000),
  })
  if (pin.status !== 200) throw new Error(`live pin: HTTP ${pin.status}`)
  const unknown = await fetch(`${BASE}${PREFIX}/sessions/definitely-not-a-session/sandbox-mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ mode: 'read-only' }),
    signal: AbortSignal.timeout(10_000),
  })
  if (unknown.status !== 409) throw new Error(`unknown session: expected 409, got ${unknown.status}`)
  const bad = await fetch(`${BASE}${PREFIX}/sessions/${encodeURIComponent(sessionId)}/sandbox-mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ mode: 'yolo' }),
    signal: AbortSignal.timeout(10_000),
  })
  if (bad.status === 200) throw new Error('bad mode must not answer 200')
})

await step('session.list returns the paged envelope', async () => {
  const value = await rpc('session.list', {})
  const items = Array.isArray(value) ? value : value?.items
  if (!Array.isArray(items)) throw new Error(`unexpected shape: ${JSON.stringify(value).slice(0, 160)}`)
  // Containment of a FRESH session is runtime-dependent and asserted in the
  // prompt round instead: DSH persists on create, while Pi writes the session
  // file only once it contains a user/assistant message (upstream design,
  // session-manager.ts _persist). Both must list a session that has run.
  log(`session.list: ${items.length} session(s)`)
})

await step('session.history is structurally sound', async () => {
  const value = await rpc('session.history', { sessionId })
  if (!Array.isArray(value?.events)) throw new Error('events missing')
  if (typeof value?.hasMore !== 'boolean') throw new Error('hasMore missing')
  // projections may be absent or null on a fresh session (host-dependent);
  // when present as an object it must carry a values object.
  if (value?.projections !== undefined && value?.projections !== null) {
    if (typeof value.projections !== 'object') throw new Error('projections must be an object or null')
    if (value.projections.values !== undefined && typeof value.projections.values !== 'object') throw new Error('projections.values must be an object')
  }
})

await step('answerer/pending answers with a pending array', async () => {
  const res = await fetch(`${BASE}${PREFIX}/answerer/pending`, { headers: { 'x-api-key': KEY }, signal: AbortSignal.timeout(10_000) })
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (!Array.isArray(body?.pending)) throw new Error('pending array missing')
})

await step('respond for an unknown rpcId is not-pending', async () => {
  const res = await post(PREFIX + '/respond', {
    type: 'client-response',
    rpcId: 'conformance-never-minted',
    result: { ok: true, value: { sessionId, approvalId: 'x', outcome: 'rejected' } },
  }, { 'x-api-key': KEY })
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  if (res.json?.accepted !== false || res.json?.reason !== 'not-pending') throw new Error(`receipt: ${res.text.slice(0, 160)}`)
})

await step('mux refuses a wrong key before the upgrade', async () => {
  try {
    const conn = await wsOpen(muxUrl(), { 'x-api-key': 'wrong-key-conformance' })
    conn.close()
    throw new Error('upgrade succeeded with a wrong key')
  } catch (e) {
    if (e.message === 'upgrade succeeded with a wrong key') throw e
    if (e.statusCode !== undefined && e.statusCode !== 401) throw new Error(`expected a 401 refusal, got HTTP ${e.statusCode}`)
  }
})

await step('mux is downstream-only: an uplink data frame closes with 1008', async () => {
  try {
    const conn = await wsOpen(muxUrl(), { 'x-api-key': KEY })
    conn.sendText('{"type":"client-request"}')
    const code = await conn.closePromise
    if (code !== 1008) throw new Error(`expected close code 1008, got ${code}`)
  } catch (e) {
    if (process.env.CONFORMANCE_DEBUG) console.error('DEBUG mux-1008 stack:', e?.stack ?? e)
    throw e
  }
})

await step('whitelisted-but-unimplemented methods answer with well-formed envelopes', async () => {
  const res = await post(PREFIX + '/proxy/session.rename', { type: 'client-request', rpcId: 'conf-rename', method: 'session.rename', payload: { sessionId, title: 'conformance' } }, { 'x-api-key': KEY })
  if (res.status !== 200) throw new Error(`expected business-level 200, got ${res.status}`)
  const env = res.json
  if (env?.type !== 'server-response' || !env.result) throw new Error('malformed server-response')
  if (env.result.ok !== true && env.result.ok !== false) throw new Error('result.ok missing')
  if (env.result.ok === false && typeof env.result.error?.code !== 'string') throw new Error('error without code')
  log(`session.rename: ${env.result.ok ? 'implemented' : `honest ${env.result.error.code}`}`)
})

if (RUN_PROMPT) {
  await step('prompt round: mux envelope invariants, turn/end, and the billing invariant', async () => {
    const conn = await wsOpen(muxUrl(), { 'x-api-key': KEY })
    try {
      const receipt = await rpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'Reply with exactly: CONFORMANCE-OK' }],
      })
      if (receipt?.accepted !== true) throw new Error(`prompt not accepted: ${JSON.stringify(receipt).slice(0, 160)}`)
      const { events } = await waitTurnEnd(sessionId, { timeoutMs: 240_000, pollMs: 1_000 })

      // Mux envelope invariants (everything that arrived during the round).
      const parsed = conn.frames
        .filter((f) => f.kind === 'text')
        .map((f) => { try { return JSON.parse(f.data) } catch { return null } })
        .filter(Boolean)
      if (parsed.length === 0) throw new Error('no mux frames arrived during the round')
      let sawSessionEvent = false
      for (const env of parsed) {
        if (env.type !== 'server-request' || typeof env.method !== 'string') throw new Error(`bad envelope: ${JSON.stringify(env).slice(0, 160)}`)
        if (!env.payload || env.payload.type !== env.method) throw new Error(`envelope method must equal payload.type: ${JSON.stringify(env).slice(0, 160)}`)
        if (env.payload.type === 'session/event' && env.payload.sessionId === sessionId) sawSessionEvent = true
      }
      if (!sawSessionEvent) throw new Error('no session/event frames for this session on the mux')

      // History + billing invariants.
      const types = events.map(typeOf)
      for (const t of ['user/message', 'assistant/message', 'turn/end']) {
        if (!types.includes(t)) throw new Error(`history missing ${t} (got ${types.join(',')})`)
      }
      const assistant = events.map(evOf).find((e) => e.type === 'assistant/message' && e.data?.usage)
      const usage = assistant?.data?.usage
      if (!usage || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') {
        throw new Error('assistant/message must carry usage with the DSH field names (inputTokens/outputTokens)')
      }
      if ('cost' in usage) throw new Error('cost must never ride the wire — the manager prices runs itself')
      log(`billing invariant ok: inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens}`)

      // A session that has run MUST be listable (persistence-independent point:
      // both runtimes have flushed by the time a turn ended).
      const listed = await rpc('session.list', {})
      const items = Array.isArray(listed) ? listed : listed?.items
      if (!Array.isArray(items) || !items.some((i) => i?.sessionId === sessionId)) throw new Error('the run session is missing from session.list')
    } finally {
      conn.close()
    }
  })
}

log(`conformance PASS (${passed()} checks, prompt=${RUN_PROMPT})`)
