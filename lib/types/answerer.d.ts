import type { Context } from '@deepseek-ai/cordis';
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
