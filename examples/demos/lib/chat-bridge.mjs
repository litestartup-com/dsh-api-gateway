// chat-bridge.mjs — session lifecycle + mux→SSE bridging shared by both demo BFFs.
//
// One ChatBridge owns: the session store (sid → record), the single mux WebSocket
// (via FacadeClient), per-session SSE fan-out with a current-turn replay buffer,
// the approval policy hook (auto-decide), question surfacing, and pending-card
// recovery on every (re)connect.
//
// SSE event vocabulary pushed to browsers:
//   status {state}                          mux pipe state: open|reconnecting|closed
//   turn_start {}                           (also clears the replay buffer)
//   delta {text} / reasoning {text}         assistant streaming chunks
//   message {text}                          final assistant message
//   tool_call {name, args} / tool_result {isError, text}
//   question {rpcId, questions}             card for the visitor (answer via /api/respond)
//   question_resolved {rpcId, outcome}
//   approval {toolName, reason, outcome, auto}   decided by the BFF policy, shown for transparency
//   projection {key, value}                 live projections (title, tokenUsage, …)
//   turn_end {reason}
//   error {message}
import { FacadeClient } from './facade-client.mjs'

const BUFFER_CAP = 400

export class ChatBridge {
  /**
   * @param {object} opts
   * @param {FacadeClient} opts.client
   * @param {string} opts.cwd          container-side cwd for session.create (e.g. /workspace/kb)
   * @param {'read-only'|'workspace-write'} opts.sandboxMode  pinned right after create
   * @param {(info:{toolName:string, reason:string|null, sessionId:string}) => 'allowed-once'|'rejected'|null} opts.approvalPolicy
   *        return an outcome to auto-decide, or null to surface the approval to the UI as a question-like card
   * @param {(m:string)=>void} [opts.log]
   */
  constructor(opts) {
    this.client = opts.client
    this.cwd = opts.cwd
    this.sandboxMode = opts.sandboxMode
    this.approvalPolicy = opts.approvalPolicy ?? (() => 'rejected')
    this.log = opts.log ?? (() => {})
    /** @type {Map<string, {sessionId:string, sse:Set<any>, buffer:any[], questions:Map<string, any>}>} */
    this.sessions = new Map()
  }

