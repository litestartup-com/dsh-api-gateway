import type { Context } from '@deepseek-ai/cordis';
/**
 * 进程内远程事件流的 carrier（index.ts 用 typertGateway.wireStream 与
 * 宿主 connection.rpc 装配——与浏览器 ClientRemoteEvents 同一套 wire 词汇）。
 *
 * 端点与载荷 = 0.1.2 网关协议常量（packages/api/gateway/src/stream-protocol.ts）：
 * - 流：`$events`，payload `{ args: {} }`；首帧 ready{ clientId, host }；
 *   其后 waterfall{ event, eventId, agentId, request } / cancel{ eventId } / emit。
 * - 认领：RPC `$events/result`，args = { clientId, eventId, outcome }，
 *   outcome ∈ {kind:'result',value?} | {kind:'next'} | {kind:'rejected',error}。
 * 常量按协议钉死在本地（facade 保持与 dsh 仓库解耦的既有风格）。
 */
export interface RemoteEventCarrier {
    openStream: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<AsyncIterable<unknown>>;
    sendResult: (args: unknown, signal: AbortSignal) => Promise<unknown>;
    /** 每收到一帧回调（诊断计数用；kind=帧类型，event=瀑布事件名）。 */
    onFrame?: (kind: string, event?: string) => void;
}
/** manager 不回应的最长期限（超时让位给链上其它应答器，如浏览器 UI）。 */
export declare const ANSWER_TIMEOUT_MS: number;
export declare class Answerer {
    private readonly broadcast;
    private readonly log;
    private readonly pending;
    private disposers;
    constructor(broadcast: (json: string) => void, log: (line: string) => void);
    /** 挂载两个 waterfall 监听器；返回卸载器（fiber 销毁时调用）。 */
    mount(ctx: Context): () => void;
    private awaitAnswer;
    /**
     * 打开 `$events` 流并泵帧：waterfall 帧翻译成老 mux 帧广播给 manager，
     * manager 的 respond 到达后经 `$events/result` 认领。
     *
     * 打不开流（宿主无 typertGateway.wireStream / connection / 未注册转发事件源）
     * 时直接抛错——调用方（index.ts）接住后回退 ctx.on 瀑布监听器路径。
     * @returns 卸载器（中止流 + 拒绝全部挂起项）。
     */
    mountRemote(carrier: RemoteEventCarrier): Promise<() => void>;
    private pumpRemote;
    private handleRemoteWaterfall;
    private sendRemoteResult;
    private broadcastResolved;
    /**
     * manager 的 respond 到达：解析 client-response 信封，回填挂起项。
     * not-ok + code 'cancelled'（manager declineQuestion）按老契约算已认领，
     * 但以 ManagerDeclined 拒绝挂起项，让监听器走 ASK_CANCELLED 路径。
     */
    settle(envelope: {
        rpcId?: unknown;
        result?: {
            ok?: unknown;
            value?: unknown;
            error?: {
                code?: unknown;
                message?: unknown;
            };
        };
    }): {
        found: boolean;
    };
    pendingCount(): number;
}
