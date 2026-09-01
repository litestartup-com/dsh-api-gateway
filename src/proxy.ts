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
export const DEFAULT_PROXY_WHITELIST: readonly string[] = [
  // 会话
  'session.list', 'session.create', 'session.history',
  'session.prompt', 'session.cancel', 'session.rename',
  'session.fork', 'session.updateQueue', 'session.attachment',
  // 模型
  'session.models', 'session.selectModel',
  // 应答（POST {prefix}/proxy/respond）
  'respond',
  // 宿主（真实方法名是 host.describe；host.version 不存在）
  'host.describe',
]

/** Whether a proxied method may be forwarded. */
export const isProxyMethodAllowed = (method: string, whitelist: readonly string[]): boolean =>
  whitelist.includes(method)

/** POST URL for one unary apiproxy method: <proxyTarget>/<method>. */
export const unaryProxyUrl = (proxyTarget: string, method: string): string =>
  `${proxyTarget.replace(/\/+$/, '')}/${method}`

/** WebSocket URL of the mux downlink: ws(s)://<proxyTarget>/events.mux. */
export const muxProxyUrl = (proxyTarget: string): string =>
  `${proxyTarget.replace(/\/+$/, '').replace(/^http/, 'ws')}/events.mux`
