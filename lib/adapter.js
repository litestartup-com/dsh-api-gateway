/**
 * dsh-api-gateway — 0.1.2 适配层（进程内 typertGateway 直调）。
 *
 * 0.1.2 起网关不再回环 HTTP 转发（/api 带两层鉴权、dotted 端点 404），
 * 改为直调宿主内置的 `typertGateway`（@deepseek-ai/dsh-api-gateway 提供的
 * 进程内 Remote 分发器）：白名单方法 → invoke → 同一套严格 descriptor
 * 校验与业务实现。对外信封（client-request / server-response）不变。
 */
import { randomBytes } from 'node:crypto';
/** 白名单方法 → 0.1.2 Remote 坐标。Phase 2 起逐个补齐其余白名单方法。 */
export const REMOTE_METHODS = {
    'session.list': { namespace: 'session', method: 'list' },
    'session.create': { namespace: 'session', method: 'create' },
    'session.prompt': { namespace: 'session', method: 'prompt' },
    'session.cancel': { namespace: 'session', method: 'cancel' },
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
        case 'session.create': {
            // Host 签名 create(request: SessionCreateRequest)：wire 字段名 = request
            //（A1-01 实测：workspace/create 与 session/create 都用 {request:{...}}）。
            // 可选字段一律剔除 null/undefined（strict codec 只认 string 或缺失）。
            const p = (payload ?? {});
            return {
                request: {
                    ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}),
                    ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}),
                    ...(typeof p.agentPreset === 'string' ? { agentPreset: p.agentPreset } : {}),
                    ...(typeof p.workspaceId === 'string' ? { workspaceId: p.workspaceId } : {}),
                },
            };
        }
        case 'session.prompt': {
            // 0.1.2 要求必填 requestId（客户端铸的身份，落在被接受的用户消息上）。
            // 旧契约没有这个字段——由翻译员铸造，契约冻结的代价归网关扛。
            const p = (payload ?? {});
            return {
                request: {
                    requestId: typeof p.requestId === 'string' ? p.requestId : `apigw-${randomBytes(16).toString('hex')}`,
                    ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}),
                    ...(p.mode === 'queue' || p.mode === 'steer' ? { mode: p.mode } : { mode: 'queue' }),
                    ...(Array.isArray(p.content) ? { content: p.content } : { content: [] }),
                    ...(typeof p.clientTimeZone === 'string' ? { clientTimeZone: p.clientTimeZone } : {}),
                },
            };
        }
        case 'session.cancel': {
            const p = (payload ?? {});
            return { request: { ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}) } };
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
/**
 * `session.history` 的 0.1.2 翻译：0.1.2 无同名 Remote，历史经
 * `session/follow` 流（先出 snapshot 帧再出增量）。网关只取首帧快照，
 * 记录翻译回老契约形状：
 * - `{type:'event', event:{type,seq,time,data}}` → 拆包为 `{ event: { type, ...data } }`
 *   （老契约事件 = type + 平铺载荷；seq/time 是 0.1.2 信封字段，丢弃）
 * - `{type:'chunks', ...}` 打包的流式增量 → **丢弃**（message 帧已带全文，
 *   与 manager compactHistory 的既有语义一致）
 * - projections 原样透传（values.title 对齐）
 */
export const readHistory = async (streamer, sessionId) => {
    const stream = await streamer.stream({
        namespace: 'session',
        method: 'follow',
        args: { request: { address: { kind: 'session', sessionId } } },
    });
    const first = await stream[Symbol.asyncIterator]().next();
    if (first.done)
        throw new Error('session/follow stream closed without a snapshot frame');
    const snapshot = first.value;
    if (snapshot.type !== 'snapshot')
        throw new Error(`session/follow first frame is ${String(snapshot.type)}, expected snapshot`);
    const events = [];
    for (const record of (snapshot.records ?? [])) {
        if (record.type !== 'event' || record.event === undefined)
            continue; // chunks 打包记录丢弃
        const data = (record.event.data ?? {});
        events.push({ event: { type: record.event.type, ...data } });
    }
    return { events, hasMore: snapshot.hasMore === true, projections: snapshot.projections ?? null };
};
