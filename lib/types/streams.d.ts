/**
 * ohdsh-api-facade — 0.1.2 mux 桥（每会话 follow 流 → 老 mux 帧广播）。
 *
 * 0.1.2 无全量事件广播：直播流 = 每会话一条 `session/follow` 流
 * （快照帧 + SessionEventEntry 增量）。本模块维护「会话 → 活跃流」注册表，
 * 把增量事件与快照投影翻译成老 mux 帧形（server-request 信封）广播给
 * 所有已连接的下行 WS 客户端（mirror 0.1.1 全量广播语义，manager 本地按
 * sessionId 过滤）。
 */
export interface StreamFrame {
    type?: unknown;
    event?: unknown;
    projections?: unknown;
    /** 0.2.x opt-in live members: {type:'assistant-stream', frame} (dsh-facts §18.13). */
    frame?: unknown;
}
export interface SessionStreamer {
    stream(request: {
        namespace: string;
        method: string;
        args: Record<string, unknown>;
    }): Promise<AsyncIterable<unknown>>;
}
export interface MuxBroadcaster {
    send(json: string): void;
}
/**
 * 宿主线门控：follow 请求的 `assistantStream:true` 标志与随之而来的
 * `{type:'assistant-stream'}` 流成员，在 0.2.x 线上经源码+实测双验证
 * （dsh-api-session-controller types/history.js:179、index.js:1539；
 * dsh-facts §18.13）。0.1.x 宿主对该标志的 schema 容忍度未验证，0.1.7 线
 * 未验证——门控保守：仅 0.2 及以上开启；协议号回退（'0.0.1'）与无法解析
 * 的版本一律视为不支持，保持该线上已验证的原请求形状。
 */
export declare const hostSupportsAssistantStream: (version: string) => boolean;
/**
 * 一个 opt-in 直播成员帧（0.2.x `{type:'assistant-stream', frame}` 的 frame）→
 * 冻结的 0.1.x 持久事件形 `{type:'assistant/chunk', seq, data:{chunk}}`，装进老
 * session/event 信封——manager 的 eventPayload case 'assistant/chunk'（chunkJson
 * 词汇 text-delta/reasoning-delta/tool-call-delta/usage/finish）两代宿主同源
 * （dsh-llm lib 实证），直通即可复活打字机。start/end 尝试生命周期帧无老 wire
 * 对应 → null（不广播）。
 */
export declare const buildChunkFrame: (sessionId: string, frame: unknown, seq: number) => string | null;
/** 老 mux 帧：server-request 信封 + session/event payload。 */
export declare const buildEventFrame: (sessionId: string, event: unknown) => string;
/**
 * 快照投影 → 逐 key 的 session/projection 帧（老契约：一次一个 key）。
 * `values` 的每个顶层键一帧；manager 的 extractProjectionUsage/Title 按 key 认领。
 * seq 取投影水位 asOfSeq（老契约帧形带 seq）。
 */
export declare const buildProjectionFrames: (sessionId: string, projections: unknown) => string[];
/** 单条 live 投影增量 → 老 session/projection 帧（control 流逐条投递）。 */
export declare const buildProjectionFrame: (sessionId: string, key: string, value: unknown, seq: number) => string;
/** 会话 follow 流注册表：幂等 ensure、事件泵、广播、关闭。 */
export declare class FollowRegistry {
    private readonly streamer;
    private readonly broadcast;
    private readonly log;
    /**
     * 宿主支持 opt-in 直播流时（hostSupportsAssistantStream）follow 请求带
     * `assistantStream:true`，泵把 `{type:'assistant-stream'}` 成员翻译回老
     * assistant/chunk wire 形。false（默认）= 已验证线上一个字节都不多带。
     */
    private readonly assistantStream;
    private readonly streams;
    private readonly pumpLoops;
    private readonly pending;
    constructor(streamer: SessionStreamer, broadcast: (json: string) => void, log: (line: string) => void, 
    /**
     * 宿主支持 opt-in 直播流时（hostSupportsAssistantStream）follow 请求带
     * `assistantStream:true`，泵把 `{type:'assistant-stream'}` 成员翻译回老
     * assistant/chunk wire 形。false（默认）= 已验证线上一个字节都不多带。
     */
    assistantStream?: boolean);
    /** 打开该会话的 follow 流并启动泵（幂等：含开流中的会话，防并发双开）。 */
    ensure(sessionId: string): void;
    private start;
    private pump;
    /** 结束并关闭该会话的流（无 AbortSignal 可用时只能等迭代自然终止）。 */
    close(sessionId: string): void;
    known(): string[];
}
/**
 * 宿主级 `session/control` 流桥（0.1.2-rc.1 源码实证，session-controller
 * control.ts）：live projections **不在** follow 流里（其联合只有 snapshot |
 * SessionEventEntry），而在 host-wide control 流——首帧 baseline
 * （全部会话的 {asOfSeq, values}）+ `{type:'projection', sessionId, key,
 * value, seq}` 增量（sessionProjections.onChanged 驱动）。翻译成老 mux 的
 * 逐 key session/projection 帧广播。
 *
 * queue/jobs 帧不翻译：老契约里 manager 的 mux 分发显式忽略它们，无消费者。
 * 流终止（宿主失败）3 秒后重开，mirror manager mux 的重连语义。
 */
export declare class ControlBridge {
    private readonly streamer;
    private readonly broadcast;
    private readonly log;
    private readonly retryMs;
    private disposed;
    private running;
    private timer;
    constructor(streamer: SessionStreamer, broadcast: (json: string) => void, log: (line: string) => void, retryMs?: number);
    /** 开流并泵帧；幂等，dispose 后不再重连。 */
    start(): void;
    private loop;
    dispose(): void;
}
