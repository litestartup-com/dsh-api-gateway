// facade-client.mjs — zero-dependency client for the ohdsh-api-facade wire contract,
// shared by both demo BFFs (kb / cs). Covers:
//   - unary RPC (client-request / server-response envelopes; success = result.ok, HTTP is always 200)
//   - respond receipts for question/approval waterfalls (client-response envelope)
//   - sandbox-mode pinning (the only wire channel that can pin a live session's mode)
//   - GET answerer/pending (recovery channel for cards broadcast while we were disconnected)
//   - a persistent mux WebSocket (downlink only) with auto-reconnect — a minimal RFC6455
//     client over node:http, so the demos need no `ws` package.
//
// Wire vocabulary (frozen apiproxy contract; evidence in src/streams.ts / src/answerer.ts):
//   mux frames: {type:'server-request', rpcId, method, payload} with method ∈
//     session/event | session/projection | question/requested | question/resolved |
//     approval/requested | approval/resolved
//   session/event payload.event = raw session-log event {type,seq,time,data}, slash-form
//     types (user/message, assistant/chunk, assistant/message, tool/call, tool/result,
//     turn/start, turn/end, …)
//   respond body: {type:'client-response', rpcId, result:{ok:true,value}|{ok:false,error:{code,message}}}
//     → receipt {accepted:true} | {accepted:false, reason:'not-pending'|'bad-response'}
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export class FacadeError extends Error {
  constructor(code, message) {
    super(`${code} — ${message}`)
    this.name = 'FacadeError'
    this.code = code
  }
}

export class FacadeClient {
  #seq = 0
  #mux = null

  /** @param {{base:string, key:string, prefix?:string, timeoutMs?:number, log?:(m:string)=>void}} opts */
  constructor(opts) {
    this.base = String(opts.base).replace(/\/+$/, '')
    this.key = opts.key ?? ''
    this.prefix = opts.prefix ?? '/api-gw/v1'
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.log = opts.log ?? (() => {})
  }

  get root() { return this.base + this.prefix }

  #headers(extra = {}) {
    const h = { 'content-type': 'application/json', ...extra }
    if (this.key !== '') h['x-api-key'] = this.key
    return h
  }

  async #postJson(url, body, extraHeaders = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: this.#headers(extraHeaders),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await res.text()
    let json = null
    try { json = text === '' ? null : JSON.parse(text) } catch { /* keep null */ }
    return { status: res.status, json, text }
  }

  /** One unary RPC. Throws FacadeError on a business error, Error on carrier problems. */
  async rpc(method, payload = {}) {
    const rpcId = `demo-${Date.now()}-${++this.#seq}`
    const res = await this.#postJson(`${this.root}/proxy/${method}`, { type: 'client-request', rpcId, method, payload })
    if (res.status !== 200) throw new Error(`${method}: HTTP ${res.status} — ${res.text.slice(0, 300)}`)
    const env = res.json
    if (!env || env.type !== 'server-response' || !env.result) throw new Error(`${method}: malformed server-response`)
    if (!env.result.ok) throw new FacadeError(env.result.error?.code ?? 'unknown', env.result.error?.message ?? '')
    return env.result.value
  }

  async health() {
    const res = await fetch(`${this.root}/health`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`health: HTTP ${res.status}`)
    return res.json()
  }

  async createSession(cwd, preset) {
    return this.rpc('session.create', { cwd, ...(preset ? { agentPreset: preset } : {}) })
  }

  async prompt(sessionId, text) {
    return this.rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  }

  async history(sessionId) { return this.rpc('session.history', { sessionId }) }
  async cancel(sessionId) { return this.rpc('session.cancel', { sessionId }) }
  async listSessions() { return this.rpc('session.list', {}) }

  /**
   * Pin the session's sandbox mode (read-only | workspace-write). Must target a LIVE
   * session — call right after createSession. Non-envelope JSON endpoint.
   */
  async pinSandboxMode(sessionId, mode) {
    const res = await this.#postJson(`${this.root}/sessions/${encodeURIComponent(sessionId)}/sandbox-mode`, { mode })
    if (res.status === 200) return res.json
    throw new Error(`sandbox-mode ${mode}: HTTP ${res.status} — ${res.text.slice(0, 200)}`)
  }

  async #respond(rpcId, result) {
    const res = await this.#postJson(`${this.root}/respond`, { type: 'client-response', rpcId, result })
    if (res.status !== 200) throw new Error(`respond: HTTP ${res.status} — ${res.text.slice(0, 200)}`)
    return { accepted: res.json?.accepted === true, reason: res.json?.reason }
  }

  /** Answer a question card. answers: [{id, selected:[label], custom?}] (AskUserQuestionAnswerItem). */
  answerQuestion(rpcId, sessionId, answers) {
    return this.#respond(rpcId, { ok: true, value: { sessionId, answer: { answers } } })
  }

  /** Decline a question card (host-side ASK_CANCELLED semantics). */
  declineQuestion(rpcId, sessionId) {
    return this.#respond(rpcId, { ok: false, error: { code: 'cancelled', message: 'the user cancelled ask_user_question' } })
  }

  /** Decide an approval. outcome ∈ allowed-once | rejected | cancelled | unavailable. */
  decideApproval(rpcId, sessionId, approvalId, outcome) {
    return this.#respond(rpcId, { ok: true, value: { sessionId, approvalId, outcome } })
  }

  /** Pending question/approval broadcasts (card-loss recovery). → {pending:[{rpcId,method,payload}]} */
  async pending() {
    const res = await fetch(`${this.root}/answerer/pending`, { headers: this.#headers(), signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`pending: HTTP ${res.status}`)
    return res.json()
  }

  // ---- persistent mux WebSocket (downlink only; never send data frames or the facade closes 1008) ----

  /**
   * Open (and keep open) the mux pipe.
   * @param {{onFrame:(f:any)=>void, onStatus?:(s:'open'|'closed'|'reconnecting')=>void}} handlers
   */
  connectMux(handlers) {
    this.closeMux()
    const state = { stopped: false, conn: null, retry: 0, timer: null, pingTimer: null }
    this.#mux = state

    const wsUrl = new URL(this.root.replace(/^http/, 'ws') + '/proxy/events.mux')
    const open = () => {
      if (state.stopped) return
      const lib = wsUrl.protocol === 'wss:' ? httpsRequest : httpRequest
      const req = lib({
        host: wsUrl.hostname,
        port: wsUrl.port || (wsUrl.protocol === 'wss:' ? 443 : 80),
        path: wsUrl.pathname,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          ...(this.key !== '' ? { 'X-API-Key': this.key } : {}),
        },
      })
      let settled = false
      req.on('error', (e) => { if (!settled) { settled = true; scheduleReconnect(`handshake error: ${e.message}`) } })
      req.on('response', (res) => { // refused before the upgrade (e.g. 401)
        res.resume()
        if (!settled) { settled = true; scheduleReconnect(`refused: HTTP ${res.statusCode}`) }
      })
      req.on('upgrade', (_res, socket) => {
        settled = true
        state.retry = 0
        handlers.onStatus?.('open')
        const conn = new WsConn(socket)
        state.conn = conn
        conn.onFrame = (frame) => {
          try { handlers.onFrame(JSON.parse(frame.text)) } catch (e) { this.log(`bad mux frame: ${e.message}`) }
        }
        conn.onClose = (code) => {
          state.conn = null
          clearInterval(state.pingTimer)
          scheduleReconnect(`socket closed (${code})`)
        }
        // Keep intermediaries (nginx read timeout) from reaping an idle pipe. Control
        // frames are safe: the downlink-only rule closes on DATA frames, not pings.
        state.pingTimer = setInterval(() => conn.ping(), 60_000)
      })
      req.end()
    }

    const scheduleReconnect = (why) => {
      if (state.stopped) return
      handlers.onStatus?.('reconnecting')
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(state.retry++, 5))
      this.log(`mux ${why} — reconnecting in ${delay}ms`)
      clearTimeout(state.timer)
      state.timer = setTimeout(open, delay)
    }

    open()
  }

  closeMux() {
    const state = this.#mux
    if (!state) return
    state.stopped = true
    clearTimeout(state.timer)
    clearInterval(state.pingTimer)
    state.conn?.destroy()
    this.#mux = null
  }
}

