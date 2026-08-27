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
export const resolveCorsOrigin = (
  configured: string | string[],
  requestOrigin: string | undefined,
): { origin: string | null; vary: boolean } => {
  const list = (Array.isArray(configured) ? configured : [configured]).filter((o) => o !== '')
  if (list.length === 0 || list.includes('*')) return { origin: '*', vary: false }
  if (requestOrigin !== undefined && requestOrigin !== '' && list.includes(requestOrigin)) {
    return { origin: requestOrigin, vary: true }
  }
  // Single configured origin: echo it even for non-browser clients that send no
  // Origin header, so curl/SDK traffic is unaffected by the allow-list.
  if (list.length === 1) return { origin: list[0], vary: true }
  return { origin: null, vary: true }
}

/**
 * Split a request URL into the path segments that follow the gateway prefix.
 * Returns `null` when the URL is outside the prefix.
 */
export const routeSegments = (prefix: string, url: string | undefined): string[] | null => {
  const pathname = String(url ?? '').split('?')[0]
  const parts = pathname.split('/').filter((p) => p !== '')
  const prefixParts = prefix.split('/').filter((p) => p !== '')
  if (parts.length < prefixParts.length) return null
  if (parts.slice(0, prefixParts.length).join('/') !== prefixParts.join('/')) return null
  return parts.slice(prefixParts.length)
}

/**
 * Decode a request body honouring the Content-Type charset (RFC 9110):
 * default UTF-8, but accept e.g. gbk/gb2312 from clients that still send
 * ANSI-encoded bodies (notably Windows PowerShell 5.1).
 */
export const decodeBody = (buf: Uint8Array, contentType: string | undefined): string => {
  const charset = /charset=([^;]+)/i.exec(String(contentType ?? ''))?.[1]?.trim()
  if (charset !== undefined && charset !== '' && !/^utf-?8$/i.test(charset)) {
    try { return new TextDecoder(charset).decode(buf) } catch { /* fall through to utf8 */ }
  }
  return Buffer.from(buf).toString('utf8')
}

/** Project a persisted session header down to the wire shape. */
export const mapHeader = (header: unknown): { id: string | null; title: string | null; cwd: string | null } => {
  const h = header as { id?: unknown; title?: unknown; cwd?: unknown } | null | undefined
  return {
    id: typeof h?.id === 'string' ? h.id : null,
    title: typeof h?.title === 'string' ? h.title : null,
    cwd: typeof h?.cwd === 'string' ? h.cwd : null,
  }
}
