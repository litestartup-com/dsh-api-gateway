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
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
// Value import, not type-only: it also carries the `ctx.userQuestions`
// augmentation, and the gateway constructs the service inside its own scope.
import { UserQuestionError, UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import { eventPayload, mapEvents, normalizeUsage, sseFrame, sumUsage, type GatewayEvent, type TokenUsageJson } from './events.js'
import { decodeBody, mapHeader, provisionDecision, resolveCorsOrigin, routeSegments } from './http.js'

/** Single source of truth for the version advertised by the service index. */
const VERSION: string = (() => {
  try { return String((createRequire(import.meta.url)('../package.json') as { version?: unknown }).version ?? '0.0.0') }
  catch { return '0.0.0' }
})()

export interface Config {
  /** Route prefix. Defaults to /api-gw/v1. */
  prefix: string
  /** Master switch; also toggleable at runtime through the admin endpoint. */
  enabled: boolean
  /** Static API keys accepted by the gateway (in addition to the provisioned key). */
  apiKeys: string[]
  /**
   * The key minted by `POST {prefix}/key`, persisted through the settings scope.
   *
   * Written by the gateway, not by hand -- `apiKeys` is the field to edit. It is
   * stored rather than kept in memory so that the bootstrap is one-time *ever*:
   * the key a client was given keeps working across restarts, and the
   * unauthenticated mint closes permanently instead of reopening on each boot.
   */
  provisionedKey?: string
  /** Allow the one-time `POST {prefix}/key` bootstrap when no key exists at all. */
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
  /**
   * What happens when an agent this gateway drives asks an interactive question.
   *
   * - `conversation` (default) -- the question is handed back to the model with
   *   instructions to ask in the reply and end the turn. An API client answers
   *   it as an ordinary next message, so the turn closes on time and its cost
   *   and duration stay meaningful.
   * - `host` -- leave the question to whatever the deployment provides, i.e. the
   *   Web GUI. Correct only when someone is actually watching that GUI: with no
   *   answerer the turn blocks until it is cancelled.
   *
   * Approvals are deliberately NOT covered here. A question is the model's own
   * choice and can be re-asked as text; an approval is raised by the runtime
   * mid-tool-call, so there is nothing to reword and no way to defer it.
   */
  questionMode: 'conversation' | 'host'
  /** SSE heartbeat interval in ms; 0 disables. */
  sseHeartbeatMs: number
  /** Request body read timeout in ms. */
  bodyTimeoutMs: number
}

export const Config = z.object({
  prefix: z.string().default('/api-gw/v1'),
  enabled: z.boolean().default(true),
  apiKeys: z.array(z.string().role('secret')).default([]),
  provisionedKey: z.string().role('secret'),
  allowKeyProvision: z.boolean().default(true),
  adminKey: z.string().role('secret'),
  maxSessions: z.natural().default(20),
  workspaceMode: z.union([z.const('auto'), z.const('ungrouped')]).default('auto'),
  defaultWorkspacePath: z.string(),
  allowDiscover: z.boolean().default(true),
  allowAdopt: z.boolean().default(true),
  corsOrigin: z.union([z.string(), z.array(z.string())]).default('*'),
  exposeErrors: z.boolean().default(true),
  questionMode: z.union([z.const('conversation'), z.const('host')]).default('conversation'),
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
  /** Steps of the turn in flight, summed for the `gateway/turn-end` total; reset at every turn end. */
  turnUsage: TokenUsageJson | null
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

/**
 * Structural faces for host services this plugin consumes but whose rich
 * types are not exported on the public `Context` surface. `inject` still
 * declares the hard dependencies for the Cordis runtime; these local types
 * only make the compiler check our usage instead of `any`.
 */
interface AgentLoopLike {
  readonly config: { agents?: Array<{ provider?: string; model?: string }> }
  createAgent(ctx: Context, options: {
    sessionId: string
    agentOptions?: unknown
    meta?: { cwd?: string }
    setup?: (agentCtx: Context) => Promise<void> | void
  }): Promise<{ agent: AgentLike; dispose: () => Promise<void> | void }>
  resume(ctx: Context, options: { resumeSessionId: string }): Promise<{ agent: AgentLike; dispose?: () => Promise<void> | void }>
}
interface TimerLike {
  timeout(callback: () => void, delay: number): () => void
  interval(callback: () => void, delay: number): () => void
}

export default {
  inject: ['webServer', 'agentLoop', 'timer'],
  Config,
  apply(ctx: Context, config: Config) {
    const webServer = ctx.webServer
    const agentLoop = ctx.get('agentLoop') as AgentLoopLike
    const timer = ctx.get('timer') as TimerLike | undefined
    const sessionQuery = ctx.get('sessionQuery') as { readSession?: (id: string) => Promise<unknown>; listSessions?: () => Promise<unknown[]> } | undefined
    const agentsService = ctx.get('agents') as { get?: (id: string) => unknown } | undefined

    // Mutable runtime config: seeded from the composition row, then re-applied
    // live from the settings namespace (settings integration) below.
    let cfg = config
    let settingsScope: { update: (patch: object) => Promise<void> } | null = null
    /**
     * Fallback home for a minted key when there is no settings provider to
     * persist it in. A deployment without one cannot make the key durable, so it
     * keeps the old in-memory behaviour and says so in the log; everywhere else
     * `cfg.provisionedKey` is the real storage.
     */
    let volatileKey: string | null = null
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
      return cfg.exposeErrors ? message : 'internal error (set exposeErrors: true for details)'
    }

    /** Emit a gateway event on the Cordis bus for other host plugins. Never throws into the gateway. */
    const emitGatewayEvent = (name: string, payload: Record<string, unknown>) => {
      try { (ctx as any).events?.emit?.(name, payload) } catch { /* listeners never break the gateway */ }
    }

    /**
     * `Access-Control-Allow-Origin` carries a single value, so an allow-list is
     * matched against the request Origin and echoed (with `Vary: Origin`); a
     * disallowed requester gets no header at all.
     */
    const setCors = (res: ServerResponse, req?: IncomingMessage) => {
      const requestOrigin = typeof req?.headers?.origin === 'string' ? req.headers.origin : undefined
      const { origin, vary } = resolveCorsOrigin(cfg.corsOrigin, requestOrigin)
      if (origin !== null) res.setHeader('Access-Control-Allow-Origin', origin)
      if (vary) res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-api-key, x-admin-key')
      res.setHeader('Access-Control-Max-Age', '600')
    }

    const sendJson = (res: ServerResponse, status: number, obj: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }

    const readBody = (req: IncomingMessage) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const stopTimer = timer !== undefined ? timer.timeout(() => {
        if (settled) return
        settled = true
        ctx.logger?.debug?.(`[dsh-api-gw] body read timed out after ${cfg.bodyTimeoutMs}ms`)
        reject(new Error('body read timeout'))
        try { req.destroy() } catch { /* noop */ }
      }, cfg.bodyTimeoutMs) : (() => {})
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
        const text = decodeBody(Buffer.concat(chunks), req.headers['content-type'])
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

    /** Every key the deployment currently honours, from all three sources. */
    const acceptedKeys = () => {
      const keys = cfg.apiKeys.filter((key) => key !== '')
      if (cfg.provisionedKey !== undefined && cfg.provisionedKey !== '') keys.push(cfg.provisionedKey)
      if (volatileKey !== null) keys.push(volatileKey)
      return keys
    }

    const keyAccepted = (candidate: string | null) => {
      if (candidate === null || candidate === '') return false
      // Every candidate is compared against every key rather than short-circuiting
      // on the first match, so the work does not depend on which key was supplied.
      let matched = false
      for (const key of acceptedKeys()) if (safeEqual(candidate, key)) matched = true
      return matched
    }

    const authorized = (req: IncomingMessage) => {
      const xKey = req.headers['x-api-key']
      return keyAccepted(bearerToken(req)) || keyAccepted(typeof xKey === 'string' ? xKey : null)
    }

    const isAdmin = (req: IncomingMessage) => {
      if (cfg.adminKey === undefined || cfg.adminKey === '') return false
      const supplied = req.headers['x-admin-key']
      return typeof supplied === 'string' && safeEqual(supplied, cfg.adminKey)
    }

    const requireAuth = (req: IncomingMessage, res: ServerResponse) => {
      if (authorized(req)) return true
      sendJson(res, 401, { error: 'unauthorized', hint: `Provide X-API-Key. POST ${cfg.prefix}/key provisions a key (first call only).` })
      return false
    }

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
        ctx.logger?.warn?.(`[dsh-api-gw] session ${entry.agent.id} turn errored: ${(payload as any).detail?.message ?? 'unknown'}`)
      }
      writeToSubscribers(entry, sseFrame(payload))
      if (payload.kind === 'message') {
        const usage = normalizeUsage(payload.usage)
        entry.turnUsage = sumUsage(entry.turnUsage, usage)
        emitGatewayEvent('gateway/message', { sessionId: entry.agent.id, messageId: payload.messageId ?? null, text: payload.text ?? '', usage })
      }
      if (payload.kind === 'turn_end') {
        const usage = entry.turnUsage
        entry.turnUsage = null
        emitGatewayEvent('gateway/turn-end', {
          sessionId: entry.agent.id,
          turn: payload.turn ?? null,
          reason: payload.reason,
          detail: payload.detail ?? null,
          usage,
          provider: entry.agent.options.provider ?? null,
          model: entry.agent.options.model ?? null,
        })
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
      if (cfg.sseHeartbeatMs > 0 && entry.subscribers.size > 0 && Date.now() - entry.lastBeat >= cfg.sseHeartbeatMs) {
        writeToSubscribers(entry, ': ping\n\n')
        entry.lastBeat = Date.now()
      }
    }

    const ensurePump = (entry: SessionEntry) => {
      if (entry.pollerDispose !== null || timer === undefined) return
      entry.lastBeat = Date.now()
      entry.pollerDispose = timer.interval(() => pollEntry(entry), 400)
    }

    const releasePump = (entry: SessionEntry) => {
      if (entry.pollerDispose === null) return
      try { entry.pollerDispose() } catch { /* noop */ }
      entry.pollerDispose = null
    }

    /**
     * Hand back one session's runtime footprint: subscribers, poll timer, the
     * agent when this gateway owns it, and the `maxSessions` slot.
     *
     * `owned` decides whether the agent is disposed. A `live` entry is a GUI
     * session this gateway only co-drives, so releasing it must stop tracking
     * and nothing more -- disposing it would kill a session the user still has
     * open in front of them.
     *
     * The durable session log is untouched either way: it lives in
     * `sessionQuery`, so `GET /sessions/:id/history` keeps answering and
     * `adopt` can bring the session back. Releasing frees a slot; it does not
     * destroy a conversation.
     *
     * Emits nothing on its own -- the caller decides, so plugin teardown stays
     * silent while an explicit DELETE announces itself on the bus.
     */
    const releaseSession = (sessionId: string, entry: SessionEntry): { disposed: boolean } => {
      releasePump(entry)
      for (const res of Array.from(entry.subscribers)) { try { res.end() } catch { /* noop */ } }
      entry.subscribers.clear()
      if (entry.owned) {
        // Cancelled before disposal: a turn may still be in flight, and
        // disposing alone would leave it burning tokens against a session no
        // subscriber is left to read.
        try { entry.agent.cancel({ kind: 'disposed' }) } catch { /* noop */ }
        try { Promise.resolve(entry.dispose()).catch(() => {}) } catch { /* noop */ }
      }
      apiSessions.delete(sessionId)
      return { disposed: entry.owned }
    }

    // Path A: live session/event listener; the pump (Path B) guarantees
    // delivery even when the scoped dispatch does not reach this context.
    const onSessionEvent = (session: Session, event: SessionEvent) => {
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

    // ---- interactive questions ----

    /**
     * What the model is told when it reaches for an interactive question card.
     *
     * It is written AT the model, because that is who receives it: the tool
     * reports a failed call, and this text is the whole of what the model has to
     * go on. So it does not merely refuse -- it names the alternative, which is
     * the one thing a bare refusal would leave the model to guess.
     */
    const NO_ANSWERER_HINT = [
      'This session is driven remotely through the API gateway, so nobody can see or click an interactive question card here.',
      'Ask in the conversation instead: put the question and its options in your reply, end the turn, and read the human\'s next message as the answer.',
    ].join(' ')

    /**
     * A scope whose `userQuestions` provider hands the question back to the model.
     *
     * Why a scope at all: the service holds exactly ONE provider in an instance
     * field and throws DUPLICATE_PROVIDER on a second registration, so the
     * gateway cannot register alongside a deployment whose GUI already owns that
     * slot -- and must not, since stealing the slot would send GUI users'
     * question cards to an HTTP client instead. `ctx.isolate()` gives the
     * gateway a private slot; the host's is left exactly as it was
     * (test/questions.test.mjs pins both halves of that claim).
     *
     * Why one scope for the whole plugin rather than one per session: the
     * provider is stateless -- it never collects an answer -- so a per-session
     * scope would accumulate a service instance and a closure per session for
     * the life of the plugin, and buy nothing.
     */
    let questionScope: Context | null = null
    let questionScopeFailed = false
    const downgradingScope = (): Context | null => {
      if (questionScope !== null) return questionScope
      // Attempted once. A deployment that cannot give us the scope will not
      // start giving us one on the next request, and retrying per session would
      // log the same failure forever.
      if (questionScopeFailed) return null
      try {
        const scope = ctx.isolate('userQuestions')
        new UserQuestionService(scope)
        scope.userQuestions.registerProvider({
          ask: async (request) => {
            ctx.logger?.debug?.(`[dsh-api-gw] question downgraded to conversation (${request.questions.length} question(s))`)
            // Thrown, not answered: a fabricated answer would put words in the
            // human's mouth, and any real answer here would be a lie about who
            // was asked. The tool turns this into a failed call, which is how
            // the hint reaches the model.
            throw new UserQuestionError(NO_ANSWERER_HINT, 'NO_INTERACTIVE_ANSWERER')
          },
        })
        questionScope = scope
        return scope
      } catch (error) {
        // Non-fatal by design: this is a safeguard against a hang, not a
        // prerequisite for talking to an agent. A Harness too old to provide
        // the service, or one that refuses the scope, must still get sessions.
        questionScopeFailed = true
        ctx.logger?.warn?.(`[dsh-api-gw] questionMode 'conversation' unavailable, leaving questions to the host: ${String(error)}`)
        return null
      }
    }

    /**
     * The context that owns agents this gateway creates or resumes.
     *
     * Read per session rather than once, so flipping `questionMode` at runtime
     * applies to new sessions; sessions already running keep the scope their
     * agent was built in, because an agent cannot be moved between scopes.
     */
    const agentContext = (): Context => {
      if (cfg.questionMode !== 'conversation') return ctx
      return downgradingScope() ?? ctx
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
     * Bound an async operation: resolve to `fallback` when it is slow or
     * wedged, so a hung service (storage, filesystem) can never block session
     * creation. The losing operation still runs to completion in the
     * background — its timer is cleared once the race settles.
     */
    const bounded = async <T>(op: Promise<T>, fallback: T, ms: number): Promise<T> => {
      let handle: ReturnType<typeof setTimeout> | null = null
      try {
        return await Promise.race([
          op,
          new Promise<T>((resolve) => { handle = setTimeout(() => resolve(fallback), ms) }),
        ])
      } finally {
        if (handle !== null) clearTimeout(handle)
      }
    }

    /** Like `bounded`, but a slow operation rejects instead of resolving to a fallback. */
    const boundedOrThrow = async <T>(op: Promise<T>, ms: number, label: string): Promise<T> => {
      let handle: ReturnType<typeof setTimeout> | null = null
      try {
        return await Promise.race([
          op,
          new Promise<never>((_, reject) => { handle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) }),
        ])
      } finally {
        if (handle !== null) clearTimeout(handle)
      }
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
      const resolveOrCreate = async (path: string, title?: string): Promise<WorkspaceHandle | null> => {
        const existing = await bounded(registry.resolveByPath(path), undefined, 5_000)
        if (existing !== undefined) return existing
        const created = await bounded(registry.create(path, title), undefined, 5_000)
        return created ?? null
      }
      if (ws !== undefined && ws !== null) {
        if (typeof ws === 'string' && ws !== '') {
          return resolveOrCreate(ws)
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
            return resolveOrCreate(w.path, title)
          }
        }
        throw new Error('workspace must be a path string, { path, title? }, or { id }')
      }
      if (fallbackCwd === undefined) return null
      return resolveOrCreate(fallbackCwd)
    }

    /**
     * Read-only workspace lookup for adopted sessions: report the membership a
     * session already has (header cwd == workspace path), never create one —
     * adoption observes an existing session, it must not mutate the sidebar.
     */
    const lookupWorkspace = async (cwd: string | undefined): Promise<SessionEntry['workspace']> => {
      if (cwd === undefined || cwd === '') return null
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      if (registry === undefined) return null
      try {
        const found = await bounded(registry.resolveByPath(cwd), undefined, 5_000)
        return found === undefined ? null : { id: found.id, path: found.path, title: found.title }
      } catch { return null }
    }

    const makeEntry = (agent: AgentLike, owned: boolean, dispose: (() => Promise<void> | void) | null, mode: SessionEntry['mode'], workspace: SessionEntry['workspace']): SessionEntry => ({
      agent,
      turnUsage: null,
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
      if (apiSessions.size >= cfg.maxSessions) throw new Error(`session cap reached (${cfg.maxSessions})`)
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
      const effectiveCwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : (cfg.defaultWorkspacePath ?? resolveDefaultCwd())
      let workspace: WorkspaceHandle | null = null
      if (body.workspace !== undefined || cfg.workspaceMode !== 'ungrouped') {
        workspace = await resolveWorkspace(body.workspace, effectiveCwd)
      }
      const cwd = workspace !== null ? workspace.path : effectiveCwd
      const sessionId = randomToken('apigw-session-', 20)

      // Proper ownership: the plugin fiber owns every created agent, so a
      // plugin stop or update tears each session down cleanly.
      const handle = await boundedOrThrow(agentLoop.createAgent(agentContext(), {
        sessionId,
        agentOptions: options,
        ...(cwd === undefined ? {} : { meta: { cwd } }),
        // Mount the deployment's default agent preset so API sessions get the
        // same tools and skills as GUI sessions. Non-fatal by design.
        //
        // Fire-and-forget: mounting must NOT block session creation. rc.7's
        // default preset is far larger than rc.6's, and `await`ing the mount
        // here made POST /sessions hang with no timeout whenever the mount was
        // slow or wedged. The mount still runs in the background; a failure is
        // logged, never thrown into the session.
        setup: async (agentCtx: Context) => {
          const presets = agentCtx.get('agentPresets') as { mount?: (c: Context, id?: string) => Promise<unknown> } | undefined
          if (presets?.mount !== undefined) {
            presets.mount(agentCtx).catch((error) => {
              ctx.logger?.warn?.(`[dsh-api-gw] preset mount failed for ${sessionId}: ${String(error)}`)
            })
          }
        },
      }), 20_000, 'agent creation')

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

    const readSessionSnapshot = async (sessionId: string): Promise<{ session: unknown; events: unknown[] } | null> => {
      if (sessionQuery?.readSession === undefined) return null
      try {
        const snapshot = await sessionQuery.readSession(sessionId)
        if (snapshot === null || typeof snapshot !== 'object') return null
        const s = snapshot as { session?: unknown; events?: unknown[] }
        return { session: s.session ?? null, events: Array.isArray(s.events) ? s.events : [] }
      } catch { return null }
    }

    const mappedHistory = (snapshot: { session: unknown; events: unknown[] } | null) =>
      snapshot === null ? [] : mapEvents(snapshot.events)

    const adoptSession = async (sessionId: string): Promise<{ entry: SessionEntry; mode: SessionEntry['mode']; snapshot: { session: unknown; events: unknown[] } | null }> => {
      const existing = apiSessions.get(sessionId)
      if (existing !== undefined) {
        return { entry: existing, mode: existing.mode, snapshot: await readSessionSnapshot(sessionId) }
      }
      if (apiSessions.size >= cfg.maxSessions) throw new Error(`session cap reached (${cfg.maxSessions})`)

      let liveAgent: unknown
      try { liveAgent = agentsService?.get?.(sessionId) } catch { liveAgent = undefined }

      const snapshot = await readSessionSnapshot(sessionId)

      if (liveAgent !== undefined && liveAgent !== null) {
        const agent = liveAgent as AgentLike
        const workspace = await lookupWorkspace(agent.session.header.cwd)
        const entry = makeEntry(agent, false, null, 'live', workspace)
        apiSessions.set(sessionId, entry)
        emitGatewayEvent('gateway/session-created', { sessionId, mode: 'live', workspace, cwd: agent.session.header.cwd ?? null })
        return { entry, mode: 'live', snapshot }
      }

      if (snapshot === null) throw new Error('session_not_found')
      let handle: { agent?: unknown; dispose?: () => Promise<void> | void }
      try {
        // Same scope as a created session: a resumed agent is equally ours to
        // drive, and equally has no human at a GUI.
        handle = await agentLoop.resume(agentContext(), { resumeSessionId: sessionId }) as { agent?: unknown; dispose?: () => Promise<void> | void }
      } catch (error) {
        throw new Error(`resume_failed: ${String((error as Error).message ?? error)}`)
      }
      const agent = handle.agent as AgentLike
      const workspace = await lookupWorkspace(agent.session.header.cwd)
      const entry = makeEntry(agent, true, () => handle.dispose?.(), 'resumed', workspace)
      apiSessions.set(sessionId, entry)
      emitGatewayEvent('gateway/session-created', { sessionId, mode: 'resumed', workspace, cwd: agent.session.header.cwd ?? null })
      return { entry, mode: 'resumed', snapshot }
    }

    // ---- HTTP dispatch ----

    const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
      setCors(res, req)
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      const seg = routeSegments(cfg.prefix, req.url)
      if (seg === null) return sendJson(res, 404, { error: 'not_found', service: 'dsh-api-gw' })

      // health stays reachable while disabled, for monitoring
      if (seg.length === 1 && seg[0] === 'health' && req.method === 'GET') {
        return sendJson(res, 200, { status: cfg.enabled ? 'ok' : 'disabled', enabled: cfg.enabled, sessions: apiSessions.size, apiKeySet: acceptedKeys().length > 0 })
      }
      if (!cfg.enabled) return sendJson(res, 503, { error: 'service_disabled' })

      if (seg.length === 0 && req.method === 'GET') {
        return sendJson(res, 200, {
          service: 'dsh-api-gw', version: VERSION,
          endpoints: [
            { method: 'GET', path: cfg.prefix + '/health', auth: false },
            { method: 'POST', path: cfg.prefix + '/key', auth: 'first call only' },
            { method: 'POST', path: cfg.prefix + '/sessions', auth: true },
            { method: 'GET', path: cfg.prefix + '/sessions/discover', auth: true },
            { method: 'POST', path: cfg.prefix + '/sessions/:id/adopt', auth: true },
            { method: 'POST', path: cfg.prefix + '/sessions/:id/messages', auth: true },
            { method: 'GET', path: cfg.prefix + '/sessions/:id/stream', auth: true, note: 'SSE' },
            { method: 'GET', path: cfg.prefix + '/sessions/:id/history', auth: true },
            { method: 'POST', path: cfg.prefix + '/sessions/:id/cancel', auth: true },
            { method: 'DELETE', path: cfg.prefix + '/sessions/:id', auth: true, note: 'frees the slot; history retained' },
          ],
        })
      }

      /**
       * One-time bootstrap: mint the first key, then close for good.
       *
       * Unauthenticated *only* while the deployment has no key from any source --
       * the single moment when there is no credential that could be demanded. The
       * minted key is persisted before it is returned, so `provisionDecision`
       * refuses every later call, including after a restart. A caller that
       * already holds a key is refused too: it has nothing to learn here, and
       * echoing a stored secret back over an authenticated request is a way to
       * leak the *other* keys a deployment has.
       */
      if (seg.length === 1 && seg[0] === 'key' && req.method === 'POST') {
        const decision = provisionDecision({
          provisionedKey: cfg.provisionedKey,
          apiKeys: cfg.apiKeys,
          allowKeyProvision: cfg.allowKeyProvision,
          prefix: cfg.prefix,
        })
        if (decision.action === 'refuse') {
          return sendJson(res, decision.status, { error: decision.error, hint: decision.hint })
        }

        const minted = randomToken('apigw-', 32)
        if (settingsScope !== null) {
          try {
            await settingsScope.update({ provisionedKey: minted })
          } catch (error) {
            // Reported rather than returned: handing out a key that silently did
            // not persist is how the caller ends up with a credential that dies
            // at the next restart without anyone knowing why.
            return sendJson(res, 500, { error: 'settings_update_failed', detail: errorDetail(error) })
          }
          // The settings watcher refreshes `cfg` asynchronously; setting it here
          // means the key works on the very next request either way.
          cfg = { ...cfg, provisionedKey: minted }
        } else {
          volatileKey = minted
          ctx.logger?.warn?.('[dsh-api-gw] no settings provider: the provisioned key is in memory only and will not survive a restart. Set config.apiKeys for a durable key.')
        }
        // Never logged: the log is the one place a secret leaks without anyone
        // authenticating for it.
        ctx.logger?.info?.('[dsh-api-gw] API key provisioned (one-time bootstrap now closed)')
        return sendJson(res, 200, { apiKey: minted, persisted: settingsScope !== null })
      }

      // Admin surface (X-Admin-Key): runtime master switch + key rotation.
      if (seg.length === 2 && seg[0] === 'admin' && seg[1] === 'enable' && req.method === 'POST') {
        if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin_unauthorized' })
        let body: Record<string, unknown> = {}
        try { body = await readBody(req) } catch (error) { return sendJson(res, 400, { error: errorDetail(error) }) }
        const nextEnabled = body.enabled === true
        if (settingsScope !== null) {
          try { await settingsScope.update({ enabled: nextEnabled }) } catch (error) {
            return sendJson(res, 500, { error: 'settings_update_failed', detail: errorDetail(error) })
          }
        } else {
          cfg = { ...cfg, enabled: nextEnabled }
        }
        if (!cfg.enabled) {
          for (const entry of apiSessions.values()) {
            for (const r of Array.from(entry.subscribers)) { try { r.end() } catch { /* noop */ } }
            entry.subscribers.clear()
            releasePump(entry)
          }
        }
        return sendJson(res, 200, { enabled: cfg.enabled, sessions: apiSessions.size })
      }
      // Replaces the provisioned key only. `apiKeys` is the operator's own list
      // and rotating over it would silently revoke keys the gateway was never
      // asked to manage.
      if (seg.length === 2 && seg[0] === 'admin' && seg[1] === 'rotate-key' && req.method === 'POST') {
        if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin_unauthorized' })
        const minted = randomToken('apigw-', 32)
        if (settingsScope !== null) {
          try {
            await settingsScope.update({ provisionedKey: minted })
          } catch (error) {
            return sendJson(res, 500, { error: 'settings_update_failed', detail: errorDetail(error) })
          }
          cfg = { ...cfg, provisionedKey: minted }
        } else {
          volatileKey = minted
        }
        ctx.logger?.info?.('[dsh-api-gw] API key rotated')
        return sendJson(res, 200, { apiKey: minted, persisted: settingsScope !== null })
      }

      if (seg.length === 1 && seg[0] === 'sessions' && req.method === 'POST') {
        if (!requireAuth(req, res)) return
        let body: Record<string, unknown> = {}
        try { body = await readBody(req) } catch (error) { return sendJson(res, 400, { error: errorDetail(error) }) }
        let entry: SessionEntry
        try {
          entry = await createSession(body)
        } catch (error) {
          ctx.logger?.warn?.(`[dsh-api-gw] session creation failed: ${String(error)}`)
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
        if (!cfg.allowDiscover) return sendJson(res, 403, { error: 'discover_disabled' })
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
        if (!cfg.allowAdopt) return sendJson(res, 403, { error: 'adopt_disabled' })
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
        if (entry === undefined) return sendJson(res, 404, { error: 'session_not_found', hint: `adopt the session first: POST ${cfg.prefix}/sessions/:id/adopt` })
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
        if (entry === undefined) return sendJson(res, 404, { error: 'session_not_found', hint: `adopt the session first: POST ${cfg.prefix}/sessions/:id/adopt` })
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
        if (entry === undefined) return sendJson(res, 404, { error: 'session_not_found', hint: `adopt the session first: POST ${cfg.prefix}/sessions/:id/adopt` })
        entry.agent.cancel({ kind: 'user' })
        return sendJson(res, 200, { ok: true, sessionId: seg[1] })
      }

      // Release the slot this session holds against `maxSessions`.
      //
      // The addressed collection is this gateway's registry, not the harness
      // session store: POST /sessions adds an entry, this removes one. The
      // durable transcript is not part of that resource and survives, so
      // /history keeps answering and /adopt can take the session back.
      if (seg.length === 2 && seg[0] === 'sessions' && req.method === 'DELETE') {
        if (!requireAuth(req, res)) return
        const entry = apiSessions.get(seg[1])
        // Idempotent, deliberately unlike the 404 that /messages and /cancel
        // answer. A caller releases in its cleanup path, where "the slot is
        // already free" is the goal rather than a fault -- and after a gateway
        // restart every id a client remembers is already gone.
        if (entry === undefined) {
          return sendJson(res, 200, { ok: true, sessionId: seg[1], released: false, disposed: false, historyRetained: true })
        }
        const mode = entry.mode
        const { disposed } = releaseSession(seg[1], entry)
        emitGatewayEvent('gateway/session-released', { sessionId: seg[1], mode, disposed })
        return sendJson(res, 200, { ok: true, sessionId: seg[1], released: true, disposed, mode, historyRetained: true })
      }

      return sendJson(res, 404, { error: 'not_found' })
    }

    ctx.on('session/event', onSessionEvent)

    let disposeRoute: (() => void) | null = null
    const mountRoute = () => {
      if (disposeRoute !== null) { try { disposeRoute() } catch { /* noop */ } ; disposeRoute = null }
      const route: WebRoute = {
        kind: 'prefix',
        path: cfg.prefix,
        handler: (req, res) => {
          Promise.resolve(dispatch(req, res)).catch((error) => {
            ctx.logger?.warn?.(`[dsh-api-gw] request failed: ${String(error)}`)
            try {
              if (res.headersSent) res.destroy()
              else sendJson(res, 500, { error: 'internal_error', detail: errorDetail(error) })
            } catch { /* noop */ }
          })
        },
      }
      disposeRoute = webServer.register(route)
    }

    ctx.effect(() => {
      mountRoute()
      return () => {
        if (disposeRoute !== null) { try { disposeRoute() } catch { /* noop */ } ; disposeRoute = null }
        // Snapshotted: releaseSession deletes from the map it is iterating.
        for (const [sessionId, entry] of Array.from(apiSessions.entries())) releaseSession(sessionId, entry)
      }
    })

    // Settings integration: expose the gateway Config as a live settings
    // namespace so the browser card (`settings.plugin.item` keyed 'dsh-api-gw')
    // is served, and edits apply without a restart. Secret fields (adminKey /
    // apiKeys) are declared `role('secret')` in the schema, so the wire surface
    // redacts them. Non-fatal by design: a deployment without a settings
    // provider simply keeps the composition-row config.
    //
    // The namespace is 'dsh-api-gw': DSH ships a built-in
    // `@deepseek-ai/dsh-api-gateway` (the typert Remote dispatcher), so a card
    // keyed 'api-gateway' would be indistinguishable from it in the plugin list.
    ctx.inject(['settings'], (sctx) => {
      try {
        const scope = sctx.settings.register(settingsNamespace('dsh-api-gw'), Config, { base: config, applies: 'live' })
        settingsScope = scope
        const resolved = scope.get()
        const prefixChanged = resolved.prefix !== cfg.prefix
        cfg = resolved
        if (prefixChanged) mountRoute()
        scope.watch((next, prev) => {
          const changed = next.prefix !== prev.prefix
          cfg = next
          if (changed) mountRoute()
        })
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-api-gw] settings namespace not registered: ${String(error)}`)
      }
    })

    ctx.logger?.info?.(`[dsh-api-gw] mounted at ${cfg.prefix} (enabled=${String(cfg.enabled)})`)
  },
}
