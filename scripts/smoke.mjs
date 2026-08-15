/**
 * End-to-end smoke test against a RUNNING gateway deployment.
 *
 * Usage:
 *   node scripts/smoke.mjs
 *
 * Env:
 *   DSH_AGW_BASE  gateway base URL        (default http://127.0.0.1:3080/api-gw/v1)
 *   DSH_AGW_KEY   existing API key        (optional; if absent and none is
 *                                          provisioned yet, the script claims one)
 *   DSH_AGW_PROMPT prompt to send         (default: 'Reply with exactly one word: pong')
 *
 * Exit code 0 = all steps passed; non-zero = failure with a printed reason.
 */
const BASE = process.env.DSH_AGW_BASE ?? 'http://127.0.0.1:3080/api-gw/v1'
const PROMPT = process.env.DSH_AGW_PROMPT ?? 'Reply with exactly one word: pong'

const failures = []
const step = (name, ok, extra = '') => {
  if (!ok) failures.push(`${name}${extra === '' ? '' : ` (${extra})`}`)
  console.log(`${ok ? 'ok' : 'FAIL'}  ${name}`)
}

const request = async (path, init = {}) => {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body = null
  try { body = text === '' ? null : JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, body, text }
}

const run = async () => {
  // 1) health
  const health = await request('/health')
  step('GET /health', health.status === 200 && health.body?.status !== undefined)

  // 2) key (reuse or claim)
  let key = process.env.DSH_AGW_KEY ?? ''
  if (key === '') {
    const claim = await request('/key', { method: 'POST' })
    if (claim.status === 200 && claim.body?.apiKey) key = claim.body.apiKey
    step('POST /key (claim)', key !== '')
  }
  const auth = { Authorization: `Bearer ${key}` }

  // 3) create session
  const created = await request('/sessions', { method: 'POST', headers: auth, body: '{}' })
  const sessionId = created.body?.sessionId
  step('POST /sessions', created.status === 201 && typeof sessionId === 'string')

  if (sessionId === undefined) {
    console.error('\nSmoke failed:\n' + failures.map((f) => `  - ${f}`).join('\n'))
    process.exit(1)
  }

  // 4) send a message (UTF-8)
  const sent = await request(`/sessions/${sessionId}/messages`, {
    method: 'POST', headers: auth, body: JSON.stringify({ content: PROMPT }),
  })
  step('POST /sessions/:id/messages', sent.status === 202)

  // 5) poll history until a reply appears
  let reply = null
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const history = await request(`/sessions/${sessionId}/history`, { headers: auth })
    if (history.status !== 200) continue
    reply = (history.body?.events ?? []).find((event) => event.kind === 'message')
    if (reply !== undefined) break
  }
  step('reply received', reply !== null && typeof reply?.text === 'string', reply === null ? 'no reply within 240s' : '')
  if (reply !== null) console.log(`     reply.text: ${String(reply.text).slice(0, 120)}`)

  // 6) discover lists the session
  const discover = await request('/sessions/discover', { headers: auth })
  step('GET /sessions/discover', discover.status === 200 && Array.isArray(discover.body?.sessions))

  if (failures.length > 0) {
    console.error('\nSmoke failed:\n' + failures.map((f) => `  - ${f}`).join('\n'))
    process.exit(1)
  }
  console.log('\nSmoke passed.')
}

run().catch((error) => {
  console.error('Smoke crashed: ' + String(error?.stack ?? error))
  process.exit(1)
})
