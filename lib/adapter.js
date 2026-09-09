/**
 * dsh-api-gateway — 0.1.2 适配层（进程内 typertGateway 直调）。
 *
 * 0.1.2 起网关不再回环 HTTP 转发（/api 带两层鉴权、dotted 端点 404），
 * 改为直调宿主内置的 `typertGateway`（@deepseek-ai/dsh-api-gateway 提供的
 * 进程内 Remote 分发器）：白名单方法 → invoke → 同一套严格 descriptor
 * 校验与业务实现。对外信封（client-request / server-response）不变。
 */
/** 白名单方法 → 0.1.2 Remote 坐标。Phase 2 起逐个补齐其余白名单方法。 */
export const REMOTE_METHODS = {
    'session.list': { namespace: 'session', method: 'list' },
};
/** 已迁移进 REMOTE_METHODS 的方法才能直调。 */
export const isMigrated = (method) => REMOTE_METHODS[method] !== undefined;
/**
 * manager 的旧 payload → 0.1.2 的命名 args（wire 字段名由 descriptor 决定）。
 * `session.list` 的 Host 签名是 `list(_request: SessionListRequest, signal)`：
 * 参数名就是 `_request`，且 `cursor?: string` 可选项不能带 null（strict codec）。
 */
export const argsFor = (method, payload) => {
    switch (method) {
        case 'session.list': {
            const p = (payload ?? {});
            return { _request: { ...(typeof p.cursor === 'string' ? { cursor: p.cursor } : {}) } };
        }
        default:
            return {};
    }
};
/** 一次直调：返回业务 value；抛错时由调用方翻译成 server-response 错误信封。 */
export const invokeRemote = async (invoker, method, payload, signal) => {
    const target = REMOTE_METHODS[method];
    if (target === undefined) {
        throw new Error(`gateway: method ${JSON.stringify(method)} is not migrated to the in-process adapter`);
    }
    return invoker.invoke({ namespace: target.namespace, method: target.method, args: argsFor(method, payload), signal });
};
