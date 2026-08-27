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
/** Project a persisted session header down to the wire shape. */
export declare const mapHeader: (header: unknown) => {
    id: string | null;
    title: string | null;
    cwd: string | null;
};
