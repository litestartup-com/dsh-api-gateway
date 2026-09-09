/**
 * ohdsh-api-facade — proxy plumbing (pure).
 *
 * 白名单与守卫，不带 Node/Cordis 面，保持直接可单测（见 test/proxy.test.mjs）。
 * 0.1.2 起网关不再回环转发：白名单是「进程内 facade 可服务的方法集合」。
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
export const DEFAULT_PROXY_WHITELIST = [
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
];
/** Whether a method may be served by the facade. */
export const isProxyMethodAllowed = (method, whitelist) => whitelist.includes(method);
