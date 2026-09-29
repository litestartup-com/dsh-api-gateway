// docker/smoke.mjs — acceptance smoke for the standalone API stack (nginx + gateway).
//
// Zero dependencies by design: it must run from a bare checkout on any host with
// Node >= 20 (the mux WebSocket check uses a minimal built-in client, so the
// nginx upgrade path is verified even where the `ws` package is not installed).
//
// Usage:
//   node docker/smoke.mjs                       # wiring checks (defaults from .env)
//   node docker/smoke.mjs --model               # + one real model turn (needs DEEPSEEK_API_KEY)
//   node docker/smoke.mjs --base http://host:port --key apigw-xxx
//   node docker/smoke.mjs --skip-front          # when pointed directly at the gateway
//                                               # port instead of the nginx front door
//
// Checks (wiring): health open + upstream ok -> front door fail-closed (GET / = 404)
//   -> wrong key 401 -> whitelist 403 (credentials.set) -> host.describe envelope
//   -> session.list -> mux upgrade (auth accepted / wrong key refused / uplink frame
//   closes with 1008).
// Checks (--model): session.create under /workspace -> session.prompt -> poll
//   session.history until turn/end (assistant/message present).
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- config ----------------------------------------------------------------
const argv = process.argv.slice(2)
const argVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const hasFlag = (name) => argv.includes(name)

function readDotEnv() {
  const out = {}
  const p = join(REPO_ROOT, '.env')
  if (!existsSync(p)) return out
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}
const dotenv = readDotEnv()
const cfg = (k) => process.env[k] || dotenv[k] || ''

const BASE = (argVal('--base') || process.env.SMOKE_BASE || `http://127.0.0.1:${cfg('HTTP_PORT') || '80'}`).replace(/\/+$/, '')
const KEY = argVal('--key') || process.env.SMOKE_KEY || cfg('GW_KEY') || ''
const MODEL = hasFlag('--model')
const SKIP_FRONT = hasFlag('--skip-front')
const PREFIX = '/api-gw/v1'

let checks = 0
const log = (msg) => console.log('[smoke] ' + msg)
const fail = (msg) => { console.error('[smoke] FAIL: ' + msg); process.exit(1) }
async function step(name, fn) {
  log('-- ' + name)
  try { await fn(); checks++ } catch (e) { fail(name + ': ' + (e && e.message ? e.message : String(e))) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- unary RPC (frozen apiproxy envelope; HTTP is always 200, success = result.ok) ----
let rpcSeq = 0
async function post(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let json = null
  try { json = text === '' ? null : JSON.parse(text) } catch { /* keep raw text */ }
  return { status: res.status, json, text }
}
async function rpc(method, payload, key = KEY) {
  const rpcId = `smoke-${Date.now()}-${++rpcSeq}`
  const res = await post(`${PREFIX}/proxy/${method}`, { type: 'client-request', rpcId, method, payload }, { 'x-api-key': key })
  if (res.status !== 200) throw new Error(`${method}: HTTP ${res.status} — ${res.text.slice(0, 200)}`)
  const env = res.json
  if (!env || env.type !== 'server-response' || !env.result) throw new Error(`${method}: malformed server-response: ${res.text.slice(0, 200)}`)
  if (!env.result.ok) throw new Error(`${method}: ${env.result.error?.code} — ${env.result.error?.message}`)
  return env.result.value
}

// ---- minimal WebSocket client (RFC 6455 subset: text/binary/close/ping/pong, client masking) ----
function encodeFrame(opcode, payload) {
  const len = payload.length
  const mask = randomBytes(4)
  let header
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2) }
  header[0] = 0x80 | opcode // FIN + opcode
  const masked = Buffer.alloc(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([header, mask, masked])
}

function wsOpen(wsUrl, headers = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl)
    const key = Buffer.from(randomBytes(16)).toString('base64')
    const req = httpRequest({
      host: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
        ...headers,
      },
      timeout: timeoutMs,
    })
    let settled = false
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }
    req.on('error', (e) => done(reject, e))
    req.on('timeout', () => { req.destroy(new Error('ws handshake timeout')) })
    // The facade refuses a bad key with a plain HTTP status BEFORE the upgrade.
    req.on('response', (res) => {
      const e = new Error(`ws upgrade refused: HTTP ${res.statusCode}`)
      e.statusCode = res.statusCode
      res.resume()
      done(reject, e)
    })
    req.on('upgrade', (_res, socket) => {
      const conn = new WsConn(socket)
      socket.on('error', () => conn._onClose(1006))
      done(resolve, conn)
    })
    req.end()
  })
}

