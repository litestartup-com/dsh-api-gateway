// KB Studio BFF — knowledge-base management demo backend.
//
// Two write channels over one knowledge base:
//   1. direct file CRUD from the web UI (fast, reliable, zero tokens) — this server
//      owns the mounted KB directory;
//   2. the AI steward (facade session pinned to workspace-write) for natural-language
//      drafting/reorganizing — approvals are auto-decided here (demo policy; the
//      sandbox pin is the real scope guard) and shown in the chat for transparency.
//
// The API key never leaves this process; the browser talks only to this BFF.
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FacadeClient } from '../lib/facade-client.mjs'
import { ChatBridge } from '../lib/chat-bridge.mjs'
import { readJsonBody, safeJoin, sendJson, sendText, serveStatic, sseOpen } from '../lib/http-util.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8101)
const GW_BASE = process.env.GW_BASE ?? 'http://gateway:3080'
const GW_KEY = process.env.GW_KEY ?? ''
const KB_ROOT = process.env.KB_ROOT ?? '/kb'                    // BFF-side mount of workspaces/kb
const SEED_DIR = process.env.SEED_DIR ?? join(HERE, 'seed')      // image-side seed (AGENTS.md, welcome.md)
const SEED_DOCS = process.env.SEED_DOCS ?? '/seed-docs'          // repo docs baked into the image
const AGENT_CWD = process.env.AGENT_CWD ?? '/workspace/kb'       // gateway-side path of the same tree
const MAX_FILE_BYTES = 1_000_000
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.yaml', '.yml', '.json', '.csv'])

const log = (m) => console.log(`[kb-demo] ${m}`)

// ---- seeding (idempotent) ----

function seedVersion(file) {
  try { return /<!-- seed-version: (\d+) -->/.exec(readFileSync(file, 'utf8'))?.[1] ?? '0' } catch { return '0' }
}

function seed() {
  mkdirSync(join(KB_ROOT, 'content', 'docs'), { recursive: true })
  mkdirSync(join(KB_ROOT, 'content', 'notes'), { recursive: true })
  // Persona: rewrite when missing or the image carries a newer seed-version.
  const agentsDst = join(KB_ROOT, 'AGENTS.md')
  const agentsSrc = join(SEED_DIR, 'AGENTS.md')
  if (existsSync(agentsSrc) && (!existsSync(agentsDst) || Number(seedVersion(agentsDst)) < Number(seedVersion(agentsSrc)))) {
    writeFileSync(agentsDst, readFileSync(agentsSrc))
    log('seeded AGENTS.md')
  }
  // Welcome note: only into an empty notes area (never overwrite user content).
  const welcomeDst = join(KB_ROOT, 'content', 'notes', 'welcome.md')
  const welcomeSrc = join(SEED_DIR, 'welcome.md')
  if (existsSync(welcomeSrc) && !existsSync(welcomeDst) && readdirSync(join(KB_ROOT, 'content', 'notes')).length === 0) {
    cpSync(welcomeSrc, welcomeDst)
    log('seeded welcome note')
  }
  syncDocs()
}

/** Copy the repo docs baked into the image over content/docs/ (derived files — always overwritten). */
function syncDocs() {
  const docsDir = join(KB_ROOT, 'content', 'docs')
  mkdirSync(docsDir, { recursive: true })
  const synced = []
  if (existsSync(SEED_DOCS)) {
    for (const name of readdirSync(SEED_DOCS)) {
      const src = join(SEED_DOCS, name)
      if (!statSync(src).isFile()) continue
      // Strip a leading dot (.env.example → env.example): the tree view hides dotfiles,
      // and the KB copy is reference material, not the operative file.
      const dst = name.replace(/^\./, '')
      cpSync(src, join(docsDir, dst))
      synced.push(dst)
    }
  }
  return synced
}

// ---- facade wiring ----

const client = new FacadeClient({ base: GW_BASE, key: GW_KEY, log })
const bridge = new ChatBridge({
  client,
  cwd: AGENT_CWD,
  sandboxMode: 'workspace-write',
  // Demo policy: auto-approve everything. The real scope guard is the pinned
  // workspace-write sandbox (writes are physically confined to /workspace); every
  // auto-decision is echoed to the UI so nothing happens invisibly.
  approvalPolicy: () => 'allowed-once',
  log,
})

// ---- file helpers ----

function walk(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel))
    else if (entry.isFile()) {
      const st = statSync(join(dir, entry.name))
      out.push({ path: rel, size: st.size, mtime: st.mtimeMs })
    }
  }
  return out
}

