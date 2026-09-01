import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { DEFAULT_PROXY_WHITELIST, isProxyMethodAllowed, muxProxyUrl, unaryProxyUrl } from '../lib/proxy.js'
import plugin from '../lib/index.js'

// ---- pure helpers ----

test('apiKeys carries the secret role on the array itself', () => {
  // Item-level role('secret') is not honoured by settings redaction; only the
  // top-level field role hides the value from settings.describe.
  const field = plugin.Config.dict.apiKeys
  assert.equal(field?.meta?.role, 'secret', 'the array node must be role-secret')
})

test('proxy url builders', () => {
  assert.equal(unaryProxyUrl('http://127.0.0.1:3080/api', 'session.list'), 'http://127.0.0.1:3080/api/session.list')
  assert.equal(unaryProxyUrl('http://127.0.0.1:3080/api/', 'session.list'), 'http://127.0.0.1:3080/api/session.list')
  assert.equal(muxProxyUrl('http://127.0.0.1:3080/api'), 'ws://127.0.0.1:3080/api/events.mux')
  assert.equal(muxProxyUrl('https://host.example/api'), 'wss://host.example/api/events.mux')
})

test('whitelist: the manager surface is allowed, the privileged plane is not', () => {
  for (const m of ['session.list', 'session.create', 'session.history', 'session.prompt',
    'session.cancel', 'session.rename', 'session.fork', 'session.updateQueue', 'session.attachment',
    'session.models', 'session.selectModel', 'respond', 'host.describe']) {
    assert.equal(isProxyMethodAllowed(m, DEFAULT_PROXY_WHITELIST), true, m + ' must be allowed')
  }
  for (const m of ['credentials.set', 'credentials.unset', 'settings.describe', 'settings.update',
    'host.openPath', 'host.pickDirectory', 'host.listDirectory', 'llm.discoverModels',
    'session.search', 'workspace.create', 'subagent.prompt', 'host.version', 'respond.x', '']) {
    assert.equal(isProxyMethodAllowed(m, DEFAULT_PROXY_WHITELIST), false, m + ' must be refused')
  }
})

// ---- integration: the plugin over a mock upstream ----

const startUpstream = () => new Promise((resolve) => {
  const captured = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      captured.push({ url: req.url, method: req.method, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: 'echo', result: { ok: true, value: { got: body } } }))
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    resolve({
      url: 'http://127.0.0.1:' + port + '/api',
      captured,
      close: () => new Promise((r) => server.close(() => r())),
    })
  })
})

const makeWebServer = () => {
  const routes = new Map()
  const upgrades = new Map()
  return {
    routes, upgrades,
    register: (route) => { const key = route.kind + ':' + route.path; routes.set(key, route.handler); return () => routes.delete(key) },
    registerUpgrade: (route) => { upgrades.set(route.path, route.handler); return () => upgrades.delete(route.path) },
  }
}

const boot = async (config, upstream) => {
  const root = new Context()
  const web = makeWebServer()
  root.provide('webServer', web)
  root.provide('logger', { debug: () => {}, info: () => {}, warn: () => {} })
  // Object form so cordis validates the Config schema and fills the defaults
  // (prefix, whitelist, ...) exactly as the real host composition does.
  const fiber = root.plugin(plugin, { proxyTarget: upstream.url, ...config })
  await fiber
  return { root, web, fiber }
}

const teardown = async (booted, upstream) => {
  await booted.fiber.dispose()
  await upstream.close()
}

const fakeReq = (method, url, headers = {}, bodyBuf = null) => {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.destroy = () => {}
  queueMicrotask(() => {
    if (bodyBuf !== null) req.emit('data', bodyBuf)
    req.emit('end')
  })
  return req
}

const fakeRes = () => {
  const res = new EventEmitter()
  res.headers = {}
  res.statusCode = 200
  res.headersSent = false
  res.body = null
  res.ended = false
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v }
  res.writeHead = (code, hdrs) => { res.statusCode = code; res.headersSent = true; if (hdrs) Object.assign(res.headers, hdrs) }
  res.end = (chunk) => { res.body = chunk; res.ended = true }
  res.destroy = () => {}
  return res
}

const call = async (web, method, url, { headers = {}, body = null } = {}) => {
  const handler = web.routes.get('prefix:/api-gw/v1')
  assert.ok(handler, 'the prefix route is mounted')
  const req = fakeReq(method, url, headers, body)
  const res = fakeRes()
  await handler(req, res)
  return res
}

test('index + health: no auth needed, reports service and upstream probe', async () => {
  const upstream = await startUpstream()
  const { web, fiber } = await boot({ apiKeys: ['k1'], enabled: true }, upstream)
  try {
    const index = await call(web, 'GET', '/api-gw/v1')
    assert.equal(index.statusCode, 200)
    const body = JSON.parse(index.body)
    assert.equal(body.service, 'dsh-api-gw')
    assert.ok(Array.isArray(body.endpoints))
    const health = await call(web, 'GET', '/api-gw/v1/health')
    assert.equal(health.statusCode, 200)
    assert.equal(JSON.parse(health.body).status, 'ok')
    assert.equal(JSON.parse(health.body).apiKeySet, true)
  } finally {
    await fiber.dispose()
    await upstream.close()
  }
})