class WsConn {
  constructor(socket) {
    this.socket = socket
    this.buf = Buffer.alloc(0)
    this.frag = []
    this.frames = []
    this.frameWaiters = []
    this.closed = null
    this.closePromise = new Promise((r) => { this.closed = r })
    socket.on('data', (chunk) => { this.buf = Buffer.concat([this.buf, chunk]); this._parse() })
    socket.on('close', () => this._onClose(1006))
  }
  _onClose(code) { if (this.closed) { const r = this.closed; this.closed = null; r(code) } }
  _emit(frame) {
    this.frames.push(frame)
    const left = []
    for (const w of this.frameWaiters) {
      if (w.pred(frame)) w.resolve(frame)
      else left.push(w)
    }
    this.frameWaiters = left
  }
  _parse() {
    for (;;) {
      if (this.buf.length < 2) return
      const b0 = this.buf[0]; const b1 = this.buf[1]
      const fin = (b0 & 0x80) !== 0; const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0; const len7 = b1 & 0x7f
      let off = 2; let len = len7
      if (len7 === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4 }
      else if (len7 === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10 }
      let maskKey = null
      if (masked) { if (this.buf.length < off + 4) return; maskKey = this.buf.subarray(off, off + 4); off += 4 }
      if (this.buf.length < off + len) return
      let payload = this.buf.subarray(off, off + len)
      if (masked) {
        const p = Buffer.alloc(len)
        for (let i = 0; i < len; i++) p[i] = payload[i] ^ maskKey[i & 3]
        payload = p
      }
      this.buf = this.buf.subarray(off + len)
      if (opcode === 0x0) { this.frag.push(payload); if (fin) { this._emit({ kind: 'text', data: Buffer.concat(this.frag).toString('utf8') }); this.frag = [] } }
      else if (opcode === 0x1 || opcode === 0x2) {
        if (fin) this._emit({ kind: opcode === 0x1 ? 'text' : 'binary', data: payload.toString('utf8') })
        else { this.frag = [payload] }
      }
      else if (opcode === 0x8) {
        const code = len >= 2 ? payload.readUInt16BE(0) : 1005
        try { this.socket.end(encodeFrame(0x8, payload.subarray(0, Math.min(len, 2)))) } catch { /* best effort echo */ }
        this._onClose(code)
        return
      }
      else if (opcode === 0x9) { try { this.socket.write(encodeFrame(0xa, payload)) } catch { /* socket gone */ } }
      // 0xa (pong): ignored
    }
  }
  sendText(text) { this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8'))) }
  waitFrame(pred, timeoutMs = 10_000) {
    const hit = this.frames.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ws frame wait timed out (${timeoutMs}ms)`)), timeoutMs)
      this.frameWaiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f) } })
      // A close also ends the wait.
      this.closePromise.then(() => { clearTimeout(timer); reject(new Error('ws closed before the expected frame')) })
    })
  }
  close() { try { this.socket.destroy() } catch { /* already gone */ } }
}

// ---- run --------------------------------------------------------------------
log(`base=${BASE} key=${KEY ? KEY.slice(0, 10) + '…' : '(none)'} model=${MODEL} front=${!SKIP_FRONT}`)
if (!KEY) fail('no API key: set GW_KEY in .env or pass --key (a keyless stack only supports the one-time POST /key bootstrap)')

await step('health is open and upstream is ok', async () => {
  const res = await fetch(BASE + PREFIX + '/health', { signal: AbortSignal.timeout(10_000) })
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (body.status !== 'ok') throw new Error(`status=${body.status}`)
  if (body.upstream !== 'ok') throw new Error(`upstream=${body.upstream} (facade cannot reach host services)`)
  if (body.apiKeySet !== true) throw new Error('apiKeySet=false — GW_KEY did not reach settings.yaml')
  log(`health: status=${body.status} upstream=${body.upstream} dshVersion=${body.dshVersion ?? '?'} apiKeySet=${body.apiKeySet}`)
})

if (!SKIP_FRONT) {
  await step('front door is fail-closed (GET / = 404)', async () => {
    const res = await fetch(BASE + '/', { signal: AbortSignal.timeout(10_000) })
    if (res.status !== 404) throw new Error(`GET / should be 404 through nginx, got ${res.status}`)
    log('GET / -> 404 (only /api-gw/ is proxied)')
  })
}

await step('wrong key is 401', async () => {
  const res = await post(PREFIX + '/proxy/session.list', { type: 'client-request', rpcId: 'smoke-neg', method: 'session.list', payload: {} }, { 'x-api-key': 'wrong-key-smoke' })
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`)
  log('session.list with a wrong key -> 401')
})

await step('whitelist is fail-closed (credentials.set = 403)', async () => {
  // Auth runs BEFORE the whitelist, so this must carry the valid key to reach the 403.
  const res = await post(PREFIX + '/proxy/credentials.set', { type: 'client-request', rpcId: 'smoke-neg2', method: 'credentials.set', payload: {} }, { 'x-api-key': KEY })
  if (res.status !== 403) throw new Error(`expected 403, got ${res.status}`)
  if (!res.text.includes('method_not_allowed')) throw new Error(`expected method_not_allowed, got: ${res.text.slice(0, 200)}`)
  log('credentials.set with the valid key -> 403 method_not_allowed')
})

