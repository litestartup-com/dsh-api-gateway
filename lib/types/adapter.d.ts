/**
 * ohdsh-api-facade — 0.1.2 适配层（进程内 typertGateway 直调）。
 *
 * 0.1.2 起网关不再回环 HTTP 转发（/api 带两层鉴权、dotted 端点 404），
 * 改为直调宿主内置的 `typertGateway`（@deepseek-ai/dsh-api-gateway 提供的
 * 进程内 Remote 分发器）：白名单方法 → invoke → 同一套严格 descriptor
 * 校验与业务实现。对外信封（client-request / server-response）不变。
 */
export interface GatewayInvoker {
    invoke(request: InvokeRemoteRequest): Promise<unknown>;
    stream?(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>;
}
/** 提供 stream 面的宿主分发器（typertGateway 的 stream 子集）。 */
export interface GatewayStreamer {
    stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>;
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
/**
 * 读取宿主树的真实 DSH 版本（0.1.2 起 host.describe 由 facade 合成，版本
 * 信息从 profile 依赖树里 @deepseek-ai/dsh/package.json 读取——facade 与 DSH
 * 装在同一 profile 的 node_modules，向上走目录树即命中）。
 *
 * 读不到（非标准布局/文件缺失）回退协议号 '0.0.1'：manager 侧对版本只作
 * 信息展示（DSH-FACTS §6 纪律不变），拿不到真版本时不误导。
 */
export declare const readHostDshVersion: () => string;
/**
 * 0.1.2 无 host.describe Remote；网关合成它。version 返回宿主树的真实 DSH
 * 版本（readHostDshVersion，读不到回退协议号 '0.0.1'）——manager 的探活与
 * 状态页据此展示节点版本，兼容性告警仍以 manager 侧 COMPAT 校验为准。
 */
export declare const HOST_DESCRIBE: Readonly<{
    version: string;
}>;
/** 已迁移（含合成）的方法才能直调。 */
export declare const isMigrated: (method: string) => boolean;
/**
 * manager 的旧 payload → 0.1.2 的命名 args（wire 字段名由 descriptor 决定）。
 * `session.list` 的 Host 签名是 `list(_request: SessionListRequest, signal)`：
 * 参数名就是 `_request`，且 `cursor?: string` 可选项不能带 null（strict codec）。
 */
export declare const argsFor: (method: string, payload: unknown) => Record<string, unknown>;
/**
 * 0.1.2 `session/modelCatalog` 返回值 → 老契约 `SessionModels`
 * （两端口径都来自 dsh 类型实证：0.1.1 dsh-host-apiproxy sessions.d.ts 的
 * SessionModels vs 0.1.2 session-controller types.ts 的 ModelCatalog）：
 * - `current` ← `default`（老契约的「会话下一步模型选择」）
 * - `routable` ← `routableProviders` 包含 `default.provider`（老契约语义 =
 *   当前 provider 是否有 adapter 在服务）
 * - `groups` / `failures` 字段形状两端一致，原样透传。
 */
export declare const translateModelCatalog: (catalog: unknown) => unknown;
/** 一次直调：返回业务 value；抛错时由调用方翻译成 server-response 错误信封。 */
export declare const invokeRemote: (invoker: GatewayInvoker, method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;
/**
 * `session.history` 的 0.1.2 翻译：0.1.2 无同名 Remote，历史经
 * `session/follow` 流（先出 snapshot 帧再出增量）。网关只取首帧快照，
 * 记录翻译回老契约形状：
 * - SessionWireEvent（{type,seq,time,data,ignorable?}）**原样透传**——
 *   manager 的 eventPayload 已按 data/seq 信封解析（不得平铺）
 * - `{type:'chunks', ...}` 打包的流式增量 → **丢弃**（message 帧已带全文，
 *   与 manager compactHistory 的既有语义一致）
 * - 词汇映射：`agent/inbox/spliced` → 老词汇 `user/message`（仅 user 角色的
 *   inserted 消息；0.1.2 把用户消息放进 inbox 事件，manager 不认 spliced）
 * - projections 原样透传（values.title 对齐）
 */
export declare const readHistory: (streamer: {
    stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>;
}, sessionId: string) => Promise<{
    events: unknown[];
    hasMore: boolean;
    projections: unknown;
}>;
