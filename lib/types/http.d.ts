/**
 * dsh-api-gateway — HTTP plumbing (pure).
 *
 * Request-shaped helpers with no Node/Cordis surface, so they stay directly
 * unit-testable (see test/http.test.mjs).
 */
/**
 * Negotiate the `Access-Control-Allow-Origin` value.
 *
 * The header accepts exactly one origin (or `*`) — a joined list is invalid and
 * every browser rejects it. So an allow-list is matched against the request
 * `Origin` and echoed back, with `Vary: Origin` so caches stay correct.
 *
 * Returns `origin: null` when the requester is not allowed: the caller then
 * omits the header entirely and the browser blocks the response.
 */
export declare const resolveCorsOrigin: (configured: string | string[], requestOrigin: string | undefined) => {
    origin: string | null;
    vary: boolean;
};
/**
 * Split a request URL into the path segments that follow the gateway prefix.
 * Returns `null` when the URL is outside the prefix.
 */
export declare const routeSegments: (prefix: string, url: string | undefined) => string[] | null;
/**
 * Decode a request body honouring the Content-Type charset (RFC 9110):
 * default UTF-8, but accept e.g. gbk/gb2312 from clients that still send
 * ANSI-encoded bodies (notably Windows PowerShell 5.1).
 */
export declare const decodeBody: (buf: Uint8Array, contentType: string | undefined) => string;
/**
 * Whether `POST {prefix}/key` may still mint a key.
 *
 * The bootstrap is meant to be available only while the deployment has no key at
 * all. An earlier version tested the in-memory provisioned key alone, which was
 * wrong twice over: a deployment with `apiKeys` configured could still be talked
 * into handing out an extra credential, and because the in-memory slot is empty
 * again after every restart, the unauthenticated window reopened on each one
 * instead of closing for good. So the predicate reads every source a key can
 * come from, and `provisionedKey` is persisted by the caller precisely so that
 * this returns `refuse` forever after the first mint.
 */
export type ProvisionDecision = {
    action: 'mint';
} | {
    action: 'refuse';
    status: number;
    error: string;
    hint: string;
};
export declare const provisionDecision: (input: {
    provisionedKey: string | undefined;
    apiKeys: readonly string[];
    allowKeyProvision: boolean;
    prefix: string;
}) => ProvisionDecision;
/** Project a persisted session header down to the wire shape. */
export declare const mapHeader: (header: unknown) => {
    id: string | null;
    title: string | null;
    cwd: string | null;
};