await step('host.describe returns the envelope with a version', async () => {
  const value = await rpc('host.describe', {})
  if (!value || typeof value.version !== 'string' || value.version === '') throw new Error(`no version in value: ${JSON.stringify(value).slice(0, 200)}`)
  log(`host.describe: version=${value.version}${value.dshVersion ? ' dshVersion=' + value.dshVersion : ''}`)
})

await step('session.list works', async () => {
  const value = await rpc('session.list', {})
  // The facade answers with a paged envelope: { items: [...] }.
  const list = Array.isArray(value) ? value : value?.items ?? value?.sessions
  if (!Array.isArray(list)) throw new Error(`unexpected value shape: ${JSON.stringify(value).slice(0, 200)}`)
  log(`session.list: ${list.length} session(s)`)
})

await step('mux upgrade through nginx (auth / refuse / downlink-only)', async () => {
  const wsBase = BASE.replace(/^http/, 'ws')
  // 1) a wrong key is refused before the upgrade
  try {
    const bad = await wsOpen(wsBase + PREFIX + '/proxy/events.mux', { 'X-API-Key': 'wrong-key-smoke' })
    bad.close()
    throw new Error('wrong key was NOT refused')
  } catch (e) {
    if (e.statusCode !== 401) throw new Error(`expected HTTP 401 refusal, got: ${e.message}`)
    log('wrong key upgrade -> HTTP 401 (refused before negotiation)')
  }
  // 2) the valid key upgrades, and any uplink frame closes the socket with 1008
  const conn = await wsOpen(wsBase + PREFIX + '/proxy/events.mux', { 'X-API-Key': KEY })
  log('mux upgraded (proxy/events.mux path)')
  conn.sendText('{"smoke":"uplink frames are forbidden"}')
  const code = await conn.closePromise
  if (code !== 1008) throw new Error(`expected close code 1008 (downlink only), got ${code}`)
  log('uplink frame -> close 1008 (downlink-only pipe enforced)')
  // 3) the canonical events.mux path upgrades too
  const conn2 = await wsOpen(wsBase + PREFIX + '/events.mux', { 'X-API-Key': KEY })
  log('mux upgraded (events.mux path)')
  conn2.close()
})

if (MODEL) {
  await step('real model turn: create -> prompt -> turn_end', async () => {
    const name = `smoke-${Date.now()}`
    // Best effort: when the smoke runs ON the compose host this pre-creates the bind-mounted
    // dir; when it runs against a remote base the node container mkdirs the cwd itself
    // (session.create creates a missing cwd inside the writable /workspace mount).
    try { mkdirSync(join(REPO_ROOT, 'workspaces', name), { recursive: true }) } catch { /* remote host */ }
    const created = await rpc('session.create', { cwd: `/workspace/${name}` })
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error(`no sessionId in create value: ${JSON.stringify(created).slice(0, 200)}`)
    log(`session created: ${sessionId} (cwd=/workspace/${name})`)
    const prompted = await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'Reply with exactly one word: ok' }] })
    if (prompted?.accepted === false) throw new Error(`prompt not accepted: ${JSON.stringify(prompted).slice(0, 200)}`)
    log('prompt queued; polling history for turn/end (timeout 180s)...')
    const deadline = Date.now() + 180_000
    // History entries wrap the raw session-log event: { event: { type: 'turn/end', data } }
    // (slash-form types; the underscore 'kind' vocabulary belongs to the mux translation).
    const evOf = (e) => (e && e.event) || e
    const typeOf = (e) => evOf(e)?.type
    let sawMessage = false
    let turnEnd = null
    let lastEvents = []
    while (Date.now() < deadline && !turnEnd) {
      await sleep(3000)
      const hist = await rpc('session.history', { sessionId })
      const events = Array.isArray(hist?.events) ? hist.events : []
      lastEvents = events
      sawMessage = sawMessage || events.some((e) => typeOf(e) === 'assistant/message')
      turnEnd = events.find((e) => typeOf(e) === 'turn/end' || typeOf(e) === 'turn_end') ?? null
    }
    if (!turnEnd) throw new Error('no turn/end within 180s')
    if (!sawMessage) throw new Error('turn ended without any assistant/message event')
    const reply = lastEvents.map(evOf).find((ev) => ev?.type === 'assistant/message')
    log(`turn/end: reason=${evOf(turnEnd)?.data?.reason?.kind ?? '?'}; assistant reply: ${JSON.stringify(reply?.data?.message?.content ?? null).slice(0, 120)}`)
  })
}

log(`ALL GREEN (${checks} checks${MODEL ? ', incl. real model turn' : ', wiring only — add --model for a real turn'})`)
