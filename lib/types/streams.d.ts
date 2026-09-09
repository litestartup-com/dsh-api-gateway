/**
 * dsh-api-gateway — 0.1.2 mux 桥（每会话 follow 流 → 老 mux 帧广播）。
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
/** 老 mux 帧：server-request 信封 + session/event payload。 */
export declare const buildEventFrame: (sessionId: string, event: unknown) => string;
/**
 * 快照投影 → 逐 key 的 session/projection 帧（老契约：一次一个 key）。
 * `values` 的每个顶层键一帧；manager 的 extractProjectionUsage/Title 按 key 认领。
 */
export declare const buildProjectionFrames: (sessionId: string, projections: unknown) => string[];
/** 会话 follow 流注册表：幂等 ensure、事件泵、广播、关闭。 */
export declare class FollowRegistry {
    private readonly streamer;
    private readonly broadcast;
    private readonly log;
    private readonly streams;
    private readonly pumpLoops;
    private readonly pending;
    constructor(streamer: SessionStreamer, broadcast: (json: string) => void, log: (line: string) => void);
    /** 打开该会话的 follow 流并启动泵（幂等：含开流中的会话，防并发双开）。 */
    ensure(sessionId: string): void;
    private start;
    private pump;
    /** 结束并关闭该会话的流（无 AbortSignal 可用时只能等迭代自然终止）。 */
    close(sessionId: string): void;
    known(): string[];
}