// ---- minimal RFC6455 connection (text frames + close/ping/pong; client-side masking) ----

function encodeFrame(opcode, payload) {
  const len = payload.length
  const mask = randomBytes(4)
  let header
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2) }
  header[0] = 0x80 | opcode
  const masked = Buffer.alloc(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([header, mask, masked])
}

class WsConn {
  constructor(socket) {
    this.socket = socket
    this.onFrame = () => {}
    this.onClose = () => {}
    this.#buf = Buffer.alloc(0)
    this.#frag = []
    socket.on('data', (chunk) => { this.#buf = Buffer.concat([this.#buf, chunk]); this.#parse() })
    socket.on('close', () => this.#closed(1006))
    socket.on('error', () => this.#closed(1006))
  }
  #buf
  #frag
  #closeState = null
  #closed(code) { if (this.#closeState === null) { this.#closeState = code; this.onClose(code) } }
  #parse() {
    for (;;) {
      if (this.#buf.length < 2) return
      const b0 = this.#buf[0]; const b1 = this.#buf[1]
      const fin = (b0 & 0x80) !== 0; const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0; const len7 = b1 & 0x7f
      let off = 2; let len = len7
      if (len7 === 126) { if (this.#buf.length < 4) return; len = this.#buf.readUInt16BE(2); off = 4 }
      else if (len7 === 127) { if (this.#buf.length < 10) return; len = Number(this.#buf.readBigUInt64BE(2)); off = 10 }
      let maskKey = null
      if (masked) { if (this.#buf.length < off + 4) return; maskKey = this.#buf.subarray(off, off + 4); off += 4 }
      if (this.#buf.length < off + len) return
      let payload = this.#buf.subarray(off, off + len)
      if (masked) {
        const p = Buffer.alloc(len)
        for (let i = 0; i < len; i++) p[i] = payload[i] ^ maskKey[i & 3]
        payload = p
      }
      this.#buf = this.#buf.subarray(off + len)
      if (opcode === 0x0) { this.#frag.push(payload); if (fin) { this.onFrame({ text: Buffer.concat(this.#frag).toString('utf8') }); this.#frag = [] } }
      else if (opcode === 0x1 || opcode === 0x2) {
        if (fin) this.onFrame({ text: payload.toString('utf8') })
        else this.#frag = [payload]
      }
      else if (opcode === 0x8) { // close: echo best-effort, then report
        const code = len >= 2 ? payload.readUInt16BE(0) : 1005
        try { this.socket.end(encodeFrame(0x8, payload.subarray(0, Math.min(len, 2)))) } catch { /* gone */ }
        this.#closed(code)
        return
      }
      else if (opcode === 0x9) { try { this.socket.write(encodeFrame(0xa, payload)) } catch { /* gone */ } } // ping → pong
      // 0xa pong: ignored
    }
  }
  ping() { try { this.socket.write(encodeFrame(0x9, Buffer.alloc(0))) } catch { /* gone */ } }
  destroy() { try { this.socket.destroy() } catch { /* gone */ } }
}
