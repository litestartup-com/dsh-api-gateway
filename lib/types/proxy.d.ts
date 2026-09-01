/**
 * dsh-api-gateway — proxy plumbing (pure).
 *
 * Whitelist and URL builders for the loopback proxy, with no Node/Cordis
 * surface so they stay directly unit-testable (see test/proxy.test.mjs).
 */
/**
 * apiproxy methods the proxy may forward. Everything else is refused with 403
 * before any upstream request is made — fail-closed, no exceptions.
 *
 * The list deliberately covers the manager's needs and nothing more: the
 * privileged plane (credentials.*, settings.*, host.openPath,
 * host.pickDirectory, llm.discoverModels, agentPreset.*, goal.*, workspace.*,
 * subagent.*, skill.*, session.search) stays unreachable through the proxy.
 */
export declare const DEFAULT_PROXY_WHITELIST: readonly string[];
/** Whether a proxied method may be forwarded. */
export declare const isProxyMethodAllowed: (method: string, whitelist: readonly string[]) => boolean;
/** POST URL for one unary apiproxy method: <proxyTarget>/<method>. */
export declare const unaryProxyUrl: (proxyTarget: string, method: string) => string;
/** WebSocket URL of the mux downlink: ws(s)://<proxyTarget>/events.mux. */
export declare const muxProxyUrl: (proxyTarget: string) => string;
