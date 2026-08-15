/**
 * dsh-api-gateway — Host half.
 *
 * An open-source DeepSeek Harness plugin that publishes a minimal REST + SSE
 * gateway over the harness HTTP carrier (`webServer`). Third-party clients can
 * create agent sessions and converse with the agents — the same agent machine
 * the Web GUI drives — without touching the GUI at all.
 *
 * Install: pnpm add dsh-api-gateway, then add one row to the host composition
 * (see README / examples/cordis.yml). Uninstall: remove the row and restart.
 *
 * Composition plane: this plugin publishes a cross-session HTTP surface, so it
 * belongs in the HOST composition — never inside an agent preset.
 *
 * Extensibility: other host plugins can subscribe to gateway events via the
 * ordinary Cordis bus — `gateway/session-created`, `gateway/message`,
 * `gateway/turn-end` (payloads documented in the README).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Route prefix. Defaults to /api-gw/v1. */
  prefix: string
  /** Master switch; also toggleable at runtime through the admin endpoint. */
  enabled: boolean
  /** Static API keys accepted by the gateway (in addition to the provisioned key). */
  apiKeys: string[]
  /** Allow the one-time `POST {prefix}/key` bootstrap when no key exists. */
  allowKeyProvision: boolean
  /** Admin key for `{prefix}/admin/*`; unset disables the admin surface. */
  adminKey?: string
  /** Cap on concurrent live sessions owned by this gateway. */
  maxSessions: number
  /** Workspace policy for sessions created without `workspace`. */
  workspaceMode: 'auto' | 'ungrouped'
  /** Fallback directory for `auto` mode when no cwd is given. */
  defaultWorkspacePath?: string
  /** Allow GET /sessions/discover (lists every session — see security model). */
  allowDiscover: boolean
  /** Allow POST /sessions/:id/adopt (drive/resume any session). */
  allowAdopt: boolean
  /** CORS origin(s); default '*' (open). Set an explicit origin list for public deployments. */
  corsOrigin: string | string[]
  /** Include internal error messages in HTTP responses (helpful locally, noisy publicly). */
  exposeErrors: boolean
  /** SSE heartbeat interval in ms; 0 disables. */
  sseHeartbeatMs: number
  /** Request body read timeout in ms. */
  bodyTimeoutMs: number
}

export const Config = z.object({
  prefix: z.string().default('/api-gw/v1'),
  enabled: z.boolean().default(true),
  apiKeys: z.array(z.string()).default([]),
  allowKeyProvision: z.boolean().default(true),
  adminKey: z.string().optional(),
  maxSessions: z.natural().default(20),
  workspaceMode: z.union([z.const('auto'), z.const('ungrouped')]).default('auto'),
  defaultWorkspacePath: z.string().optional(),
  allowDiscover: z.boolean().default(true),
  allowAdopt: z.boolean().default(true),
  corsOrigin: z.union([z.string(), z.array(z.string())]).default('*'),
  exposeErrors: z.boolean().default(true),
  sseHeartbeatMs: z.natural().default(30_000),
  bodyTimeoutMs: z.natural().default(30_000),
})

interface SessionEntry {
  agent: AgentLike
  dispose: () => Promise<void> | void
  subscribers: Set<ServerResponse>
  log: GatewayEvent[]
  delivered: Set<number>
  pollFrom: number
  pollerDispose: (() => void) | null
  lastBeat: number
  workspace: { id: string; path: string; title: string } | null
  owned: boolean
  mode: 'created' | 'live' | 'resumed'
}

/** The subset of the dsh-agent Agent surface this plugin uses. */
interface AgentLike {
  readonly id: string
  readonly status: string
  readonly options: { provider?: string; model?: string; maxTokens?: number }
  readonly session: { readonly log: readonly unknown[]; readonly header: { cwd?: string } }
  followup(message: unknown): void
  cancel(cause: { kind: 'user' | 'disposed' }): void
}

type GatewayEvent = { kind: string; seq: number; [key: string]: unknown }

