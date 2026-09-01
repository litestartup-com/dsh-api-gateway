import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
// Value import, not type-only: it also carries the `ctx.userQuestions`
// augmentation, and the error class is thrown from the gateway's provider.
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import z from '@deepseek-ai/schemastery';
import { eventPayload, mapEvents, normalizeUsage, sseFrame, sumUsage } from './events.js';
import { decodeBody, mapHeader, provisionDecision, resolveCorsOrigin, routeSegments } from './http.js';
import { validateAnswers, wireQuestions } from './questions.js';
/** Single source of truth for the version advertised by the service index. */
const VERSION = (() => {
    try {
        return String(createRequire(import.meta.url)('../package.json').version ?? '0.0.0');
    }
    catch {
        return '0.0.0';
    }
})();
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
    questions: z.union([z.const('host'), z.const('gateway')]).default('host'),
    approvals: z.union([z.const('host'), z.const('gateway')]).default('host'),
    sseHeartbeatMs: z.natural().default(30_000),
    bodyTimeoutMs: z.natural().default(30_000),
});
export default {
    inject: ['webServer', 'agentLoop', 'timer'],
    Config,
    apply(ctx, config) {
        const webServer = ctx.webServer;
        const agentLoop = ctx.get('agentLoop');
        const timer = ctx.get('timer');
        const sessionQuery = ctx.get('sessionQuery');
        const agentsService = ctx.get('agents');
        // Mutable runtime config: seeded from the composition row, then re-applied
        // live from the settings namespace (settings integration) below.
        let cfg = config;
        let settingsScope = null;
        /**
         * Fallback home for a minted key when there is no settings provider to
         * persist it in. A deployment without one cannot make the key durable, so it
         * keeps the old in-memory behaviour and says so in the log; everywhere else
         * `cfg.provisionedKey` is the real storage.
         */
        let volatileKey = null;
        const apiSessions = new Map();
        // ---- primitives ----
        const randomToken = (prefix, length) => {
            const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
            let s = prefix;
            const pool = randomBytes(length * 2);
            let cursor = 0;
            while (s.length < prefix.length + length && cursor < pool.length) {
                const byte = pool[cursor++];
                // 252 = 7 * 36: rejecting >= 252 avoids modulo bias.
                if (byte < 252)
                    s += alphabet[byte % 36];
            }
            while (s.length < prefix.length + length)
                s += alphabet[randomBytes(1)[0] % 36];
            return s;
        };
        /** Constant-time string comparison (timing-attack resistant). */
        const safeEqual = (a, b) => {
            const ab = Buffer.from(a, 'utf8');
            const bb = Buffer.from(b, 'utf8');
            if (ab.length !== bb.length)
                return false;
            return timingSafeEqual(ab, bb);
        };
        const errorDetail = (error) => {
            const message = String(error?.message ?? error);
            return cfg.exposeErrors ? message : 'internal error (set exposeErrors: true for details)';
        };
        /** Emit a gateway event on the Cordis bus for other host plugins. Never throws into the gateway. */
        const emitGatewayEvent = (name, payload) => {
            try {
                ctx.events?.emit?.(name, payload);
            }
            catch { /* listeners never break the gateway */ }
        };
        /**
         * `Access-Control-Allow-Origin` carries a single value, so an allow-list is
         * matched against the request Origin and echoed (with `Vary: Origin`); a
         * disallowed requester gets no header at all.
         */
        const setCors = (res, req) => {
            const requestOrigin = typeof req?.headers?.origin === 'string' ? req.headers.origin : undefined;
            const { origin, vary } = resolveCorsOrigin(cfg.corsOrigin, requestOrigin);
            if (origin !== null)
                res.setHeader('Access-Control-Allow-Origin', origin);
            if (vary)
                res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-api-key, x-admin-key');
            res.setHeader('Access-Control-Max-Age', '600');
        };
        const sendJson = (res, status, obj) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(obj));
        };
        const readBody = (req) => new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            let settled = false;
            const stopTimer = timer !== undefined ? timer.timeout(() => {
                if (settled)
                    return;
                settled = true;
                ctx.logger?.debug?.(`[dsh-api-gw] body read timed out after ${cfg.bodyTimeoutMs}ms`);
                reject(new Error('body read timeout'));
                try {
                    req.destroy();
                }
                catch { /* noop */ }
            }, cfg.bodyTimeoutMs) : (() => { });
            const finish = (done) => {
                if (settled)
                    return;
                settled = true;
                stopTimer();
                done();
            };
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > 1_000_000) {
                    finish(() => reject(new Error('body too large')));
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                const text = decodeBody(Buffer.concat(chunks), req.headers['content-type']);
                if (text.trim() === '')
                    return finish(() => resolve({}));
                try {
                    finish(() => resolve(JSON.parse(text)));
                }
                catch {
                    finish(() => reject(new Error('invalid JSON body')));
                }
            });
            req.on('error', (error) => finish(() => reject(error)));
        });
        // ---- auth ----
        const bearerToken = (req) => {
            const header = req.headers['authorization'];
            if (typeof header !== 'string' || !header.startsWith('Bearer '))
                return null;
            return header.slice(7).trim();
        };
        /** Every key the deployment currently honours, from all three sources. */
        const acceptedKeys = () => {
            const keys = cfg.apiKeys.filter((key) => key !== '');
            if (cfg.provisionedKey !== undefined && cfg.provisionedKey !== '')
                keys.push(cfg.provisionedKey);
            if (volatileKey !== null)
                keys.push(volatileKey);
            return keys;
        };
        const keyAccepted = (candidate) => {
            if (candidate === null || candidate === '')
                return false;
            // Every candidate is compared against every key rather than short-circuiting
            // on the first match, so the work does not depend on which key was supplied.
            let matched = false;
            for (const key of acceptedKeys())
                if (safeEqual(candidate, key))
                    matched = true;
            return matched;
        };
        const authorized = (req) => {
            const xKey = req.headers['x-api-key'];
            return keyAccepted(bearerToken(req)) || keyAccepted(typeof xKey === 'string' ? xKey : null);
        };
        const isAdmin = (req) => {
            if (cfg.adminKey === undefined || cfg.adminKey === '')
                return false;
            const supplied = req.headers['x-admin-key'];
            return typeof supplied === 'string' && safeEqual(supplied, cfg.adminKey);
        };
        const requireAuth = (req, res) => {
            if (authorized(req))
                return true;
            sendJson(res, 401, { error: 'unauthorized', hint: `Provide X-API-Key. POST ${cfg.prefix}/key provisions a key (first call only).` });
            return false;
        };
        // ---- SSE fan-out + pump ----
        const writeToSubscribers = (entry, frame) => {
            for (const res of Array.from(entry.subscribers)) {
                try {
                    res.write(frame);
                }
                catch {
                    entry.subscribers.delete(res);
                }
            }
        };
        const deliver = (entry, payload) => {
            if (payload.seq === undefined || entry.delivered.has(payload.seq))
                return;
            entry.delivered.add(payload.seq);
            if (entry.delivered.size > 1000) {
                entry.delivered = new Set(entry.log.slice(-400).map((p) => p.seq));
                entry.delivered.add(payload.seq);
            }
            entry.log.push(payload);
            if (entry.log.length > 500)
                entry.log.splice(0, entry.log.length - 500);
            if (payload.kind === 'turn_end' && payload.reason === 'error') {
                ctx.logger?.warn?.(`[dsh-api-gw] session ${entry.agent.id} turn errored: ${payload.detail?.message ?? 'unknown'}`);
            }
            writeToSubscribers(entry, sseFrame(payload));
            if (payload.kind === 'message') {
                const usage = normalizeUsage(payload.usage);
                entry.turnUsage = sumUsage(entry.turnUsage, usage);
                emitGatewayEvent('gateway/message', { sessionId: entry.agent.id, messageId: payload.messageId ?? null, text: payload.text ?? '', usage });
            }
            if (payload.kind === 'turn_end') {
                const usage = entry.turnUsage;
                entry.turnUsage = null;
                emitGatewayEvent('gateway/turn-end', {
                    sessionId: entry.agent.id,
                    turn: payload.turn ?? null,
                    reason: payload.reason,
                    detail: payload.detail ?? null,
                    usage,
                    provider: entry.agent.options.provider ?? null,
                    model: entry.agent.options.model ?? null,
                });
                for (const res of Array.from(entry.subscribers)) {
                    try {
                        res.end();
                    }
                    catch { /* noop */ }
                }
                entry.subscribers.clear();
                releasePump(entry);
            }
        };
        /**
         * Poll the session log and forward mapped events. Doubles as the SSE
         * heartbeat source. Only runs while the entry has subscribers, so a quiet
         * session costs nothing.
         */
        const pollEntry = (entry) => {
            const log = entry.agent.session.log;
            for (let i = entry.pollFrom; i < log.length; i++) {
                const payload = eventPayload(log[i]);
                if (payload !== null)
                    deliver(entry, payload);
            }
            entry.pollFrom = log.length;
            if (cfg.sseHeartbeatMs > 0 && entry.subscribers.size > 0 && Date.now() - entry.lastBeat >= cfg.sseHeartbeatMs) {
                writeToSubscribers(entry, ': ping\n\n');
                entry.lastBeat = Date.now();
            }
        };
        const ensurePump = (entry) => {
            if (entry.pollerDispose !== null || timer === undefined)
                return;
            entry.lastBeat = Date.now();
            entry.pollerDispose = timer.interval(() => pollEntry(entry), 400);
        };
        const releasePump = (entry) => {
            if (entry.pollerDispose === null)
                return;
            try {
                entry.pollerDispose();
            }
            catch { /* noop */ }
            entry.pollerDispose = null;
        };
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
        const releaseSession = (sessionId, entry) => {
            releasePump(entry);
            // A question whose session is being released can never be answered, and the
            // tool call waiting on it would otherwise hold the turn open against a
            // session nobody is left to read.
            abandonQuestions(sessionId, `session ${sessionId} was released before the question was answered`);
            // Cancelled, which the approval vocabulary treats as a closed non-grant:
            // a decision nobody can make must never read as permission.
            abandonApprovals(sessionId);
            for (const res of Array.from(entry.subscribers)) {
                try {
                    res.end();
                }
                catch { /* noop */ }
            }
            entry.subscribers.clear();
            if (entry.owned) {
                // Cancelled before disposal: a turn may still be in flight, and
                // disposing alone would leave it burning tokens against a session no
                // subscriber is left to read.
                try {
                    entry.agent.cancel({ kind: 'disposed' });
                }
                catch { /* noop */ }
                try {
                    Promise.resolve(entry.dispose()).catch(() => { });
                }
                catch { /* noop */ }
            }
            apiSessions.delete(sessionId);
            return { disposed: entry.owned };
        };
        // Path A: live session/event listener; the pump (Path B) guarantees
        // delivery even when the scoped dispatch does not reach this context.
        const onSessionEvent = (session, event) => {
            const entry = apiSessions.get(session.id);
            if (entry === undefined)
                return;
            const payload = eventPayload(event);
            if (payload !== null)
                deliver(entry, payload);
        };
        // ---- session creation ----
        const resolveDefaultModel = () => {
            const defaults = ctx.get('agentDefaultModel');
            try {
                const sel = defaults?.currentSelection?.();
                if (sel && typeof sel.provider === 'string' && sel.provider !== '' && typeof sel.model === 'string' && sel.model !== '') {
                    return { provider: sel.provider, model: sel.model };
                }
            }
            catch { /* noop */ }
            const loopConfig = agentLoop.config;
            const first = loopConfig?.agents?.[0];
            if (first && typeof first.provider === 'string' && first.provider !== '' && typeof first.model === 'string' && first.model !== '') {
                return { provider: first.provider, model: first.model };
            }
            return null;
        };
        const resolveDefaultCwd = () => {
            const policy = ctx.get('sandboxPolicy');
            return typeof policy?.workspaceRoot === 'string' && policy.workspaceRoot !== '' ? policy.workspaceRoot : undefined;
        };
        const pendingQuestions = new Map();
        const pendingFor = (sessionId) => Array.from(pendingQuestions.values())
            .filter((pending) => pending.sessionId === sessionId)
            .map((pending) => ({ questionId: pending.id, askedAt: pending.askedAt, questions: pending.questions }));
        /**
         * A frame the gateway itself originates, rather than one mapped from the
         * session log.
         *
         * Carries NO `seq`, and that absence is deliberate rather than an omission:
         * an interactive question is a live negotiation, not an entry in the durable
         * transcript, so it has no position to report. A fabricated one would be
         * worse than none -- these frames bypass `deliver()` precisely because it
         * dedupes and journals BY seq, and a client replaying history (manager does)
         * drops anything whose seq it has already seen. A live question stamped 0
         * would be discarded by every such client.
         *
         * Recovery is `hello` instead, which carries whatever is still open.
         */
        const gatewayFrame = (kind, fields) => ({ kind, ...fields });
        /**
         * Take a pending question off the registry, then announce it is closed.
         *
         * Removal happens BEFORE the promise is settled so the first claimant wins:
         * two clients answering the same card, or an answer racing the turn's
         * cancellation, must produce exactly one resolution of the tool call.
         */
        const claimQuestion = (pending, outcome) => {
            pendingQuestions.delete(pending.id);
            pending.detachAbort();
            const entry = apiSessions.get(pending.sessionId);
            if (entry !== undefined) {
                writeToSubscribers(entry, sseFrame(gatewayFrame('question_resolved', { sessionId: pending.sessionId, questionId: pending.id, outcome })));
            }
        };
        /** Fail every question waiting on a session that is going away. */
        const abandonQuestions = (sessionId, why) => {
            for (const pending of Array.from(pendingQuestions.values())) {
                if (pending.sessionId !== sessionId)
                    continue;
                claimQuestion(pending, 'cancelled');
                pending.reject(new UserQuestionError(why, 'ASK_ABORTED'));
            }
        };
        /**
         * The gateway's own `userQuestions` provider: relay to clients, wait for one
         * to answer over HTTP.
         *
         * Nothing about the agent, the tool or the model changes -- `ask()` still
         * blocks the tool call until a human answers. The only thing that moves is
         * WHERE that human sits.
         */
        const askOverHttp = (request) => {
            const sessionId = typeof request.agent?.id === 'string' ? request.agent.id : undefined;
            if (sessionId === undefined) {
                return Promise.reject(new UserQuestionError('the API gateway routes questions per session, and this ask names no agent', 'ASK_MISSING_AGENT'));
            }
            const entry = apiSessions.get(sessionId);
            if (entry === undefined) {
                // Fails closed, and fast. Owning the slot means being asked on behalf of
                // sessions this gateway does not drive too -- a CLI run, another
                // plugin's agent. No client is listening for those, and a promise that
                // never settles is the exact hang this feature exists to remove.
                return Promise.reject(new UserQuestionError(`session ${sessionId} is not driven by the API gateway, so no client of it can answer`, 'ASK_NO_ANSWERER'));
            }
            const questions = wireQuestions(request.questions ?? []);
            if (questions.length === 0) {
                return Promise.reject(new UserQuestionError('no question survived wire mapping (each needs an id and question text)', 'EMPTY_QUESTIONS'));
            }
            return new Promise((resolve, reject) => {
                const id = randomToken('apigw-q-', 16);
                const signal = request.signal;
                const onAbort = () => {
                    const pending = pendingQuestions.get(id);
                    if (pending === undefined)
                        return;
                    claimQuestion(pending, 'cancelled');
                    reject(new UserQuestionError('ask_user_question was aborted before the human answered', 'ASK_ABORTED'));
                };
                pendingQuestions.set(id, {
                    id,
                    sessionId,
                    questions,
                    askedAt: Date.now(),
                    resolve,
                    reject,
                    detachAbort: () => { if (signal !== undefined)
                        signal.removeEventListener('abort', onAbort); },
                });
                signal?.addEventListener('abort', onAbort, { once: true });
                // Sent, not journalled: a client that is not connected right now picks
                // this up from `hello` when it reconnects.
                writeToSubscribers(entry, sseFrame(gatewayFrame('question_asked', { sessionId, questionId: id, questions })));
                emitGatewayEvent('gateway/question-asked', { sessionId, questionId: id, questions });
            });
        };
        /** Settled the first time a session is created or adopted; see `ensureQuestionOwnership`. */
        let questionOwnership = 'unknown';
        let disposeQuestionProvider = null;
        /**
         * Offer -- once -- to be the deployment's question provider.
         *
         * Called when the first session appears rather than at load, and that timing
         * IS the safety argument. The slot holds one provider and a second
         * `registerProvider` throws; the browser UI's backend
         * (`@deepseek-ai/dsh-host-apiproxy`) does not guard its own call, so a
         * gateway that won this race would not merely lose questions -- it would
         * fail that plugin's load and take the GUI down with it. By the time an HTTP
         * request has reached this code the whole host tree is up, so whoever wants
         * the slot already holds it and the loser here is always us.
         *
         * Standing down is therefore normal, not a fault: it means the deployment
         * has a GUI, and questions belong to it.
         */
        const ensureQuestionOwnership = () => {
            if (questionOwnership !== 'unknown')
                return;
            // Left 'unknown' on purpose: flipping the setting later must still get its
            // chance at the next session.
            if (cfg.questions !== 'gateway')
                return;
            const service = ctx.get('userQuestions');
            if (service?.registerProvider === undefined) {
                questionOwnership = 'host';
                ctx.logger?.warn?.('[dsh-api-gw] questions: "gateway" but this deployment provides no userQuestions service; leaving questions alone');
                return;
            }
            try {
                disposeQuestionProvider = service.registerProvider({ ask: (request) => askOverHttp(request) });
                questionOwnership = 'gateway';
                ctx.logger?.info?.(`[dsh-api-gw] answering ask_user_question over the API (question_asked frames; POST ${cfg.prefix}/sessions/:id/questions/:questionId/answer)`);
            }
            catch (error) {
                questionOwnership = 'host';
                ctx.logger?.warn?.(`[dsh-api-gw] questions stay with the host provider: ${String(error)}. Disable the @deepseek-ai/dsh-host-apiproxy row to free the slot (it is the browser UI's backend, not the HTTP carrier).`);
            }
        };
        const pendingApprovals = new Map();
        const approvalsFor = (sessionId) => Array.from(pendingApprovals.values())
            .filter((pending) => pending.sessionId === sessionId)
            .map((pending) => ({ decisionId: pending.id, toolName: pending.toolName, callId: pending.callId, reason: pending.reason, askedAt: pending.askedAt }));
        /** Same first-claimant discipline as questions: off the registry, then settled. */
        const claimApproval = (pending, outcome) => {
            pendingApprovals.delete(pending.id);
            pending.detachAbort();
            const entry = apiSessions.get(pending.sessionId);
            if (entry !== undefined) {
                writeToSubscribers(entry, sseFrame(gatewayFrame('approval_resolved', { sessionId: pending.sessionId, decisionId: pending.id, outcome })));
            }
            pending.settle(outcome);
        };
        const abandonApprovals = (sessionId) => {
            for (const pending of Array.from(pendingApprovals.values())) {
                if (pending.sessionId === sessionId)
                    claimApproval(pending, 'cancelled');
            }
        };
        // Cast rather than typed: the approval Events augmentation ships with
        // `@deepseek-ai/dsh-user-approval`, and depending on that package for one
        // event name would tie this plugin to a service it treats as optional.
        // Registered only where the service exists, so a deployment without
        // approvals is untouched.
        if (ctx.get('approval') !== undefined) {
            ctx.on('approval/request', (req, next) => {
                const sessionId = typeof req.agent?.id === 'string' ? req.agent.id : undefined;
                if (cfg.approvals !== 'gateway' || sessionId === undefined)
                    return next();
                const entry = apiSessions.get(sessionId);
                if (entry === undefined)
                    return next();
                if (req.signal?.aborted === true)
                    return Promise.resolve('cancelled');
                return new Promise((resolve) => {
                    const id = randomToken('apigw-ap-', 16);
                    const signal = req.signal;
                    const onAbort = () => {
                        const pending = pendingApprovals.get(id);
                        if (pending !== undefined)
                            claimApproval(pending, 'cancelled');
                    };
                    pendingApprovals.set(id, {
                        id,
                        sessionId,
                        toolName: typeof req.toolName === 'string' ? req.toolName : '',
                        callId: typeof req.callId === 'string' ? req.callId : null,
                        reason: typeof req.reason === 'string' ? req.reason : null,
                        askedAt: Date.now(),
                        settle: resolve,
                        detachAbort: () => { if (signal !== undefined)
                            signal.removeEventListener('abort', onAbort); },
                    });
                    signal?.addEventListener('abort', onAbort, { once: true });
                    writeToSubscribers(entry, sseFrame(gatewayFrame('approval_pending', {
                        sessionId,
                        decisionId: id,
                        toolName: typeof req.toolName === 'string' ? req.toolName : '',
                        callId: typeof req.callId === 'string' ? req.callId : null,
                        reason: typeof req.reason === 'string' ? req.reason : null,
                    })));
                    emitGatewayEvent('gateway/approval-pending', { sessionId, decisionId: id, toolName: req.toolName ?? '', callId: req.callId ?? null, reason: req.reason ?? null });
                });
            });
        }
        /**
         * Bound an async operation: resolve to `fallback` when it is slow or
         * wedged, so a hung service (storage, filesystem) can never block session
         * creation. The losing operation still runs to completion in the
         * background — its timer is cleared once the race settles.
         */
        const bounded = async (op, fallback, ms) => {
            let handle = null;
            try {
                return await Promise.race([
                    op,
                    new Promise((resolve) => { handle = setTimeout(() => resolve(fallback), ms); }),
                ]);
            }
            finally {
                if (handle !== null)
                    clearTimeout(handle);
            }
        };
        /** Like `bounded`, but a slow operation rejects instead of resolving to a fallback. */
        const boundedOrThrow = async (op, ms, label) => {
            let handle = null;
            try {
                return await Promise.race([
                    op,
                    new Promise((_, reject) => { handle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
                ]);
            }
            finally {
                if (handle !== null)
                    clearTimeout(handle);
            }
        };
        /**
         * Resolve the workspace a new session should join. Explicit request wins;
         * otherwise `auto` mode resolves-or-creates the effective cwd. The session
         * header cwd is later forced to the workspace canonical path so the durable
         * membership invariant (header cwd == workspace path) holds.
         */
        const resolveWorkspace = async (ws, fallbackCwd) => {
            const registry = ctx.get('workspaceRegistry');
            if (registry === undefined)
                return null;
            const resolveOrCreate = async (path, title) => {
                const existing = await bounded(registry.resolveByPath(path), undefined, 5_000);
                if (existing !== undefined)
                    return existing;
                const created = await bounded(registry.create(path, title), undefined, 5_000);
                return created ?? null;
            };
            if (ws !== undefined && ws !== null) {
                if (typeof ws === 'string' && ws !== '') {
                    return resolveOrCreate(ws);
                }
                if (typeof ws === 'object') {
                    const w = ws;
                    if (typeof w.id === 'string' && w.id !== '') {
                        const existing = registry.get(w.id);
                        if (existing === undefined) {
                            const err = new Error('workspace_not_found');
                            try {
                                err.workspaces = registry.list().map((x) => ({ id: x.id, title: x.title, path: x.path }));
                            }
                            catch {
                                err.workspaces = [];
                            }
                            throw err;
                        }
                        return existing;
                    }
                    if (typeof w.path === 'string' && w.path !== '') {
                        const title = typeof w.title === 'string' && w.title !== '' ? w.title : undefined;
                        return resolveOrCreate(w.path, title);
                    }
                }
                throw new Error('workspace must be a path string, { path, title? }, or { id }');
            }
            if (fallbackCwd === undefined)
                return null;
            return resolveOrCreate(fallbackCwd);
        };
        /**
         * Read-only workspace lookup for adopted sessions: report the membership a
         * session already has (header cwd == workspace path), never create one —
         * adoption observes an existing session, it must not mutate the sidebar.
         */
        const lookupWorkspace = async (cwd) => {
            if (cwd === undefined || cwd === '')
                return null;
            const registry = ctx.get('workspaceRegistry');
            if (registry === undefined)
                return null;
            try {
                const found = await bounded(registry.resolveByPath(cwd), undefined, 5_000);
                return found === undefined ? null : { id: found.id, path: found.path, title: found.title };
            }
            catch {
                return null;
            }
        };
        const makeEntry = (agent, owned, dispose, mode, workspace) => ({
            agent,
            turnUsage: null,
            dispose: dispose ?? (() => { }),
            subscribers: new Set(),
            log: [],
            delivered: new Set(),
            pollFrom: agent.session.log.length,
            pollerDispose: null,
            lastBeat: 0,
            workspace,
            owned,
            mode,
        });
        const createSession = async (body) => {
            if (apiSessions.size >= cfg.maxSessions)
                throw new Error(`session cap reached (${cfg.maxSessions})`);
            ensureQuestionOwnership();
            const options = {};
            if (typeof body.provider === 'string' && body.provider !== '')
                options.provider = body.provider;
            if (typeof body.model === 'string' && body.model !== '')
                options.model = body.model;
            if (typeof body.maxTokens === 'number' && Number.isSafeInteger(body.maxTokens) && body.maxTokens > 0)
                options.maxTokens = body.maxTokens;
            if (options.provider === undefined || options.model === undefined) {
                const fallback = resolveDefaultModel();
                if (fallback !== null) {
                    if (options.provider === undefined)
                        options.provider = fallback.provider;
                    if (options.model === undefined)
                        options.model = fallback.model;
                }
            }
            if (!options.provider || !options.model)
                throw new Error('no provider/model: supply both in the request body');
            const effectiveCwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : (cfg.defaultWorkspacePath ?? resolveDefaultCwd());
            let workspace = null;
            if (body.workspace !== undefined || cfg.workspaceMode !== 'ungrouped') {
                workspace = await resolveWorkspace(body.workspace, effectiveCwd);
            }
            const cwd = workspace !== null ? workspace.path : effectiveCwd;
            const sessionId = randomToken('apigw-session-', 20);
            // Proper ownership: the plugin fiber owns every created agent, so a
            // plugin stop or update tears each session down cleanly.
            const handle = await boundedOrThrow(agentLoop.createAgent(ctx, {
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
                setup: async (agentCtx) => {
                    const presets = agentCtx.get('agentPresets');
                    if (presets?.mount !== undefined) {
                        presets.mount(agentCtx).catch((error) => {
                            ctx.logger?.warn?.(`[dsh-api-gw] preset mount failed for ${sessionId}: ${String(error)}`);
                        });
                    }
                },
            }), 20_000, 'agent creation');
            const agent = handle.agent;
            if (workspace !== null) {
                try {
                    await workspace.attachSession(agent.id);
                }
                catch (error) {
                    try {
                        await handle.dispose();
                    }
                    catch { /* noop */ }
                    throw new Error(`workspace_attach_failed: ${String(error.message ?? error)}`);
                }
            }
            const workspaceInfo = workspace === null ? null : { id: workspace.id, path: workspace.path, title: workspace.title };
            const entry = makeEntry(agent, true, () => handle.dispose(), 'created', workspaceInfo);
            apiSessions.set(agent.id, entry);
            emitGatewayEvent('gateway/session-created', { sessionId: agent.id, mode: 'created', workspace: workspaceInfo, cwd: agent.session.header.cwd ?? null });
            return entry;
        };
        // ---- session discovery / history / adoption ----
        const readSessionSnapshot = async (sessionId) => {
            if (sessionQuery?.readSession === undefined)
                return null;
            try {
                const snapshot = await sessionQuery.readSession(sessionId);
                if (snapshot === null || typeof snapshot !== 'object')
                    return null;
                const s = snapshot;
                return { session: s.session ?? null, events: Array.isArray(s.events) ? s.events : [] };
            }
            catch {
                return null;
            }
        };
        const mappedHistory = (snapshot) => snapshot === null ? [] : mapEvents(snapshot.events);
        const adoptSession = async (sessionId) => {
            ensureQuestionOwnership();
            const existing = apiSessions.get(sessionId);
            if (existing !== undefined) {
                return { entry: existing, mode: existing.mode, snapshot: await readSessionSnapshot(sessionId) };
            }
            if (apiSessions.size >= cfg.maxSessions)
                throw new Error(`session cap reached (${cfg.maxSessions})`);
            let liveAgent;
            try {
                liveAgent = agentsService?.get?.(sessionId);
            }
            catch {
                liveAgent = undefined;
            }
            const snapshot = await readSessionSnapshot(sessionId);
            if (liveAgent !== undefined && liveAgent !== null) {
                const agent = liveAgent;
                const workspace = await lookupWorkspace(agent.session.header.cwd);
                const entry = makeEntry(agent, false, null, 'live', workspace);
                apiSessions.set(sessionId, entry);
                emitGatewayEvent('gateway/session-created', { sessionId, mode: 'live', workspace, cwd: agent.session.header.cwd ?? null });
                return { entry, mode: 'live', snapshot };
            }
            if (snapshot === null)
                throw new Error('session_not_found');
            let handle;
            try {
                handle = await agentLoop.resume(ctx, { resumeSessionId: sessionId });
            }
            catch (error) {
                throw new Error(`resume_failed: ${String(error.message ?? error)}`);
            }
            const agent = handle.agent;
            const workspace = await lookupWorkspace(agent.session.header.cwd);
            const entry = makeEntry(agent, true, () => handle.dispose?.(), 'resumed', workspace);
            apiSessions.set(sessionId, entry);
            emitGatewayEvent('gateway/session-created', { sessionId, mode: 'resumed', workspace, cwd: agent.session.header.cwd ?? null });
            return { entry, mode: 'resumed', snapshot };
        };
        // ---- HTTP dispatch ----
        const dispatch = async (req, res) => {
            setCors(res, req);
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }
            const seg = routeSegments(cfg.prefix, req.url);
            if (seg === null)
                return sendJson(res, 404, { error: 'not_found', service: 'dsh-api-gw' });
            // health stays reachable while disabled, for monitoring
            if (seg.length === 1 && seg[0] === 'health' && req.method === 'GET') {
                return sendJson(res, 200, { status: cfg.enabled ? 'ok' : 'disabled', enabled: cfg.enabled, sessions: apiSessions.size, apiKeySet: acceptedKeys().length > 0 });
            }
            if (!cfg.enabled)
                return sendJson(res, 503, { error: 'service_disabled' });
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
                        { method: 'GET', path: cfg.prefix + '/sessions/:id/questions', auth: true, note: 'questions awaiting an answer' },
                        { method: 'POST', path: cfg.prefix + '/sessions/:id/questions/:questionId/answer', auth: true },
                        { method: 'POST', path: cfg.prefix + '/sessions/:id/questions/:questionId/cancel', auth: true },
                        { method: 'GET', path: cfg.prefix + '/sessions/:id/approvals', auth: true, note: 'permission prompts awaiting a decision' },
                        { method: 'POST', path: cfg.prefix + '/sessions/:id/approvals/:decisionId/decide', auth: true },
                        { method: 'POST', path: cfg.prefix + '/sessions/:id/cancel', auth: true },
                        { method: 'DELETE', path: cfg.prefix + '/sessions/:id', auth: true, note: 'frees the slot; history retained' },
                    ],
                });
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
                });
                if (decision.action === 'refuse') {
                    return sendJson(res, decision.status, { error: decision.error, hint: decision.hint });
                }
                const minted = randomToken('apigw-', 32);
                if (settingsScope !== null) {
                    try {
                        await settingsScope.update({ provisionedKey: minted });
                    }
                    catch (error) {
                        // Reported rather than returned: handing out a key that silently did
                        // not persist is how the caller ends up with a credential that dies
                        // at the next restart without anyone knowing why.
                        return sendJson(res, 500, { error: 'settings_update_failed', detail: errorDetail(error) });
                    }
                    // The settings watcher refreshes `cfg` asynchronously; setting it here
                    // means the key works on the very next request either way.
                    cfg = { ...cfg, provisionedKey: minted };
                }
                else {
                    volatileKey = minted;
                    ctx.logger?.warn?.('[dsh-api-gw] no settings provider: the provisioned key is in memory only and will not survive a restart. Set config.apiKeys for a durable key.');
                }
                // Never logged: the log is the one place a secret leaks without anyone
                // authenticating for it.
                ctx.logger?.info?.('[dsh-api-gw] API key provisioned (one-time bootstrap now closed)');
                return sendJson(res, 200, { apiKey: minted, persisted: settingsScope !== null });
            }
            // Admin surface (X-Admin-Key): runtime master switch + key rotation.
            if (seg.length === 2 && seg[0] === 'admin' && seg[1] === 'enable' && req.method === 'POST') {
                if (!isAdmin(req))
                    return sendJson(res, 401, { error: 'admin_unauthorized' });
                let body = {};
                try {
                    body = await readBody(req);
                }
                catch (error) {
                    return sendJson(res, 400, { error: errorDetail(error) });
                }
                const nextEnabled = body.enabled === true;
                if (settingsScope !== null) {
                    try {
                        await settingsScope.update({ enabled: nextEnabled });
                    }
                    catch (error) {
                        return sendJson(res, 500, { error: 'settings_update_failed', detail: errorDetail(error) });
                    }
                }
                else {
                    cfg = { ...cfg, enabled: nextEnabled };
                }
                if (!cfg.enabled) {
                    for (const entry of apiSessions.values()) {
                        for (const r of Array.from(entry.subscribers)) {
                            try {
                                r.end();
                            }
                            catch { /* noop */ }
                        }
                        entry.subscribers.clear();
                        releasePump(entry);
                    }
                }
                return sendJson(res, 200, { enabled: cfg.enabled, sessions: apiSessions.size });
            }
            // Replaces the provisioned key only. `apiKeys` is the operator's own list
            // and rotating over it would silently revoke keys the gateway was never
            // asked to manage.
            if (seg.length === 2 && seg[0] === 'admin' && seg[1] === 'rotate-key' && req.method === 'POST') {
                if (!isAdmin(req))
                    return sendJson(res, 401, { error: 'admin_unauthorized' });
                const minted = randomToken('apigw-', 32);
                if (settingsScope !== null) {
                    try {
                        await settingsScope.update({ provisionedKey: minted });
                    }
                    catch (error) {
                        return sendJson(res, 500, { error: 'settings_update_failed', detail: errorDetail(error) });
                    }
                    cfg = { ...cfg, provisionedKey: minted };
                }
                else {
                    volatileKey = minted;
                }
                ctx.logger?.info?.('[dsh-api-gw] API key rotated');
                return sendJson(res, 200, { apiKey: minted, persisted: settingsScope !== null });
            }
            if (seg.length === 1 && seg[0] === 'sessions' && req.method === 'POST') {
                if (!requireAuth(req, res))
                    return;
                let body = {};
                try {
                    body = await readBody(req);
                }
                catch (error) {
                    return sendJson(res, 400, { error: errorDetail(error) });
                }
                let entry;
                try {
                    entry = await createSession(body);
                }
                catch (error) {
                    ctx.logger?.warn?.(`[dsh-api-gw] session creation failed: ${String(error)}`);
                    const payload = { error: 'session_creation_failed', detail: errorDetail(error) };
                    const workspaces = error.workspaces;
                    if (Array.isArray(workspaces))
                        payload.workspaces = workspaces;
                    return sendJson(res, 400, payload);
                }
                return sendJson(res, 201, {
                    sessionId: entry.agent.id,
                    status: entry.agent.status,
                    provider: entry.agent.options.provider,
                    model: entry.agent.options.model,
                    cwd: entry.agent.session.header.cwd,
                    workspace: entry.workspace,
                });
            }
            if (seg.length === 2 && seg[0] === 'sessions' && seg[1] === 'discover' && req.method === 'GET') {
                if (!requireAuth(req, res))
                    return;
                if (!cfg.allowDiscover)
                    return sendJson(res, 403, { error: 'discover_disabled' });
                if (sessionQuery?.listSessions === undefined)
                    return sendJson(res, 501, { error: 'discover_unavailable' });
                let records = [];
                try {
                    records = await sessionQuery.listSessions();
                }
                catch (error) {
                    return sendJson(res, 500, { error: 'discover_failed', detail: errorDetail(error) });
                }
                const sessions = records.map((record) => {
                    const r = record;
                    const header = mapHeader(r?.header);
                    return { sessionId: header.id, title: header.title, cwd: header.cwd, live: r?.live === true, persisted: r?.persisted === true };
                });
                return sendJson(res, 200, { sessions });
            }
            if (seg.length === 3 && seg[0] === 'sessions' && seg[2] === 'adopt' && req.method === 'POST') {
                if (!requireAuth(req, res))
                    return;
                if (!cfg.allowAdopt)
                    return sendJson(res, 403, { error: 'adopt_disabled' });
                let result;
                try {
                    result = await adoptSession(seg[1]);
                }
                catch (error) {
                    return sendJson(res, 400, { error: 'adopt_failed', detail: errorDetail(error) });
                }
                const { entry, mode, snapshot } = result;
                return sendJson(res, 200, {
                    sessionId: seg[1],
                    mode,
                    status: entry.agent.status,
                    provider: entry.agent.options.provider,
                    model: entry.agent.options.model,
                    cwd: entry.agent.session.header.cwd,
                    workspace: entry.workspace,
                    history: mappedHistory(snapshot),
                });
            }
            if (seg.length === 3 && seg[0] === 'sessions' && req.method === 'GET' && (seg[2] === 'history' || seg[2] === 'stream')) {
                if (!requireAuth(req, res))
                    return;
                const entry = apiSessions.get(seg[1]);
                if (seg[2] === 'history') {
                    const snapshot = await readSessionSnapshot(seg[1]);
                    if (snapshot === null)
                        return sendJson(res, 404, { error: 'session_not_found' });
                    return sendJson(res, 200, {
                        sessionId: seg[1],
                        adopted: entry !== undefined,
                        header: mapHeader(snapshot.session),
                        workspace: entry !== undefined ? entry.workspace : null,
                        events: mappedHistory(snapshot),
                    });
                }
                if (entry === undefined)
                    return sendJson(res, 404, { error: 'session_not_found', hint: `adopt the session first: POST ${cfg.prefix}/sessions/:id/adopt` });
                // hello replays the durable history (live-preferred), falling back to
                // the in-memory tail captured while streaming.
                const snapshot = await readSessionSnapshot(seg[1]);
                const helloLog = snapshot !== null ? mappedHistory(snapshot) : entry.log;
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                });
                res.write('retry: 2000\n');
                // `questions` rather than a replayed frame: an interactive question is
                // live state, not history, and a reconnecting client needs the ones
                // still open -- not a record that one was once asked.
                res.write(sseFrame({ kind: 'hello', seq: 0, sessionId: seg[1], status: entry.agent.status, mode: entry.mode, workspace: entry.workspace, questions: pendingFor(seg[1]), approvals: approvalsFor(seg[1]), log: helloLog }));
                entry.subscribers.add(res);
                req.on('close', () => {
                    entry.subscribers.delete(res);
                    if (entry.subscribers.size === 0)
                        releasePump(entry);
                });
                ensurePump(entry);
                return;
            }
            if (seg.length === 3 && seg[0] === 'sessions' && seg[2] === 'messages' && req.method === 'POST') {
                if (!requireAuth(req, res))
                    return;
                const entry = apiSessions.get(seg[1]);
                if (entry === undefined)
                    return sendJson(res, 404, { error: 'session_not_found', hint: `adopt the session first: POST ${cfg.prefix}/sessions/:id/adopt` });
                let body = {};
                try {
                    body = await readBody(req);
                }
                catch (error) {
                    return sendJson(res, 400, { error: errorDetail(error) });
                }
                let content = null;
                if (typeof body.content === 'string' && body.content !== '')
                    content = [{ type: 'text', text: body.content }];
                else if (Array.isArray(body.content) && body.content.length > 0)
                    content = body.content;
                if (content === null)
                    return sendJson(res, 400, { error: 'content must be a non-empty string or a non-empty array of content blocks' });
                const message = createUserMessage({ content: content, source: { kind: 'user' } });
                try {
                    entry.agent.followup(message);
                }
                catch (error) {
                    return sendJson(res, 500, { error: 'delivery_failed', detail: errorDetail(error) });
                }
                return sendJson(res, 202, { ok: true, sessionId: seg[1], messageId: message.id, status: entry.agent.status });
            }
            // Questions awaiting an answer. Answering is what unblocks the tool call,
            // so these are the only endpoints on this surface whose absence turns a
            // working turn into a stuck one.
            if (seg.length === 3 && seg[0] === 'sessions' && seg[2] === 'questions' && req.method === 'GET') {
                if (!requireAuth(req, res))
                    return;
                if (apiSessions.get(seg[1]) === undefined)
                    return sendJson(res, 404, { error: 'session_not_found', hint: `adopt the session first: POST ${cfg.prefix}/sessions/:id/adopt` });
                return sendJson(res, 200, { sessionId: seg[1], answeredBy: questionOwnership === 'gateway' ? 'gateway' : 'host', questions: pendingFor(seg[1]) });
            }
            if (seg.length === 5 && seg[0] === 'sessions' && seg[2] === 'questions' && req.method === 'POST' && (seg[4] === 'answer' || seg[4] === 'cancel')) {
                if (!requireAuth(req, res))
                    return;
                const pending = pendingQuestions.get(seg[3]);
                // Checked together: a question id from another session must read as "not
                // here", never as an answerable one, or a client holding a stale id could
                // settle a stranger's tool call.
                if (pending === undefined || pending.sessionId !== seg[1]) {
                    return sendJson(res, 404, { error: 'question_not_found', hint: `it may have been answered, cancelled, or the turn ended. GET ${cfg.prefix}/sessions/:id/questions lists what is open.` });
                }
                if (seg[4] === 'cancel') {
                    claimQuestion(pending, 'cancelled');
                    // The tool call fails rather than receiving an invented answer: refusing
                    // to answer is information, and the model can act on it.
                    pending.reject(new UserQuestionError('the human declined to answer this question', 'ASK_ABORTED'));
                    return sendJson(res, 200, { ok: true, sessionId: seg[1], questionId: pending.id, outcome: 'cancelled' });
                }
                let body = {};
                try {
                    body = await readBody(req);
                }
                catch (error) {
                    return sendJson(res, 400, { error: errorDetail(error) });
                }
                const checked = validateAnswers(pending.questions, body);
                if (!checked.ok) {
                    // Rejected, and the question stays open: the answer goes into a tool
                    // result the model will act on, so a partial or invented one is worse
                    // than making the client try again.
                    return sendJson(res, 400, { error: 'invalid_answer', detail: checked.error, questions: pending.questions });
                }
                claimQuestion(pending, 'answered');
                pending.resolve({ answers: checked.answers });
                emitGatewayEvent('gateway/question-answered', { sessionId: seg[1], questionId: pending.id, answers: checked.answers });
                return sendJson(res, 200, { ok: true, sessionId: seg[1], questionId: pending.id, outcome: 'answered' });
            }
            if (seg.length === 3 && seg[0] === 'sessions' && seg[2] === 'approvals' && req.method === 'GET') {
                if (!requireAuth(req, res))
                    return;
                if (apiSessions.get(seg[1]) === undefined)
                    return sendJson(res, 404, { error: 'session_not_found', hint: `adopt the session first: POST ${cfg.prefix}/sessions/:id/adopt` });
                return sendJson(res, 200, { sessionId: seg[1], decidedBy: cfg.approvals, approvals: approvalsFor(seg[1]) });
            }
            if (seg.length === 5 && seg[0] === 'sessions' && seg[2] === 'approvals' && seg[4] === 'decide' && req.method === 'POST') {
                if (!requireAuth(req, res))
                    return;
                const pending = pendingApprovals.get(seg[3]);
                if (pending === undefined || pending.sessionId !== seg[1]) {
                    return sendJson(res, 404, { error: 'approval_not_found', hint: `it may have been decided, withdrawn, or the turn ended. GET ${cfg.prefix}/sessions/:id/approvals lists what is open.` });
                }
                let body = {};
                try {
                    body = await readBody(req);
                }
                catch (error) {
                    return sendJson(res, 400, { error: errorDetail(error) });
                }
                // Only the two a human can mean. 'cancelled' belongs to whoever withdrew
                // the request and 'unavailable' is the fail-closed default -- neither is a
                // decision, and accepting them here would let a client dress a refusal up
                // as an infrastructure failure in the audit log.
                const outcome = body.outcome;
                if (outcome !== 'allowed-once' && outcome !== 'rejected') {
                    return sendJson(res, 400, { error: 'invalid_outcome', hint: "outcome must be 'allowed-once' or 'rejected'" });
                }
                claimApproval(pending, outcome);
                emitGatewayEvent('gateway/approval-decided', { sessionId: seg[1], decisionId: pending.id, outcome });
                return sendJson(res, 200, { ok: true, sessionId: seg[1], decisionId: pending.id, outcome });
            }
            if (seg.length === 3 && seg[0] === 'sessions' && seg[2] === 'cancel' && req.method === 'POST') {
                if (!requireAuth(req, res))
                    return;
                const entry = apiSessions.get(seg[1]);
                if (entry === undefined)
                    return sendJson(res, 404, { error: 'session_not_found', hint: `adopt the session first: POST ${cfg.prefix}/sessions/:id/adopt` });
                entry.agent.cancel({ kind: 'user' });
                return sendJson(res, 200, { ok: true, sessionId: seg[1] });
            }
            // Release the slot this session holds against `maxSessions`.
            //
            // The addressed collection is this gateway's registry, not the harness
            // session store: POST /sessions adds an entry, this removes one. The
            // durable transcript is not part of that resource and survives, so
            // /history keeps answering and /adopt can take the session back.
            if (seg.length === 2 && seg[0] === 'sessions' && req.method === 'DELETE') {
                if (!requireAuth(req, res))
                    return;
                const entry = apiSessions.get(seg[1]);
                // Idempotent, deliberately unlike the 404 that /messages and /cancel
                // answer. A caller releases in its cleanup path, where "the slot is
                // already free" is the goal rather than a fault -- and after a gateway
                // restart every id a client remembers is already gone.
                if (entry === undefined) {
                    return sendJson(res, 200, { ok: true, sessionId: seg[1], released: false, disposed: false, historyRetained: true });
                }
                const mode = entry.mode;
                const { disposed } = releaseSession(seg[1], entry);
                emitGatewayEvent('gateway/session-released', { sessionId: seg[1], mode, disposed });
                return sendJson(res, 200, { ok: true, sessionId: seg[1], released: true, disposed, mode, historyRetained: true });
            }
            return sendJson(res, 404, { error: 'not_found' });
        };
        ctx.on('session/event', onSessionEvent);
        let disposeRoute = null;
        const mountRoute = () => {
            if (disposeRoute !== null) {
                try {
                    disposeRoute();
                }
                catch { /* noop */ }
                ;
                disposeRoute = null;
            }
            const route = {
                kind: 'prefix',
                path: cfg.prefix,
                handler: (req, res) => {
                    Promise.resolve(dispatch(req, res)).catch((error) => {
                        ctx.logger?.warn?.(`[dsh-api-gw] request failed: ${String(error)}`);
                        try {
                            if (res.headersSent)
                                res.destroy();
                            else
                                sendJson(res, 500, { error: 'internal_error', detail: errorDetail(error) });
                        }
                        catch { /* noop */ }
                    });
                },
            };
            disposeRoute = webServer.register(route);
        };
        ctx.effect(() => {
            mountRoute();
            return () => {
                if (disposeRoute !== null) {
                    try {
                        disposeRoute();
                    }
                    catch { /* noop */ }
                    ;
                    disposeRoute = null;
                }
                // Given back before the sessions go, so a reload finds the slot free and
                // whoever is composed next -- including the next copy of this plugin --
                // can take it.
                if (disposeQuestionProvider !== null) {
                    try {
                        disposeQuestionProvider();
                    }
                    catch { /* noop */ }
                    ;
                    disposeQuestionProvider = null;
                }
                questionOwnership = 'unknown';
                // Snapshotted: releaseSession deletes from the map it is iterating, and
                // it is also what fails the questions each session still had open.
                for (const [sessionId, entry] of Array.from(apiSessions.entries()))
                    releaseSession(sessionId, entry);
            };
        });
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
                const scope = sctx.settings.register(settingsNamespace('dsh-api-gw'), Config, { base: config, applies: 'live' });
                settingsScope = scope;
                const resolved = scope.get();
                const prefixChanged = resolved.prefix !== cfg.prefix;
                cfg = resolved;
                if (prefixChanged)
                    mountRoute();
                scope.watch((next, prev) => {
                    const changed = next.prefix !== prev.prefix;
                    cfg = next;
                    if (changed)
                        mountRoute();
                });
            }
            catch (error) {
                ctx.logger?.warn?.(`[dsh-api-gw] settings namespace not registered: ${String(error)}`);
            }
        });
        ctx.logger?.info?.(`[dsh-api-gw] mounted at ${cfg.prefix} (enabled=${String(cfg.enabled)})`);
    },
};