test('proxy refuses non-whitelisted methods before touching the upstream', async () => {
  const upstream = await startUpstream()
  const { web, fiber } = await boot({ apiKeys: ['k1'] }, upstream)
  try {
    const res = await call(web, 'POST', '/api-gw/v1/proxy/credentials.set', {
      headers: { 'x-api-key': 'k1' },
      body: Buffer.from('{}'),
    })
    assert.equal(res.statusCode, 403)
    assert.equal(JSON.parse(res.body).error, 'method_not_allowed')
    assert.equal(upstream.captured.length, 0, 'no upstream request may be made')
    // Auth gates the whitelist: without a key the answer is 401, not 403.
    const anonymous = await call(web, 'POST', '/api-gw/v1/proxy/credentials.set', { body: Buffer.from('{}') })
    assert.equal(anonymous.statusCode, 401)
  } finally {
    await fiber.dispose()
    await upstream.close()
  }
})

test('proxy forwards a whitelisted unary call verbatim', async () => {
  const upstream = await startUpstream()
  const { web, fiber } = await boot({ apiKeys: ['k1'] }, upstream)
  try {
    const envelope = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: { cursor: null } })
    const res = await call(web, 'POST', '/api-gw/v1/proxy/session.list', {
      headers: { 'x-api-key': 'k1', 'content-type': 'application/json' },
      body: Buffer.from(envelope),
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), { type: 'server-response', rpcId: 'echo', result: { ok: true, value: { got: envelope } } })
    assert.equal(upstream.captured.length, 1)
    assert.equal(upstream.captured[0].url, '/api/session.list')
    assert.equal(upstream.captured[0].body, envelope, 'the envelope passes through unparsed')
  } finally {
    await fiber.dispose()
    await upstream.close()
  }
})

test('proxy forwards respond on its own path', async () => {
  const upstream = await startUpstream()
  const { web, fiber } = await boot({ apiKeys: ['k1'] }, upstream)
  try {
    const res = await call(web, 'POST', '/api-gw/v1/proxy/respond', {
      headers: { 'x-api-key': 'k1' },
      body: Buffer.from('{"type":"client-response","rpcId":"q1","result":{"ok":true,"value":{}}}'),
    })
    assert.equal(res.statusCode, 200)
    assert.equal(upstream.captured[0].url, '/api/respond')
  } finally {
    await fiber.dispose()
    await upstream.close()
  }
})

test('auth: no key, wrong key, and Bearer form', async () => {
  const upstream = await startUpstream()
  const { web, fiber } = await boot({ apiKeys: ['k1'] }, upstream)
  try {
    const none = await call(web, 'POST', '/api-gw/v1/proxy/session.list', { body: Buffer.from('{}') })
    assert.equal(none.statusCode, 401)
    assert.equal(upstream.captured.length, 0)
    const wrong = await call(web, 'POST', '/api-gw/v1/proxy/session.list', {
      headers: { 'x-api-key': 'nope' }, body: Buffer.from('{}'),
    })
    assert.equal(wrong.statusCode, 401)
    assert.equal(upstream.captured.length, 0)
    const bearer = await call(web, 'POST', '/api-gw/v1/proxy/session.list', {
      headers: { authorization: 'Bearer k1' }, body: Buffer.from('{}'),
    })
    assert.equal(bearer.statusCode, 200)
    assert.equal(upstream.captured.length, 1)
  } finally {
    await fiber.dispose()
    await upstream.close()
  }
})

test('mux upgrade refuses unauthenticated callers before the handshake', async () => {
  const upstream = await startUpstream()
  const { web, fiber } = await boot({ apiKeys: ['k1'] }, upstream)
  try {
    const handler = web.upgrades.get('/api-gw/v1/events.mux')
    assert.ok(handler, 'the upgrade route is mounted')
    let ended = null
    const socket = { end: (chunk) => { ended = String(chunk) } }
    const req = fakeReq('GET', '/api-gw/v1/events.mux', {})
    await handler(req, socket, Buffer.alloc(0))
    assert.match(ended, /401 Unauthorized/)
  } finally {
    await fiber.dispose()
    await upstream.close()
  }
})

test('a disabled proxy answers 503 while health stays up', async () => {
  const upstream = await startUpstream()
  const { web, fiber } = await boot({ apiKeys: ['k1'], enabled: false }, upstream)
  try {
    const health = await call(web, 'GET', '/api-gw/v1/health')
    assert.equal(health.statusCode, 200)
    assert.equal(JSON.parse(health.body).status, 'disabled')
    const proxied = await call(web, 'POST', '/api-gw/v1/proxy/session.list', {
      headers: { 'x-api-key': 'k1' }, body: Buffer.from('{}'),
    })
    assert.equal(proxied.statusCode, 503)
    // The health probe may have hit the upstream (host.describe); what must not
    // happen is any request for the proxied method.
    assert.equal(upstream.captured.some((c) => c.url === '/api/session.list'), false)
  } finally {
    await fiber.dispose()
    await upstream.close()
  }
})