export default {
  inject: ['webServer', 'agentLoop', 'timer'],
  apply(ctx: Context, config: Config) {
    const webServer = ctx.webServer
    const agentLoop = ctx.agentLoop
    const sessionQuery = ctx.get('sessionQuery') as { readSession?: (id: string) => Promise<unknown>; listSessions?: () => Promise<unknown[]> } | undefined
    const agentsService = ctx.get('agents') as { get?: (id: string) => unknown } | undefined

    let enabled = config.enabled
    let apiKey: string | null = null
    const apiSessions = new Map<string, SessionEntry>()

    // ---- primitives ----

    const randomToken = (prefix: string, length: number) => {
      const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
      let s = prefix
      const pool = randomBytes(length * 2)
      let cursor = 0
      while (s.length < prefix.length + length && cursor < pool.length) {
        const byte = pool[cursor++]
        // 252 = 7 * 36: rejecting >= 252 avoids modulo bias.
        if (byte < 252) s += alphabet[byte % 36]
      }
      while (s.length < prefix.length + length) s += alphabet[randomBytes(1)[0] % 36]
      return s
    }

    /** Constant-time string comparison (timing-attack resistant). */
    const safeEqual = (a: string, b: string) => {
      const ab = Buffer.from(a, 'utf8')
      const bb = Buffer.from(b, 'utf8')
      if (ab.length !== bb.length) return false
      return timingSafeEqual(ab, bb)
    }

    const errorDetail = (error: unknown) => {
      const message = String((error as Error)?.message ?? error)
      return config.exposeErrors ? message : 'internal error (set exposeErrors: true for details)'
    }

    /** Emit a gateway event on the Cordis bus for other host plugins. Never throws into the gateway. */
    const emitGatewayEvent = (name: string, payload: Record<string, unknown>) => {
      try { (ctx as any).events?.emit?.(name, payload) } catch { /* listeners never break the gateway */ }
    }

    const setCors = (res: ServerResponse) => {
      const origins = Array.isArray(config.corsOrigin) ? config.corsOrigin : [config.corsOrigin]
      res.setHeader('Access-Control-Allow-Origin', origins.join(', ') || '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-api-key, x-admin-key')
      res.setHeader('Access-Control-Max-Age', '600')
    }

    const sendJson = (res: ServerResponse, status: number, obj: unknown) => {
      setCors(res)
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }

    const readBody = (req: IncomingMessage) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const stopTimer = ctx.timeout(() => {
        if (settled) return
        settled = true
        reject(new Error('body read timeout'))
        try { req.destroy() } catch { /* noop */ }
      }, config.bodyTimeoutMs)
      const finish = (done: () => void) => {
        if (settled) return
        settled = true
        stopTimer()
        done()
      }
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1_000_000) { finish(() => reject(new Error('body too large'))); return }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const buf = Buffer.concat(chunks)
        // Honor the request charset (RFC 9110): default UTF-8, but accept
        // e.g. gbk/gb2312 from clients that still send ANSI-encoded bodies
        // (notably Windows PowerShell 5.1).
        const charset = /charset=([^;]+)/i.exec(String(req.headers['content-type'] ?? ''))?.[1]?.trim()
        let text: string
        if (charset !== undefined && charset !== '' && !/^utf-?8$/i.test(charset)) {
          try { text = new TextDecoder(charset).decode(buf) } catch { text = buf.toString('utf8') }
        } else {
          text = buf.toString('utf8')
        }
        if (text.trim() === '') return finish(() => resolve({}))
        try { finish(() => resolve(JSON.parse(text))) } catch { finish(() => reject(new Error('invalid JSON body'))) }
      })
      req.on('error', (error) => finish(() => reject(error)))
    })

    // ---- auth ----

    const bearerToken = (req: IncomingMessage) => {
      const header = req.headers['authorization']
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
      return header.slice(7).trim()
    }

    const keyAccepted = (candidate: string | null) => {
      if (candidate === null || candidate === '') return false
      if (apiKey !== null && safeEqual(candidate, apiKey)) return true
      return config.apiKeys.some((key) => safeEqual(candidate, key))
    }

    const authorized = (req: IncomingMessage) => {
      const xKey = req.headers['x-api-key']
      return keyAccepted(bearerToken(req)) || keyAccepted(typeof xKey === 'string' ? xKey : null)
    }

    const isAdmin = (req: IncomingMessage) => {
      if (config.adminKey === undefined || config.adminKey === '') return false
      const supplied = req.headers['x-admin-key']
      return typeof supplied === 'string' && safeEqual(supplied, config.adminKey)
    }

    const requireAuth = (req: IncomingMessage, res: ServerResponse) => {
      if (authorized(req)) return true
      sendJson(res, 401, { error: 'unauthorized', hint: `Provide X-API-Key. POST ${config.prefix}/key provisions a key (first call only).` })
      return false
    }

    // ---- event mapping (leaf-field reads only; never serialize live objects) ----

    // Visible text and thinking content are split, never concatenated.
    const extractBlocks = (content: unknown) => {
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

    const chunkJson = (chunk: unknown): Record<string, unknown> | null => {
      if (chunk === null || typeof chunk !== 'object') return null
      const c = chunk as any
      switch (c.type) {
        case 'text-delta': return { type: 'text-delta', text: String(c.text) }
        case 'reasoning-delta': return { type: 'reasoning-delta', text: String(c.text) }
        case 'tool-call-delta': return { type: 'tool-call-delta', id: c.id == null ? null : String(c.id), name: c.name == null ? null : String(c.name), argumentsDelta: String(c.argumentsDelta ?? '') }
        case 'usage': return { type: 'usage', usage: c.usage }
        case 'finish': return { type: 'finish', reason: c.reason?.kind ? String(c.reason.kind) : 'unknown' }
        default: return null
      }
    }

    const eventPayload = (event: unknown): GatewayEvent | null => {
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
          return { kind: 'message', seq: e.seq, text: parts.text, reasoning: parts.reasoning !== '' ? parts.reasoning : null, usage: data?.usage ?? null }
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

    const sseFrame = (payload: GatewayEvent) => 'data: ' + JSON.stringify(payload) + '\n\n'

    // ---- SSE fan-out + pump ----

    const writeToSubscribers = (entry: SessionEntry, frame: string) => {
      for (const res of Array.from(entry.subscribers)) {
        try { res.write(frame) } catch { entry.subscribers.delete(res) }
      }
    }

    const deliver = (entry: SessionEntry, payload: GatewayEvent) => {
      if (payload.seq === undefined || entry.delivered.has(payload.seq)) return
      entry.delivered.add(payload.seq)
      if (entry.delivered.size > 1000) {
        entry.delivered = new Set(entry.log.slice(-400).map((p) => p.seq))
        entry.delivered.add(payload.seq)
      }
      entry.log.push(payload)
      if (entry.log.length > 500) entry.log.splice(0, entry.log.length - 500)
      if (payload.kind === 'turn_end' && payload.reason === 'error') {
        ctx.logger?.warn?.(`[api-gateway] session ${entry.agent.id} turn errored: ${(payload as any).detail?.message ?? 'unknown'}`)
      }
      writeToSubscribers(entry, sseFrame(payload))
      if (payload.kind === 'message') {
        emitGatewayEvent('gateway/message', { sessionId: entry.agent.id, messageId: payload.messageId ?? null, text: payload.text ?? '' })
      }
      if (payload.kind === 'turn_end') {
        emitGatewayEvent('gateway/turn-end', { sessionId: entry.agent.id, turn: payload.turn ?? null, reason: payload.reason, detail: payload.detail ?? null })
        for (const res of Array.from(entry.subscribers)) { try { res.end() } catch { /* noop */ } }
        entry.subscribers.clear()
        releasePump(entry)
      }
    }

    /**
     * Poll the session log and forward mapped events. Doubles as the SSE
     * heartbeat source. Only runs while the entry has subscribers, so a quiet
     * session costs nothing.
     */
    const pollEntry = (entry: SessionEntry) => {
      const log = entry.agent.session.log
      for (let i = entry.pollFrom; i < log.length; i++) {
        const payload = eventPayload(log[i])
        if (payload !== null) deliver(entry, payload)
      }
      entry.pollFrom = log.length
      if (config.sseHeartbeatMs > 0 && entry.subscribers.size > 0 && Date.now() - entry.lastBeat >= config.sseHeartbeatMs) {
        writeToSubscribers(entry, ': ping\n\n')
        entry.lastBeat = Date.now()
      }
    }

    const ensurePump = (entry: SessionEntry) => {
      if (entry.pollerDispose !== null) return
      entry.lastBeat = Date.now()
      entry.pollerDispose = ctx.interval(() => pollEntry(entry), 400)
    }

    const releasePump = (entry: SessionEntry) => {
      if (entry.pollerDispose === null) return
      try { entry.pollerDispose() } catch { /* noop */ }
      entry.pollerDispose = null
    }

    // Path A: live session/event listener; the pump (Path B) guarantees
    // delivery even when the scoped dispatch does not reach this context.
    const onSessionEvent = (session: { id: string }, event: unknown) => {
      const entry = apiSessions.get(session.id)
      if (entry === undefined) return
      const payload = eventPayload(event)
      if (payload !== null) deliver(entry, payload)
    }

    // ---- session creation ----

    const resolveDefaultModel = () => {
      const defaults = ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: string; model?: string } | undefined } | undefined
      try {
        const sel = defaults?.currentSelection?.()
        if (sel && typeof sel.provider === 'string' && sel.provider !== '' && typeof sel.model === 'string' && sel.model !== '') {
          return { provider: sel.provider, model: sel.model }
        }
      } catch { /* noop */ }
      const loopConfig = agentLoop.config as { agents?: Array<{ provider?: string; model?: string }> } | undefined
      const first = loopConfig?.agents?.[0]
      if (first && typeof first.provider === 'string' && first.provider !== '' && typeof first.model === 'string' && first.model !== '') {
        return { provider: first.provider, model: first.model }
      }
      return null
    }

    const resolveDefaultCwd = () => {
      const policy = ctx.get('sandboxPolicy') as { workspaceRoot?: string } | undefined
      return typeof policy?.workspaceRoot === 'string' && policy.workspaceRoot !== '' ? policy.workspaceRoot : undefined
    }

    // ---- workspace membership ----

    interface WorkspaceLike {
      readonly id: string
      readonly path: string
      readonly title: string
    }
    interface WorkspaceHandle extends WorkspaceLike {
      attachSession(sessionId: string): Promise<void>
    }
    interface WorkspaceRegistryLike {
      get(id: string): WorkspaceHandle | undefined
      list(): WorkspaceHandle[]
      resolveByPath(path: string): Promise<WorkspaceHandle | undefined>
      create(path: string, title?: string): Promise<WorkspaceHandle>
    }

    /**
     * Resolve the workspace a new session should join. Explicit request wins;
     * otherwise `auto` mode resolves-or-creates the effective cwd. The session
     * header cwd is later forced to the workspace canonical path so the durable
     * membership invariant (header cwd == workspace path) holds.
     */
    const resolveWorkspace = async (ws: unknown, fallbackCwd: string | undefined): Promise<WorkspaceHandle | null> => {
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      if (registry === undefined) return null
      if (ws !== undefined && ws !== null) {
        if (typeof ws === 'string' && ws !== '') {
          return (await registry.resolveByPath(ws)) ?? (await registry.create(ws))
        }
        if (typeof ws === 'object') {
          const w = ws as { id?: unknown; path?: unknown; title?: unknown }
          if (typeof w.id === 'string' && w.id !== '') {
            const existing = registry.get(w.id)
            if (existing === undefined) {
              const err = new Error('workspace_not_found') as Error & { workspaces?: unknown[] }
              try { err.workspaces = registry.list().map((x) => ({ id: x.id, title: x.title, path: x.path })) } catch { err.workspaces = [] }
              throw err
            }
            return existing
          }
          if (typeof w.path === 'string' && w.path !== '') {
            const title = typeof w.title === 'string' && w.title !== '' ? w.title : undefined
            return (await registry.resolveByPath(w.path)) ?? (await registry.create(w.path, title))
          }
        }
        throw new Error('workspace must be a path string, { path, title? }, or { id }')
      }
      if (fallbackCwd === undefined) return null
      return (await registry.resolveByPath(fallbackCwd)) ?? (await registry.create(fallbackCwd))
    }

    const makeEntry = (agent: AgentLike, owned: boolean, dispose: (() => Promise<void> | void) | null, mode: SessionEntry['mode'], workspace: SessionEntry['workspace']): SessionEntry => ({
      agent,
      dispose: dispose ?? (() => {}),
      subscribers: new Set(),
      log: [],
      delivered: new Set(),
      pollFrom: agent.session.log.length,
      pollerDispose: null,
      lastBeat: 0,
      workspace,
      owned,
      mode,
    })

    const createSession = async (body: Record<string, unknown>): Promise<SessionEntry> => {
      if (apiSessions.size >= config.maxSessions) throw new Error(`session cap reached (${config.maxSessions})`)
      const options: { provider?: string; model?: string; maxTokens?: number } = {}
      if (typeof body.provider === 'string' && body.provider !== '') options.provider = body.provider
      if (typeof body.model === 'string' && body.model !== '') options.model = body.model
      if (typeof body.maxTokens === 'number' && Number.isSafeInteger(body.maxTokens) && body.maxTokens > 0) options.maxTokens = body.maxTokens
      if (options.provider === undefined || options.model === undefined) {
        const fallback = resolveDefaultModel()
        if (fallback !== null) {
          if (options.provider === undefined) options.provider = fallback.provider
          if (options.model === undefined) options.model = fallback.model
        }
      }
      if (!options.provider || !options.model) throw new Error('no provider/model: supply both in the request body')
      const effectiveCwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : (config.defaultWorkspacePath ?? resolveDefaultCwd())
      let workspace: WorkspaceHandle | null = null
      if (body.workspace !== undefined || config.workspaceMode !== 'ungrouped') {
        workspace = await resolveWorkspace(body.workspace, effectiveCwd)
      }
      const cwd = workspace !== null ? workspace.path : effectiveCwd
      const sessionId = randomToken('apigw-session-', 20)

      // Proper ownership: the plugin fiber owns every created agent, so a
      // plugin stop or update tears each session down cleanly.
      const handle = await agentLoop.createAgent(ctx, {
        sessionId,
        agentOptions: options,
        ...(cwd === undefined ? {} : { meta: { cwd } }),
        // Mount the deployment's default agent preset so API sessions get the
        // same tools and skills as GUI sessions. Non-fatal by design.
        setup: async (agentCtx: Context) => {
          const presets = agentCtx.get('agentPresets') as { mount?: (c: Context, id?: string) => Promise<unknown> } | undefined
          if (presets?.mount !== undefined) {
            try { await presets.mount(agentCtx) } catch (error) {
              ctx.logger?.warn?.(`[api-gateway] preset mount failed for ${sessionId}: ${String(error)}`)
            }
          }
        },
      })

      const agent = handle.agent as AgentLike

      if (workspace !== null) {
        try {
          await workspace.attachSession(agent.id)
        } catch (error) {
          try { await handle.dispose() } catch { /* noop */ }
          throw new Error(`workspace_attach_failed: ${String((error as Error).message ?? error)}`)
        }
      }

      const workspaceInfo = workspace === null ? null : { id: workspace.id, path: workspace.path, title: workspace.title }
      const entry = makeEntry(agent, true, () => handle.dispose(), 'created', workspaceInfo)
      apiSessions.set(agent.id, entry)
      emitGatewayEvent('gateway/session-created', { sessionId: agent.id, mode: 'created', workspace: workspaceInfo, cwd: agent.session.header.cwd ?? null })
      return entry
    }

    // ---- session discovery / history / adoption ----

    const mapHeader = (header: unknown) => {
      const h = header as { id?: unknown; title?: unknown; cwd?: unknown } | null | undefined
      return {
        id: typeof h?.id === 'string' ? h.id : null,
        title: typeof h?.title === 'string' ? h.title : null,
        cwd: typeof h?.cwd === 'string' ? h.cwd : null,
      }
    }

    const readSessionSnapshot = async (sessionId: string): Promise<{ session: unknown; events: unknown[] } | null> => {
      if (sessionQuery?.readSession === undefined) return null
      try {
        const snapshot = await sessionQuery.readSession(sessionId)
        if (snapshot === null || typeof snapshot !== 'object') return null
        const s = snapshot as { session?: unknown; events?: unknown[] }
        return { session: s.session ?? null, events: Array.isArray(s.events) ? s.events : [] }
      } catch { return null }
    }

    const mappedHistory = (snapshot: { session: unknown; events: unknown[] } | null) => {
      if (snapshot === null) return []
      const out: GatewayEvent[] = []
      for (const event of snapshot.events) {
        const payload = eventPayload(event)
        if (payload !== null) out.push(payload)
      }
      return out
    }

    const adoptSession = async (sessionId: string): Promise<{ entry: SessionEntry; mode: SessionEntry['mode']; snapshot: { session: unknown; events: unknown[] } | null }> => {
      const existing = apiSessions.get(sessionId)
      if (existing !== undefined) {
        return { entry: existing, mode: existing.mode, snapshot: await readSessionSnapshot(sessionId) }
      }
      if (apiSessions.size >= config.maxSessions) throw new Error(`session cap reached (${config.maxSessions})`)

      let liveAgent: unknown
      try { liveAgent = agentsService?.get?.(sessionId) } catch { liveAgent = undefined }

      const snapshot = await readSessionSnapshot(sessionId)

      if (liveAgent !== undefined && liveAgent !== null) {
        const agent = liveAgent as AgentLike
        const entry = makeEntry(agent, false, null, 'live', null)
        apiSessions.set(sessionId, entry)
        emitGatewayEvent('gateway/session-created', { sessionId, mode: 'live', workspace: null, cwd: agent.session.header.cwd ?? null })
        return { entry, mode: 'live', snapshot }
      }

      if (snapshot === null) throw new Error('session_not_found')
      let handle: { agent?: unknown; dispose?: () => Promise<void> | void }
      try {
        handle = await agentLoop.resume(ctx, { resumeSessionId: sessionId }) as { agent?: unknown; dispose?: () => Promise<void> | void }
      } catch (error) {
        throw new Error(`resume_failed: ${String((error as Error).message ?? error)}`)
      }
      const agent = handle.agent as AgentLike
      const entry = makeEntry(agent, true, () => handle.dispose?.(), 'resumed', null)
      apiSessions.set(sessionId, entry)
      emitGatewayEvent('gateway/session-created', { sessionId, mode: 'resumed', workspace: null, cwd: agent.session.header.cwd ?? null })
      return { entry, mode: 'resumed', snapshot }
    }

    // ---- HTTP dispatch ----

    const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
      setCors(res)
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      const pathname = String(req.url ?? '').split('?')[0]
      const parts = pathname.split('/').filter((p) => p !== '')
      const prefixParts = config.prefix.split('/').filter((p) => p !== '')
      if (parts.length < prefixParts.length || parts.slice(0, prefixParts.length).join('/') !== prefixParts.join('/')) {
        return sendJson(res, 404, { error: 'not_found', service: 'api-gateway' })
      }
      const seg = parts.slice(prefixParts.length)

      // health stays reachable while disabled, for monitoring
      if (seg.length === 1 && seg[0] === 'health' && req.method === 'GET') {
        return sendJson(res, 200, { status: enabled ? 'ok' : 'disabled', enabled, sessions: apiSessions.size, apiKeySet: apiKey !== null })
      }
      if (!enabled) return sendJson(res, 503, { error: 'service_disabled' })

      if (seg.length === 0 && req.method === 'GET') {
        return sendJson(res, 200, {
          service: 'api-gateway', version: '0.1.0',
          endpoints: [
            { method: 'GET', path: config.prefix + '/health', auth: false },
            { method: 'POST', path: config.prefix + '/key', auth: 'first call only' },
            { method: 'POST', path: config.prefix + '/sessions', auth: true },
            { method: 'GET', path: config.prefix + '/sessions/discover', auth: true },
            { method: 'POST', path: config.prefix + '/sessions/:id/adopt', auth: true },
            { method: 'POST', path: config.prefix + '/sessions/:id/messages', auth: true },
            { method: 'GET', path: config.prefix + '/sessions/:id/stream', auth: true, note: 'SSE' },
            { method: 'GET', path: config.prefix + '/sessions/:id/history', auth: true },
            { method: 'POST', path: config.prefix + '/sessions/:id/cancel', auth: true },
          ],
        })
      }

      if (seg.length === 1 && seg[0] === 'key' && req.method === 'POST') {
        if (apiKey !== null && !authorized(req)) return sendJson(res, 401, { error: 'unauthorized' })
        if (apiKey === null) {
          if (!config.allowKeyProvision) return sendJson(res, 403, { error: 'key provisioning disabled; use config.apiKeys' })
          apiKey = randomToken('apigw-', 32)
          ctx.logger?.info?.(`[api-gateway] API key provisioned: ${apiKey}`)
        }
        return sendJson(res, 200, { apiKey })
      }

      // Admin surface (X-Admin-Key): runtime master switch + key rotation.
      if (seg.length === 2 && seg[0] === 'admin' && seg[1] === 'enable' && req.method === 'POST') {
        if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin_unauthorized' })
        let body: Record<string, unknown> = {}
        try { body = await readBody(req) } catch (error) { return sendJson(res, 400, { error: errorDetail(error) }) }
        enabled = body.enabled === true
        if (!enabled) {
          for (const entry of apiSessions.values()) {
            for (const r of Array.from(entry.subscribers)) { try { r.end() } catch { /* noop */ } }
            entry.subscribers.clear()
            releasePump(entry)
          }
        }
        return sendJson(res, 200, { enabled, sessions: apiSessions.size })
      }
      if (seg.length === 2 && seg[0] === 'admin' && seg[1] === 'rotate-key' && req.method === 'POST') {
        if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin_unauthorized' })
        apiKey = randomToken('apigw-', 32)
        ctx.logger?.info?.(`[api-gateway] API key rotated: ${apiKey}`)
        return sendJson(res, 200, { apiKey })
      }

      if (seg.length === 1 && seg[0] === 'sessions' && req.method === 'POST') {
        if (!requireAuth(req, res)) return
        let body: Record<string, unknown> = {}
        try { body = await readBody(req) } catch (error) { return sendJson(res, 400, { error: errorDetail(error) }) }
        let entry: SessionEntry
        try {
          entry = await createSession(body)
        } catch (error) {
          ctx.logger?.warn?.(`[api-gateway] session creation failed: ${String(error)}`)
          const payload: Record<string, unknown> = { error: 'session_creation_failed', detail: errorDetail(error) }
          const workspaces = (error as { workspaces?: unknown[] }).workspaces
          if (Array.isArray(workspaces)) payload.workspaces = workspaces
          return sendJson(res, 400, payload)
        }
        return sendJson(res, 201, {
          sessionId: entry.agent.id,
          status: entry.agent.status,
          provider: entry.agent.options.provider,
          model: entry.agent.options.model,
          cwd: entry.agent.session.header.cwd,
          workspace: entry.workspace,
        })
      }

      if (seg.length === 2 && seg[0] === 'sessions' && seg[1] === 'discover' && req.method === 'GET') {
        if (!requireAuth(req, res)) return
        if (!config.allowDiscover) return sendJson(res, 403, { error: 'discover_disabled' })
        if (sessionQuery?.listSessions === undefined) return sendJson(res, 501, { error: 'discover_unavailable' })
        let records: unknown[] = []
        try { records = await sessionQuery.listSessions() } catch (error) {
          return sendJson(res, 500, { error: 'discover_failed', detail: errorDetail(error) })
        }
        const sessions = records.map((record) => {
          const r = record as { header?: unknown; live?: boolean; persisted?: boolean } | null
          const header = mapHeader(r?.header)
          return { sessionId: header.id, title: header.title, cwd: header.cwd, live: r?.live === true, persisted: r?.persisted === true }
        })
        return sendJson(res, 200, { sessions })
      }

      if (seg.length === 3 && seg[0] === 'sessions' && seg[2] === 'adopt' && req.method === 'POST') {
        if (!requireAuth(req, res)) return
        if (!config.allowAdopt) return sendJson(res, 403, { error: 'adopt_disabled' })
        let result
        try {
          result = await adoptSession(seg[1])
        } catch (error) {
          return sendJson(res, 400, { error: 'adopt_failed', detail: errorDetail(error) })
        }
        const { entry, mode, snapshot } = result as { entry: SessionEntry; mode: SessionEntry['mode']; snapshot: { session: unknown; events: unknown[] } | null }
        return sendJson(res, 200, {
          sessionId: seg[1],
          mode,
          status: entry.agent.status,
          provider: entry.agent.options.provider,
          model: entry.agent.options.model,
          cwd: entry.agent.session.header.cwd,
          workspace: entry.workspace,
          history: mappedHistory(snapshot),
        })
      }

      if (seg.length === 3 && seg[0] === 'sessions' && req.method === 'GET' && (seg[2] === 'history' || seg[2] === 'stream')) {
        if (!requireAuth(req, res)) return
        const entry = apiSessions.get(seg[1])
        if (seg[2] === 'history') {
          const snapshot = await readSessionSnapshot(seg[1])
          if (snapshot === null) return sendJson(res, 404, { error: 'session_not_found' })
          return sendJson(res, 200, {
            sessionId: seg[1],
            adopted: entry !== undefined,
            header: mapHeader(snapshot.session),
            workspace: entry !== undefined ? entry.workspace : null,
            events: mappedHistory(snapshot),
          })
        }
        if (entry === undefined) return sendJson(res, 404, { error: 'session_not_found', hint: `adopt the session first: POST ${config.prefix}/sessions/:id/adopt` })
        // hello replays the durable history (live-preferred), falling back to
        // the in-memory tail captured while streaming.
        const snapshot = await readSessionSnapshot(seg[1])
        const helloLog = snapshot !== null ? mappedHistory(snapshot) : entry.log
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write('retry: 2000\n')
        res.write(sseFrame({ kind: 'hello', seq: 0, sessionId: seg[1], status: entry.agent.status, mode: entry.mode, workspace: entry.workspace, log: helloLog } as unknown as GatewayEvent))
        entry.subscribers.add(res)
        req.on('close', () => {
          entry.subscribers.delete(res)
          if (entry.subscribers.size === 0) releasePump(entry)
        })
        ensurePump(entry)
        return
      }

      if (seg.length === 3 && seg[0] === 'sessions' && seg[2] === 'messages' && req.method === 'POST') {
        if (!requireAuth(req, res)) return
        const entry = apiSessions.get(seg[1])
        if (entry === undefined) return sendJson(res, 404, { error: 'session_not_found', hint: `adopt the session first: POST ${config.prefix}/sessions/:id/adopt` })
        let body: Record<string, unknown> = {}
        try { body = await readBody(req) } catch (error) { return sendJson(res, 400, { error: errorDetail(error) }) }
        let content: unknown[] | null = null
        if (typeof body.content === 'string' && body.content !== '') content = [{ type: 'text', text: body.content }]
        else if (Array.isArray(body.content) && body.content.length > 0) content = body.content as unknown[]
        if (content === null) return sendJson(res, 400, { error: 'content must be a non-empty string or a non-empty array of content blocks' })
        const message = createUserMessage({ content: content as never, source: { kind: 'user' } })
        try {
          entry.agent.followup(message)
        } catch (error) {
          return sendJson(res, 500, { error: 'delivery_failed', detail: errorDetail(error) })
        }
        return sendJson(res, 202, { ok: true, sessionId: seg[1], messageId: message.id, status: entry.agent.status })
      }

      if (seg.length === 3 && seg[0] === 'sessions' && seg[2] === 'cancel' && req.method === 'POST') {
        if (!requireAuth(req, res)) return
        const entry = apiSessions.get(seg[1])
        if (entry === undefined) return sendJson(res, 404, { error: 'session_not_found', hint: `adopt the session first: POST ${config.prefix}/sessions/:id/adopt` })
        entry.agent.cancel({ kind: 'user' })
        return sendJson(res, 200, { ok: true, sessionId: seg[1] })
      }

      return sendJson(res, 404, { error: 'not_found' })
    }

    ctx.on('session/event', onSessionEvent)

    ctx.effect(() => {
      const route: WebRoute = {
        kind: 'prefix',
        path: config.prefix,
        handler: (req, res) => {
          Promise.resolve(dispatch(req, res)).catch((error) => {
            ctx.logger?.warn?.(`[api-gateway] request failed: ${String(error)}`)
            try {
              if (res.headersSent) res.destroy()
              else sendJson(res, 500, { error: 'internal_error', detail: errorDetail(error) })
            } catch { /* noop */ }
          })
        },
      }
      const disposeRoute = webServer.register(route)
      return () => {
        try { disposeRoute() } catch { /* noop */ }
        for (const entry of apiSessions.values()) {
          releasePump(entry)
          for (const r of Array.from(entry.subscribers)) { try { r.end() } catch { /* noop */ } }
          entry.subscribers.clear()
          if (entry.owned) {
            try { entry.agent.cancel({ kind: 'disposed' }) } catch { /* noop */ }
            try { Promise.resolve(entry.dispose()).catch(() => {}) } catch { /* noop */ }
          }
        }
        apiSessions.clear()
      }
    })

    ctx.logger?.info?.(`[api-gateway] mounted at ${config.prefix} (enabled=${String(enabled)})`)
  },
}
