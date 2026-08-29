/**
 * dsh-api-gateway — session event mapping (pure).
 *
 * Maps DeepSeek Harness session-log events onto the gateway's flat wire
 * events. Leaf-field reads only: live agent/session objects are never
 * serialized. Kept free of Cordis and Node surfaces so it is directly
 * unit-testable (see test/events.test.mjs).
 */
export type GatewayEvent = {
    kind: string;
    seq: number;
    [key: string]: unknown;
};
/**
 * Token accounting for one assistant step, as the harness reports it on
 * `assistant/message`. Counts are DISJOINT: `inputTokens` excludes cached
 * input, which `cacheReadTokens` / `cacheWriteTokens` report separately.
 */
export interface TokenUsageJson {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
/** Copy the known counters as plain finite numbers; `null` when the adapter reported no accounting. */
export declare const normalizeUsage: (usage: unknown) => TokenUsageJson | null;
/** Accumulate step usage into a turn total. Absent counters stay absent unless one side reports them. */
export declare const sumUsage: (total: TokenUsageJson | null, step: TokenUsageJson | null) => TokenUsageJson | null;
/** Visible text and thinking content are split, never concatenated. */
export declare const extractBlocks: (content: unknown) => {
    text: string;
    reasoning: string;
};
export declare const chunkJson: (chunk: unknown) => Record<string, unknown> | null;
export declare const eventPayload: (event: unknown) => GatewayEvent | null;
/** Map a whole persisted event array, dropping events with no wire form. */
export declare const mapEvents: (events: readonly unknown[]) => GatewayEvent[];
export declare const sseFrame: (payload: GatewayEvent) => string;
