// docker/probe-lib.mjs — shared machinery for the zero-dependency stack probes
// (smoke.mjs, probe-cards.mjs). Node >= 20 only: fetch + a minimal raw WebSocket
// client (RFC 6455 subset), so the nginx upgrade path and the mux contract are
// verified even where the `ws` package is not installed.
//
// Config resolution (highest wins): --base/--key flags, SMOKE_BASE/SMOKE_KEY env,
// repo .env (HTTP_PORT/GW_KEY).
import { randomBytes } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const isMain = (metaUrl) => process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href

// ---- config ----------------------------------------------------------------
const argv = process.argv.slice(2)
export const argVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
export const hasFlag = (name) => argv.includes(name)

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
export const cfg = (k) => process.env[k] || dotenv[k] || ''

export const BASE = (argVal('--base') || process.env.SMOKE_BASE || `http://127.0.0.1:${cfg('HTTP_PORT') || '80'}`).replace(/\/+$/, '')
export const KEY = argVal('--key') || process.env.SMOKE_KEY || cfg('GW_KEY') || ''
export const PREFIX = '/api-gw/v1'

let checks = 0
export const passed = () => checks
export const log = (msg) => console.log('[' + (process.env.PROBE_TAG || 'probe') + '] ' + msg)
export const fail = (msg) => { console.error('[' + (process.env.PROBE_TAG || 'probe') + '] FAIL: ' + msg); process.exit(1) }
export async function step(name, fn) {
  log('-- ' + name)
  try { await fn(); checks++ } catch (e) { fail(name + ': ' + (e && e.message ? e.message : String(e))) }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const requireKey = () => {
  if (!KEY) fail('no API key: set GW_KEY in .env or pass --key')
}

// ---- unary RPC (frozen apiproxy contract) ------------------------------------
// client-request: HTTP is always 200, business success is result.ok alone.
// client-response: the respond receipt channel (question/approval answers).
let rpcSeq = 0
export async function post(path, body, headers = {}) {
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

export async function rpc(method, payload, key = KEY) {
  const rpcId = `probe-${Date.now()}-${++rpcSeq}`
  const res = await post(`${PREFIX}/proxy/${method}`, { type: 'client-request', rpcId, method, payload }, { 'x-api-key': key })
  if (res.status !== 200) throw new Error(`${method}: HTTP ${res.status} — ${res.text.slice(0, 200)}`)
  const env = res.json
  if (!env || env.type !== 'server-response' || !env.result) throw new Error(`${method}: malformed server-response: ${res.text.slice(0, 200)}`)
  if (!env.result.ok) throw new Error(`${method}: ${env.result.error?.code} — ${env.result.error?.message}`)
  return env.result.value
}

/** Answer a pending question/approval broadcast (rpcId comes from the mux frame or health.answererPendingIds). */
export async function respond(rpcId, value) {
  const res = await post(PREFIX + '/respond', { type: 'client-response', rpcId, result: { ok: true, value } }, { 'x-api-key': KEY })
  if (res.status !== 200) throw new Error(`respond: HTTP ${res.status} — ${res.text.slice(0, 200)}`)
  return res.json
}

export async function getHealth() {
  const res = await fetch(BASE + PREFIX + '/health', { signal: AbortSignal.timeout(10_000) })
  if (res.status !== 200) throw new Error(`health: HTTP ${res.status}`)
  return res.json()
}

// ---- history helpers (V3/V4 vocabulary: { event: { type: 'turn/end', data } }) ----
export const evOf = (e) => (e && e.event) || e
export const typeOf = (e) => evOf(e)?.type

export async function history(sessionId) {
  const hist = await rpc('session.history', { sessionId })
  return Array.isArray(hist?.events) ? hist.events : []
}

/** Wait for the turn/end of turn >= minTurn (a multi-prompt session accumulates one per turn — matching on ANY turn/end would return a stale earlier turn). */
export async function waitTurnEnd(sessionId, opts = {}) {
  const { timeoutMs = 180_000, pollMs = 3000, minTurn = 1 } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = await history(sessionId)
    const turnEnd = events.find((e) => {
      if (typeOf(e) !== 'turn/end' && typeOf(e) !== 'turn_end') return false
      const turn = evOf(e)?.data?.turn
      return typeof turn !== 'number' || turn >= minTurn
    })
    if (turnEnd) return { turnEnd, events }
    await sleep(pollMs)
  }
  throw new Error(`no turn/end (turn>=${minTurn}) within ${timeoutMs}ms`)
}

// ---- minimal WebSocket client (text/binary/close/ping/pong, client masking) ----
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

export function wsOpen(wsUrl, headers = {}, timeoutMs = 10_000) {
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

export class WsConn {
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
  /** Parsed JSON frames arrive as { kind: 'text' }; this waits on the decoded object. */
  waitJson(pred, timeoutMs = 30_000) {
    return this.waitFrame((f) => {
      if (f.kind !== 'text') return false
      try { return pred(JSON.parse(f.data)) } catch { return false }
    }, timeoutMs).then((f) => JSON.parse(f.data))
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

export const wsBase = () => BASE.replace(/^http/, 'ws')
export const muxUrl = (path = '/proxy/events.mux') => wsBase() + PREFIX + path
