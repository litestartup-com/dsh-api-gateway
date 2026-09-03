import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import z from '@deepseek-ai/schemastery';
import { WebSocket, WebSocketServer } from 'ws';
import { provisionDecision, resolveCorsOrigin, routeSegments } from './http.js';
import { DEFAULT_PROXY_WHITELIST, isProxyMethodAllowed, muxProxyUrl, unaryProxyUrl } from './proxy.js';
import { isRemoteSandboxMode, REMOTE_SANDBOX_MODES } from './sandbox-mode.js';
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
    // role('secret') on the ARRAY, not on its items: the settings redaction
    // only honours the top-level field role, so the old item-level role left
    // static keys readable in settings.describe.
    apiKeys: z.array(z.string()).role('secret').default([]),
    provisionedKey: z.string().role('secret'),
    allowKeyProvision: z.boolean().default(true),
    adminKey: z.string().role('secret'),
    corsOrigin: z.union([z.string(), z.array(z.string())]).default('*'),
    exposeErrors: z.boolean().default(true),
    proxyTarget: z.string().default('http://127.0.0.1:3080/api'),
    proxyWhitelist: z.array(z.string()).default([...DEFAULT_PROXY_WHITELIST]),
});
export default {
    inject: ['webServer'],
    Config,
    apply(ctx, config) {
        const webServer = ctx.webServer;
        // Mutable runtime config: seeded from the composition row, then re-applied
        // live from the settings namespace (settings integration) below.
        let cfg = config;
        let settingsScope = null;
        /**
         * Fallback home for a minted key when there is no settings provider to
         * persist it in. A deployment without one cannot make the key durable, so it
         * keeps the old in-memory behaviour and says so in the log; everywhere else
         * cfg.provisionedKey is the real storage.
         */
        let volatileKey = null;
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
        /**
         * Access-Control-Allow-Origin carries a single value, so an allow-list is
         * matched against the request Origin and echoed (with Vary: Origin); a
         * disallowed requester gets no header at all.
         */
        const setCors = (res, req) => {
            const requestOrigin = typeof req?.headers?.origin === 'string' ? req.headers.origin : undefined;
            const { origin, vary } = resolveCorsOrigin(cfg.corsOrigin, requestOrigin);
            if (origin !== null)
                res.setHeader('Access-Control-Allow-Origin', origin);
            if (vary)
                res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-api-key, x-admin-key');
            res.setHeader('Access-Control-Max-Age', '600');
        };
        const sendJson = (res, status, obj) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(obj));
        };
        /**
         * Buffered body read with a fixed cap and timeout, so a stalled client
         * cannot pin the proxy. The body is NOT parsed: the proxy forwards bytes.
         */
        const BODY_TIMEOUT_MS = 30_000;
        const readBodyRaw = (req) => new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            let settled = false;
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                reject(new Error('body read timeout'));
                try {
                    req.destroy();
                }
                catch { /* noop */ }
            }, BODY_TIMEOUT_MS);
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > 1_000_000) {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error('body too large'));
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve(Buffer.concat(chunks));
            });
            req.on('error', (error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            });
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
            sendJson(res, 401, { error: 'unauthorized', hint: 'Provide X-API-Key (or Authorization: Bearer <key>). POST ' + cfg.prefix + '/key provisions a key (first call only).' });
            return false;
        };
        // ---- proxy ----
        /** Generous: unary calls answer quickly, but a slow create must not 502. */
        const PROXY_TIMEOUT_MS = 60_000;
        /**
         * One unary passthrough: authenticated + whitelisted already by the caller.
         * Reads the client body verbatim, forwards it, streams the upstream reply
         * back untouched (status + content-type + body).
         */
        const proxyUnary = async (req, res, method) => {
            const body = await readBodyRaw(req);
            const upstream = await fetch(unaryProxyUrl(cfg.proxyTarget, method), {
                method: 'POST',
                headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
                // Uint8Array rather than Buffer: the DOM fetch typings accept the
                // former as BodyInit, and undici takes both at runtime.
                ...(body.length === 0 ? {} : { body: new Uint8Array(body) }),
                signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
            });
            const payload = Buffer.from(await upstream.arrayBuffer());
            res.writeHead(upstream.status, {
                'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
            });
            res.end(payload);
        };
        /**
         * The mux WebSocket pipe: one outer socket per client, one inner client to
         * the harness mux. Downlink only, mirroring the harness: any client frame
         * closes the socket with 1008, and only upstream frames flow outward.
         * Reconnect belongs to the client (the manager), not to the proxy.
         */
        const proxyUpgrade = (wss, req, socket, head) => {
            if (!authorized(req)) {
                // Refuse before protocol negotiation, so an unauthenticated caller
                // never reaches the handshake.
                socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                return;
            }
            wss.handleUpgrade(req, socket, head, (outer) => {
                const inner = new WebSocket(muxProxyUrl(cfg.proxyTarget));
                outer.on('message', () => outer.close(1008, 'downlink only'));
                outer.on('close', () => { try {
                    inner.close();
                }
                catch { /* noop */ } });
                outer.on('error', () => { try {
                    inner.close();
                }
                catch { /* noop */ } });
                inner.onmessage = (event) => {
                    if (outer.readyState !== WebSocket.OPEN)
                        return;
                    try {
                        outer.send(String(event.data));
                    }
                    catch { /* socket going away */ }
                };
                inner.onclose = () => { try {
                    outer.close();
                }
                catch { /* noop */ } };
                inner.onerror = () => { try {
                    outer.close();
                }
                catch { /* noop */ } };
            });
        };
        /** Upstream liveness for /health: one cheap, bounded host.describe probe. */
        const healthUpstream = async () => {
            try {
                const res = await fetch(unaryProxyUrl(cfg.proxyTarget, 'host.describe'), {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ type: 'client-request', rpcId: 'apigw-health', method: 'host.describe', payload: {} }),
                    signal: AbortSignal.timeout(5_000),
                });
                if (!res.ok)
                    return 'unreachable';
                const json = await res.json();
                return json.type === 'server-response' ? 'ok' : 'unreachable';
            }
            catch {
                return 'unreachable';
            }
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
                const upstream = await healthUpstream();
                return sendJson(res, 200, {
                    status: cfg.enabled ? 'ok' : 'disabled',
                    enabled: cfg.enabled,
                    upstream,
                    apiKeySet: acceptedKeys().length > 0,
                });
            }
            if (!cfg.enabled)
                return sendJson(res, 503, { error: 'service_disabled' });
            if (seg.length === 0 && req.method === 'GET') {
                return sendJson(res, 200, {
                    service: 'dsh-api-gw', version: VERSION,
                    endpoints: [
                        { method: 'GET', path: cfg.prefix + '/health', auth: false },
                        { method: 'POST', path: cfg.prefix + '/key', auth: 'first call only' },
                        { method: 'POST', path: cfg.prefix + '/admin/enable', auth: 'admin' },
                        { method: 'POST', path: cfg.prefix + '/admin/rotate-key', auth: 'admin' },
                        { method: 'POST', path: cfg.prefix + '/proxy/<method>', auth: true, note: 'apiproxy unary passthrough (whitelisted)' },
                        { method: 'POST', path: cfg.prefix + '/proxy/respond', auth: true, note: 'answer questions / approvals' },
                        { method: 'POST', path: cfg.prefix + '/sessions/{id}/sandbox-mode', auth: true, note: 'per-session sandbox override (read-only | workspace-write)' },
                        { method: 'GET', path: cfg.prefix + '/events.mux', auth: true, note: 'WebSocket, downlink only' },
                    ],
                });
            }
            /**
             * One-time bootstrap: mint the first key, then close for good.
             *
             * Unauthenticated *only* while the deployment has no key from any source --
             * the single moment when there is no credential that could be demanded. The
             * minted key is persisted before it is returned, so provisionDecision
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
                    // The settings watcher refreshes cfg asynchronously; setting it here
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
                    body = JSON.parse((await readBodyRaw(req)).toString('utf8') || '{}');
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
                return sendJson(res, 200, { enabled: cfg.enabled });
            }
            // Replaces the provisioned key only. apiKeys is the operator's own list
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
            // The proxy surface: auth first, then whitelist (fail closed), then bytes.
            // Auth before whitelist so an unauthenticated caller cannot probe which
            // methods exist by telling 403 from 401 apart.
            if (seg.length === 2 && seg[0] === 'proxy' && req.method === 'POST') {
                if (!requireAuth(req, res))
                    return;
                const method = seg[1];
                if (!isProxyMethodAllowed(method, cfg.proxyWhitelist)) {
                    return sendJson(res, 403, { error: 'method_not_allowed', hint: 'The requested apiproxy method is not on the proxy whitelist.' });
                }
                try {
                    await proxyUnary(req, res, method);
                }
                catch (error) {
                    ctx.logger?.warn?.('[dsh-api-gw] proxy ' + method + ' failed: ' + String(error));
                    if (res.headersSent) {
                        try {
                            res.destroy();
                        }
                        catch { /* noop */ }
                        ;
                        return;
                    }
                    return sendJson(res, 502, { error: 'upstream_unreachable', detail: errorDetail(error) });
                }
                return;
            }
            /**
             * Per-session sandbox-mode override.
             *
             * The wire contract has no sandbox field: session.create takes
             * { cwd | workspaceId, sessionId?, agentPreset? }, and no RPC switches a
             * session's mode. The host keeps the override as `sandbox/mode` log
             * events (dsh-sandbox-policy/session-mode), and its write path is
             * process-internal — so this small route is the only way a remote client
             * (the manager) can pin a fresh session's mode before the first prompt.
             *
             * Capped at workspace-write: danger-full-access stays a host-UI decision.
             * Only live sessions can be pinned; the override is durable (log replay
             * restores it after a cold wake), so one call at creation time suffices.
             */
            if (seg.length === 3 && seg[0] === 'sessions' && seg[2] === 'sandbox-mode' && req.method === 'POST') {
                if (!requireAuth(req, res))
                    return;
                const sessionId = seg[1];
                let body = {};
                try {
                    body = JSON.parse((await readBodyRaw(req)).toString('utf8') || '{}');
                }
                catch (error) {
                    return sendJson(res, 400, { error: 'bad_json', detail: errorDetail(error) });
                }
                if (!isRemoteSandboxMode(body.mode)) {
                    return sendJson(res, 400, {
                        error: 'invalid_mode',
                        hint: 'mode must be one of: ' + REMOTE_SANDBOX_MODES.join(', '),
                    });
                }
                // Soft dependency: a host without the session store degrades cleanly
                // instead of breaking plugin startup (RULE 2).
                const sessions = ctx.get('sessions', true);
                if (sessions === undefined) {
                    return sendJson(res, 501, { error: 'service_unavailable', hint: 'host session store is not available' });
                }
                const session = sessions.get(sessionId);
                if (session === undefined) {
                    return sendJson(res, 409, {
                        error: 'session_not_live',
                        hint: 'only live (attached) sessions accept a sandbox-mode override',
                    });
                }
                setSandboxMode(session, body.mode);
                return sendJson(res, 200, { sessionId, mode: body.mode });
            }
            return sendJson(res, 404, { error: 'not_found' });
        };
        // ---- mount ----
        // One noServer acceptor for all mux upgrades; handleUpgrade is called
        // per connection so the auth check runs before protocol negotiation.
        const wss = new WebSocketServer({ noServer: true });
        wss.on('error', () => { });
        let disposeRoute = null;
        const disposeUpgrades = [];
        const mountRoutes = () => {
            if (disposeRoute !== null) {
                try {
                    disposeRoute();
                }
                catch { /* noop */ }
                ;
                disposeRoute = null;
            }
            while (disposeUpgrades.length > 0) {
                try {
                    disposeUpgrades.pop()();
                }
                catch { /* noop */ }
            }
            const route = {
                kind: 'prefix',
                path: cfg.prefix,
                // The promise is returned so the carrier (and tests) can await the
                // full response lifecycle; SSE-style long responses were removed in S3.
                handler: (req, res) => Promise.resolve(dispatch(req, res)).catch((error) => {
                    ctx.logger?.warn?.('[dsh-api-gw] request failed: ' + String(error));
                    try {
                        if (res.headersSent)
                            res.destroy();
                        else
                            sendJson(res, 500, { error: 'internal_error', detail: errorDetail(error) });
                    }
                    catch { /* noop */ }
                }),
            };
            disposeRoute = webServer.register(route);
            // Two upgrade paths: the canonical one (matching the plan's surface)
            // and one under /proxy so a client whose base is the proxy prefix
            // (the manager's uniform base + method assumption) derives the mux
            // URL without any special case.
            for (const path of [cfg.prefix + '/events.mux', cfg.prefix + '/proxy/events.mux']) {
                const upgrade = {
                    path,
                    handler: (req, socket, head) => proxyUpgrade(wss, req, socket, head),
                };
                disposeUpgrades.push(webServer.registerUpgrade(upgrade));
            }
        };
        ctx.effect(() => {
            mountRoutes();
            return () => {
                if (disposeRoute !== null) {
                    try {
                        disposeRoute();
                    }
                    catch { /* noop */ }
                    ;
                    disposeRoute = null;
                }
                while (disposeUpgrades.length > 0) {
                    try {
                        disposeUpgrades.pop()();
                    }
                    catch { /* noop */ }
                }
                // Terminated rather than closed politely: an unload must not wait on
                // clients that keep their sockets open.
                for (const client of wss.clients)
                    client.terminate();
                wss.close();
            };
        });
        // Settings integration: expose the gateway Config as a live settings
        // namespace so edits apply without a restart. Secret fields (adminKey /
        // apiKeys) are declared role('secret') in the schema, so the wire surface
        // redacts them. Non-fatal by design: a deployment without a settings
        // provider simply keeps the composition-row config.
        //
        // The namespace is 'dsh-api-gw': DSH ships a built-in
        // @deepseek-ai/dsh-api-gateway (the typert Remote dispatcher), so a card
        // keyed 'api-gateway' would be indistinguishable from it in the plugin list.
        ctx.inject(['settings'], (sctx) => {
            try {
                const scope = sctx.settings.register(settingsNamespace('dsh-api-gw'), Config, { base: config, applies: 'live' });
                settingsScope = scope;
                const resolved = scope.get();
                const prefixChanged = resolved.prefix !== cfg.prefix;
                cfg = resolved;
                if (prefixChanged)
                    mountRoutes();
                scope.watch((next, prev) => {
                    const changed = next.prefix !== prev.prefix;
                    cfg = next;
                    if (changed)
                        mountRoutes();
                });
            }
            catch (error) {
                ctx.logger?.warn?.('[dsh-api-gw] settings namespace not registered: ' + String(error));
            }
        });
        ctx.logger?.info?.('[dsh-api-gw] mounted at ' + cfg.prefix + ' proxying ' + cfg.proxyTarget + ' (enabled=' + String(cfg.enabled) + ')');
    },
};
