// http-util.mjs — tiny shared helpers for the demo BFFs (node:http only, zero deps):
// JSON responses, bounded body reads, SSE channels with heartbeat, static file serving
// with a path-traversal guard.
import { createReadStream, statSync } from 'node:fs'
import { join, normalize, resolve, extname, sep } from 'node:path'

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

export function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

export async function readJsonBody(req, limitBytes = 2_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Resolve a client-supplied relative path under root; returns null on traversal. */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel === '') return null
  const abs = resolve(root, normalize(rel).replace(/^([/\\])+/, ''))
  const rootAbs = resolve(root)
  // Platform separator: on Windows resolve() yields backslashes, and a
  // hardcoded '/' made every legitimate path look like a traversal.
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null
  return abs
}

/**
 * Open an SSE channel. Returns a handle; caller pushes named events.
 * Heartbeat comment every 15s keeps nginx (proxy_read_timeout) and browsers happy.
 */
export function sseOpen(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // belt & braces for proxy buffering
  })
  res.write(': connected\n\n')
  const heartbeat = setInterval(() => { try { res.write(': hb\n\n') } catch { /* closed */ } }, 15_000)
  let closed = false
  const done = () => { if (!closed) { closed = true; clearInterval(heartbeat) } }
  req.on('close', done)
  res.on('error', done)
  return {
    get closed() { return closed },
    send(event, data) {
      if (closed) return false
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); return true } catch { done(); return false }
    },
    close() { done(); try { res.end() } catch { /* already */ } },
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.woff2': 'font/woff2',
}

/** Serve a static file under rootDir for an already prefix-stripped URL path. */
export function serveStatic(rootDir, urlPath, res) {
  const rel = decodeURIComponent(urlPath.split('?')[0])
  const file = safeJoin(rootDir, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''))
  if (file === null) return sendText(res, 400, 'bad path')
  try {
    const st = statSync(file)
    if (!st.isFile()) return sendText(res, 404, 'not found')
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    })
    createReadStream(file).pipe(res)
  } catch {
    sendText(res, 404, 'not found')
  }
}
