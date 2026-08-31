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
export type ProvisionDecision =
  | { action: 'mint' }
  | { action: 'refuse'; status: number; error: string; hint: string }

export const provisionDecision = (input: {
  provisionedKey: string | undefined
  apiKeys: readonly string[]
  allowKeyProvision: boolean
  prefix: string
}): ProvisionDecision => {
  const configured = input.apiKeys.filter((k) => k !== '')
  const provisioned = input.provisionedKey !== undefined && input.provisionedKey !== ''
  if (provisioned || configured.length > 0) {
    return {
      action: 'refuse',
      status: 403,
      error: 'key_already_provisioned',
      hint: provisioned
        ? `A key was already provisioned. Rotate it with POST ${input.prefix}/admin/rotate-key (requires X-Admin-Key).`
        : 'Static apiKeys are configured; authenticate with one of them.',
    }
  }
  if (!input.allowKeyProvision) {
    return {
      action: 'refuse',
      status: 403,
      error: 'key_provisioning_disabled',
      hint: 'Set config.apiKeys instead, or enable allowKeyProvision.',
    }
  }
  return { action: 'mint' }
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
