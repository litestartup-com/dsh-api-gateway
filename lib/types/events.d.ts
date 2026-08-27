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
