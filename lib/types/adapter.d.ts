/**
 * dsh-api-gateway — 0.1.2 适配层（进程内 typertGateway 直调）。
 *
 * 0.1.2 起网关不再回环 HTTP 转发（/api 带两层鉴权、dotted 端点 404），
 * 改为直调宿主内置的 `typertGateway`（@deepseek-ai/dsh-api-gateway 提供的
 * 进程内 Remote 分发器）：白名单方法 → invoke → 同一套严格 descriptor
 * 校验与业务实现。对外信封（client-request / server-response）不变。
 */
export interface GatewayInvoker {
    invoke(request: InvokeRemoteRequest): Promise<unknown>;
}
/** 进程内 Remote 请求（字段名必须与 descriptor 精确一致）。 */
export interface InvokeRemoteRequest {
    readonly namespace: string;
    readonly method: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
}
/** 白名单方法 → 0.1.2 Remote 坐标。Phase 2 起逐个补齐其余白名单方法。 */
export declare const REMOTE_METHODS: Readonly<Record<string, {
    readonly namespace: string;
    readonly method: string;
}>>;
/** 已迁移进 REMOTE_METHODS 的方法才能直调。 */
export declare const isMigrated: (method: string) => boolean;
/**
 * manager 的旧 payload → 0.1.2 的命名 args（wire 字段名由 descriptor 决定）。
 * `session.list` 的 Host 签名是 `list(_request: SessionListRequest, signal)`：
 * 参数名就是 `_request`，且 `cursor?: string` 可选项不能带 null（strict codec）。
 */
export declare const argsFor: (method: string, payload: unknown) => Record<string, unknown>;
/** 一次直调：返回业务 value；抛错时由调用方翻译成 server-response 错误信封。 */
export declare const invokeRemote: (invoker: GatewayInvoker, method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;