function checkTextFile(abs) {
  const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase()
  if (!TEXT_EXT.has(ext)) throw Object.assign(new Error('only text files (.md/.txt/.yaml/.json/.csv) are allowed'), { status: 400 })
}

function resolveKbPath(rel) {
  const abs = safeJoin(KB_ROOT, rel)
  if (abs === null) throw Object.assign(new Error('path escapes the knowledge base'), { status: 400 })
  return abs
}

// ---- HTTP ----

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal')
  const route = `${req.method} ${url.pathname}`
  try {
    if (route === 'GET /api/health') {
      let facade = 'unreachable'
      try { const h = await client.health(); facade = `${h.status}/${h.upstream}` } catch { /* leave */ }
      return sendJson(res, 200, { ok: true, facade })
    }

    if (route === 'GET /api/tree') {
      return sendJson(res, 200, { root: 'kb', files: walk(KB_ROOT) })
    }

    if (route === 'GET /api/file') {
      const abs = resolveKbPath(url.searchParams.get('path') ?? '')
      checkTextFile(abs)
      const st = statSync(abs)
      if (st.size > MAX_FILE_BYTES) throw Object.assign(new Error('file too large'), { status: 413 })
      const rel = relative(KB_ROOT, abs).split('\\').join('/')
      return sendJson(res, 200, { path: rel, content: readFileSync(abs, 'utf8'), synced: rel.startsWith('content/docs/') })
    }

    if (route === 'PUT /api/file') {
      const body = await readJsonBody(req)
      const abs = resolveKbPath(body.path ?? '')
      checkTextFile(abs)
      if (abs === join(KB_ROOT, 'AGENTS.md')) throw Object.assign(new Error('AGENTS.md is managed by the demo seed'), { status: 403 })
      if (typeof body.content !== 'string' || Buffer.byteLength(body.content) > MAX_FILE_BYTES) throw Object.assign(new Error('bad content'), { status: 400 })
      if (!existsSync(abs)) throw Object.assign(new Error('no such file (use POST to create)'), { status: 404 })
      writeFileSync(abs, body.content)
      return sendJson(res, 200, { ok: true })
    }

    if (route === 'POST /api/file') {
      const body = await readJsonBody(req)
      const abs = resolveKbPath(body.path ?? '')
      checkTextFile(abs)
      if (existsSync(abs)) throw Object.assign(new Error('file already exists'), { status: 409 })
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, typeof body.content === 'string' ? body.content : '')
      return sendJson(res, 201, { ok: true })
    }

    if (route === 'DELETE /api/file') {
      const abs = resolveKbPath(url.searchParams.get('path') ?? '')
      const rel = relative(KB_ROOT, abs).split('\\').join('/')
      if (!rel.startsWith('content/')) throw Object.assign(new Error('only files under content/ can be deleted'), { status: 403 })
      if (!existsSync(abs) || !statSync(abs).isFile()) throw Object.assign(new Error('no such file'), { status: 404 })
      rmSync(abs)
      return sendJson(res, 200, { ok: true })
    }

    if (route === 'POST /api/sync') {
      const synced = syncDocs()
      return sendJson(res, 200, { ok: true, synced })
    }

    if (route === 'POST /api/chat') {
      const body = await readJsonBody(req)
      const text = String(body.text ?? '').trim()
      if (text === '' || text.length > 8000) throw Object.assign(new Error('empty or oversized prompt'), { status: 400 })
      const sid = await bridge.prompt(body.sid, text)
      return sendJson(res, 200, { sid })
    }

    if (route === 'GET /api/stream') {
      const sid = url.searchParams.get('sid') ?? ''
      // Page-refresh reattach: re-register a session this process forgot (no creation here —
      // sessions are only born from an actual chat POST).
      if (!bridge.sessions.has(sid) && !(await bridge.revalidate(sid))) return sendJson(res, 404, { error: 'unknown session' })
      const sse = sseOpen(req, res)
      const dispose = bridge.attach(sid, sse)
      res.on('close', dispose)
      return
    }

    if (route === 'POST /api/respond') {
      const body = await readJsonBody(req)
      const sid = String(body.sid ?? '')
      if (!bridge.sessions.has(sid)) return sendJson(res, 404, { error: 'unknown session' })
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
server.listen(PORT, () => log(`listening on :${PORT} (gateway ${GW_BASE}, kb ${KB_ROOT} ↔ agent ${AGENT_CWD})`))
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { bridge.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref() })
}
