// Support widget BFF — read-only customer-service demo backend.
//
// Visitors chat with a support agent whose persona comes from AGENTS.md in its
// workspace (/workspace/cs) and whose knowledge base is the shared KB tree
// (/workspace/kb/content). The session is pinned to the read-only sandbox right
// after creation, so the agent physically cannot modify anything — and any
// approval request that still shows up is auto-rejected (defense in depth).
// Agent questions (clarifications) are surfaced to the visitor as chat cards.
//
// The API key never leaves this process; the browser talks only to this BFF.
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FacadeClient } from '../lib/facade-client.mjs'
import { ChatBridge } from '../lib/chat-bridge.mjs'
import { readJsonBody, sendJson, sendText, serveStatic, sseOpen } from '../lib/http-util.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8102)
const GW_BASE = process.env.GW_BASE ?? 'http://gateway:3080'
const GW_KEY = process.env.GW_KEY ?? ''
const CS_ROOT = process.env.CS_ROOT ?? '/cs'                     // BFF-side mount of workspaces/cs
const SEED_DIR = process.env.SEED_DIR ?? join(HERE, 'seed')      // image-side seed (AGENTS.md)
const AGENT_CWD = process.env.AGENT_CWD ?? '/workspace/cs'       // gateway-side path of the same tree

const log = (m) => console.log(`[cs-demo] ${m}`)

// Persona seed (idempotent): rewrite when missing or the image carries a newer seed-version.
function seedVersion(file) {
  try { return /<!-- seed-version: (\d+) -->/.exec(readFileSync(file, 'utf8'))?.[1] ?? '0' } catch { return '0' }
}
function seed() {
  mkdirSync(CS_ROOT, { recursive: true })
  const dst = join(CS_ROOT, 'AGENTS.md')
  const src = join(SEED_DIR, 'AGENTS.md')
  if (existsSync(src) && (!existsSync(dst) || Number(seedVersion(dst)) < Number(seedVersion(src)))) {
    writeFileSync(dst, readFileSync(src))
    log('seeded AGENTS.md')
  }
}

const client = new FacadeClient({ base: GW_BASE, key: GW_KEY, log })
const bridge = new ChatBridge({
  client,
  cwd: AGENT_CWD,
  sandboxMode: 'read-only',
  // Defense in depth: read-only sandbox already blocks mutations; reject any approval anyway.
  approvalPolicy: () => 'rejected',
  log,
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal')
  const route = `${req.method} ${url.pathname}`
  try {
    if (route === 'GET /api/health') {
      let facade = 'unreachable'
      try { const h = await client.health(); facade = `${h.status}/${h.upstream}` } catch { /* leave */ }
      return sendJson(res, 200, { ok: true, facade })
    }

    if (route === 'POST /api/chat') {
      const body = await readJsonBody(req)
      const text = String(body.text ?? '').trim()
      if (text === '' || text.length > 4000) throw Object.assign(new Error('empty or oversized message'), { status: 400 })
      const sid = await bridge.prompt(body.sid, text)
      return sendJson(res, 200, { sid })
    }

    if (route === 'GET /api/stream') {
      const sid = url.searchParams.get('sid') ?? ''
      if (!bridge.sessions.has(sid) && !(await bridge.revalidate(sid))) return sendJson(res, 404, { error: 'unknown session' })
      const sse = sseOpen(req, res)
      const dispose = bridge.attach(sid, sse)
      res.on('close', dispose)
      return
    }

    if (route === 'POST /api/respond') {
      const body = await readJsonBody(req)
      const sid = String(body.sid ?? '')
      if (!bridge.sessions.has(sid) && !(await bridge.revalidate(sid))) return sendJson(res, 404, { error: 'unknown session' })
      const receipt = body.decline === true
        ? await bridge.declineQuestion(sid, body.rpcId)
        : await bridge.respondQuestion(sid, body.rpcId, Array.isArray(body.answers) ? body.answers : [])
      return sendJson(res, 200, receipt)
    }

    if (route === 'GET /api/history') {
      const sid = url.searchParams.get('sid') ?? ''
      if (!(await bridge.revalidate(sid))) return sendJson(res, 404, { error: 'unknown session' })
      return sendJson(res, 200, { messages: await bridge.transcript(sid) })
    }

    if (req.method === 'GET') return serveStatic(join(HERE, 'public'), url.pathname, res)
    return sendText(res, 405, 'method not allowed')
  } catch (e) {
    const status = Number(e?.status) || 500
    if (status === 500) log(`error on ${route}: ${e?.stack ?? e}`)
    return sendJson(res, status, { error: String(e?.message ?? e) })
  }
})

seed()
bridge.start()
server.listen(PORT, () => log(`listening on :${PORT} (gateway ${GW_BASE}, workspace ${CS_ROOT} ↔ agent ${AGENT_CWD})`))
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { bridge.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref() })
}