  #record(sessionId) {
    let rec = this.sessions.get(sessionId)
    if (!rec) { rec = { sessionId, sse: new Set(), buffer: [], questions: new Map() }; this.sessions.set(sessionId, rec) }
    return rec
  }

  #emit(sessionId, event, data) {
    const rec = this.sessions.get(sessionId)
    if (!rec) return
    const item = { event, data }
    if (event === 'turn_start') rec.buffer.length = 0
    if (event !== 'status') {
      rec.buffer.push(item)
      if (rec.buffer.length > BUFFER_CAP) rec.buffer.splice(0, rec.buffer.length - BUFFER_CAP)
    }
    for (const sse of rec.sse) sse.send(event, data)
  }

  #emitAll(event, data) {
    for (const sid of this.sessions.keys()) {
      for (const sse of this.sessions.get(sid).sse) sse.send(event, data)
    }
  }

  /** Validate an existing sid (history probe) or create a fresh pinned session. */
  async ensure(sid) {
    if (typeof sid === 'string' && sid !== '') {
      try {
        await this.client.history(sid)
        this.#record(sid)
        return sid
      } catch { /* fall through to create */ }
    }
    const value = await this.client.createSession(this.cwd)
    const sessionId = value?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error(`session.create returned no sessionId: ${JSON.stringify(value).slice(0, 200)}`)
    try {
      await this.client.pinSandboxMode(sessionId, this.sandboxMode)
    } catch (e) {
      // Not fatal for the demo: the session keeps the host default mode. Loud in the log.
      this.log(`sandbox pin ${this.sandboxMode} failed for ${sessionId}: ${e.message}`)
    }
    this.#record(sessionId)
    return sessionId
  }

  /** Re-register a known-valid sid without creating anything (page-refresh stream reattach). */
  async revalidate(sid) {
    if (typeof sid !== 'string' || sid === '') return false
    try {
      await this.client.history(sid)
      this.#record(sid)
      return true
    } catch { return false }
  }

  async prompt(sid, text) {
    const sessionId = await this.ensure(sid)
    await this.client.prompt(sessionId, text)
    return sessionId
  }

  /** Attach an SSE handle: replay the current turn, then live frames. Returns a disposer. */
  attach(sid, sse) {
    const rec = this.sessions.get(sid)
    if (!rec) { sse.send('error', { message: 'unknown session' }); sse.close(); return () => {} }
    for (const item of rec.buffer) sse.send(item.event, item.data)
    // Re-surface still-pending question cards (a page refresh must not lose them).
    for (const [rpcId, payload] of rec.questions) sse.send('question', { rpcId, questions: payload.questions ?? [] })
    rec.sse.add(sse)
    return () => rec.sse.delete(sse)
  }

  async respondQuestion(sid, rpcId, answers) {
    const receipt = await this.client.answerQuestion(rpcId, sid, answers)
    if (receipt.accepted) this.sessions.get(sid)?.questions.delete(rpcId)
    return receipt
  }

  async declineQuestion(sid, rpcId) {
    const receipt = await this.client.declineQuestion(rpcId, sid)
    if (receipt.accepted) this.sessions.get(sid)?.questions.delete(rpcId)
    return receipt
  }

  /** Plain transcript for page-load rendering: user/assistant messages only. */
  async transcript(sid) {
    const hist = await this.client.history(sid)
    const out = []
    for (const entry of Array.isArray(hist?.events) ? hist.events : []) {
      const ev = entry?.event ?? entry
      const type = ev?.type
      const data = ev?.data ?? {}
      if (type === 'user/message') out.push({ role: 'user', text: blocksText(data.content) })
      else if (type === 'assistant/message') out.push({ role: 'assistant', text: blocksText(data.message?.content) })
      else if (type === 'turn/end' && data.reason?.kind === 'error') out.push({ role: 'system', text: `turn ended with an error: ${data.reason.error?.message ?? 'unknown'}` })
    }
    return out
  }

  start() {
    this.client.connectMux({
      onStatus: (state) => {
        this.#emitAll('status', { state })
        if (state === 'open') void this.#recoverPending()
      },
      onFrame: (frame) => this.#onFrame(frame),
    })
  }

  stop() { this.client.closeMux() }

  /** Card-loss recovery: re-decide approvals / re-surface questions broadcast while we were away. */
  async #recoverPending() {
    try {
      const { pending } = await this.client.pending()
      for (const item of Array.isArray(pending) ? pending : []) {
        const payload = item?.payload ?? {}
        const sid = payload.sessionId
        if (typeof sid !== 'string' || !this.sessions.has(sid)) continue
        if (item.method === 'approval/requested') void this.#handleApproval(item.rpcId, payload)
        else if (item.method === 'question/requested') void this.#handleQuestion(item.rpcId, payload)
      }
    } catch (e) { this.log(`pending recovery failed: ${e.message}`) }
  }

  #onFrame(frame) {
    const payload = frame?.payload
    if (!payload || typeof payload !== 'object') return
    const sid = payload.sessionId
    if (typeof sid !== 'string' || !this.sessions.has(sid)) return
    if (frame.method === 'session/event') return this.#onSessionEvent(sid, payload.event)
    if (frame.method === 'session/projection') return this.#emit(sid, 'projection', { key: payload.key, value: payload.value })
    if (frame.method === 'question/requested') return void this.#handleQuestion(frame.rpcId, payload)
    if (frame.method === 'approval/requested') return void this.#handleApproval(frame.rpcId, payload)
    if (frame.method === 'question/resolved') {
      this.sessions.get(sid)?.questions.delete(payload.questionRpcId ?? frame.rpcId)
      return this.#emit(sid, 'question_resolved', { rpcId: payload.questionRpcId ?? frame.rpcId, outcome: payload.outcome })
    }
    if (frame.method === 'approval/resolved') return this.#emit(sid, 'approval_resolved', { rpcId: frame.rpcId, outcome: payload.outcome })
  }

  #onSessionEvent(sid, ev) {
    const type = ev?.type
    const data = ev?.data ?? {}
    switch (type) {
      case 'assistant/chunk': {
        const chunk = data.chunk
        if (chunk?.type === 'text-delta') this.#emit(sid, 'delta', { text: String(chunk.text ?? '') })
        else if (chunk?.type === 'reasoning-delta') this.#emit(sid, 'reasoning', { text: String(chunk.text ?? '') })
        return
      }
      case 'assistant/message':
        return this.#emit(sid, 'message', { text: blocksText(data.message?.content) })
      case 'tool/call':
        return this.#emit(sid, 'tool_call', { name: String(data.name ?? ''), args: truncate(String(data.arguments ?? ''), 400) })
      case 'tool/result': {
        const block = Array.isArray(data.message?.content) ? data.message.content[0] : null
        return this.#emit(sid, 'tool_result', { isError: Boolean(data.error || block?.isError), text: truncate(blocksText(block?.content), 300) })
      }
      case 'turn/start':
        return this.#emit(sid, 'turn_start', {})
      case 'turn/end':
        return this.#emit(sid, 'turn_end', { reason: String(data.reason?.kind ?? 'unknown') })
      default:
        return // user/message echo, bookkeeping events: not needed live
    }
  }

  async #handleApproval(rpcId, payload) {
    const sid = payload.sessionId
    const info = { toolName: String(payload.toolName ?? ''), reason: typeof payload.reason === 'string' ? payload.reason : null, sessionId: sid }
    const outcome = this.approvalPolicy(info)
    if (outcome === null) { // surface to the UI (not used by the two stock demos, kept for custom policies)
      this.#emit(sid, 'approval', { rpcId, toolName: info.toolName, reason: info.reason, outcome: 'pending', auto: false })
      return
    }
    try {
      const receipt = await this.client.decideApproval(rpcId, sid, payload.approvalId ?? rpcId, outcome)
      this.#emit(sid, 'approval', { rpcId, toolName: info.toolName, reason: info.reason, outcome: receipt.accepted ? outcome : `not-decided (${receipt.reason ?? '?'})`, auto: true })
    } catch (e) {
      this.#emit(sid, 'approval', { rpcId, toolName: info.toolName, reason: info.reason, outcome: `error: ${e.message}`, auto: true })
    }
  }

  async #handleQuestion(rpcId, payload) {
    const sid = payload.sessionId
    this.sessions.get(sid)?.questions.set(rpcId, payload)
    this.#emit(sid, 'question', { rpcId, questions: Array.isArray(payload.questions) ? payload.questions : [] })
  }
}

// ---- helpers ----

export function blocksText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text').map((b) => String(b.text ?? '')).join('\n')
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
