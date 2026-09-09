import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { DEFAULT_PROXY_WHITELIST, isProxyMethodAllowed, muxProxyUrl } from '../lib/proxy.js'
import { argsFor, isMigrated, invokeRemote, readHistory, REMOTE_METHODS } from '../lib/adapter.js'
import plugin from '../lib/index.js'

// ---- pure helpers ----

test('apiKeys carries the secret role on the array itself', () => {
  // Item-level role('secret') is not honoured by settings redaction; only the
  // top-level field role hides the value from settings.describe.
  const field = plugin.Config.dict.apiKeys
  assert.equal(field?.meta?.role, 'secret', 'the array node must be role-secret')
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

// ---- adapter (0.1.2 in-process mapping) ----

test('adapter: session.list maps to session/list with descriptor-named args', async () => {
  assert.equal(isMigrated('session.list'), true)
  assert.equal(isMigrated('respond'), false, 'not migrated until Phase 2')
  assert.deepEqual(REMOTE_METHODS['session.list'], { namespace: 'session', method: 'list' })
  assert.deepEqual(argsFor('session.list', { cursor: null }), { _request: {} }, 'null cursor must be dropped (strict codec)')
  assert.deepEqual(argsFor('session.list', { cursor: 'c1' }), { _request: { cursor: 'c1' } })
  assert.deepEqual(argsFor('session.list', undefined), { _request: {} })

  const calls = []
  const invoker = { invoke: async (request) => { calls.push(request); return { items: [] } } }
  const value = await invokeRemote(invoker, 'session.list', { cursor: 'c1' })
  assert.deepEqual(value, { items: [] })
  assert.deepEqual(calls[0], { namespace: 'session', method: 'list', args: { _request: { cursor: 'c1' } }, signal: undefined })
})

test('adapter: session.create maps to session/create with request-named args', async () => {
  assert.deepEqual(REMOTE_METHODS['session.create'], { namespace: 'session', method: 'create' })
  assert.deepEqual(argsFor('session.create', { cwd: 'C:/ws', agentPreset: 'standard' }), {
    request: { cwd: 'C:/ws', agentPreset: 'standard' },
  })
  assert.deepEqual(argsFor('session.create', { cwd: 'C:/ws', agentPreset: null, sessionId: undefined }), {
    request: { cwd: 'C:/ws' },
  }, 'null/undefined optionals must be dropped (strict codec)')
  assert.deepEqual(argsFor('session.create', { workspaceId: 'w1' }), { request: { workspaceId: 'w1' } })

  const calls = []
  const invoker = { invoke: async (request) => { calls.push(request); return { sessionId: 's9' } } }
  const value = await invokeRemote(invoker, 'session.create', { cwd: 'C:/ws' })
  assert.deepEqual(value, { sessionId: 's9' })
  assert.deepEqual(calls[0], { namespace: 'session', method: 'create', args: { request: { cwd: 'C:/ws' } }, signal: undefined })
})

test('adapter: session.prompt mints the required requestId and keeps the queue contract', async () => {
  const calls = []
  const invoker = { invoke: async (request) => { calls.push(request); return { accepted: true } } }
  const value = await invokeRemote(invoker, 'session.prompt', { sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] })
  assert.deepEqual(value, { accepted: true })
  const args = calls[0].args.request
  assert.match(args.requestId, /^apigw-[0-9a-f]{32}$/, 'gateway mints the 0.1.2-required requestId')
  assert.equal(args.sessionId, 's1')
  assert.equal(args.mode, 'queue')
  assert.deepEqual(args.content, [{ type: 'text', text: 'hi' }])
  // 旧契约无 requestId：两次调用必须铸两个不同 id（不重复）。
  await invokeRemote(invoker, 'session.prompt', { sessionId: 's1' })
  assert.notEqual(calls[1].args.request.requestId, calls[0].args.request.requestId)
})

test('adapter: session.cancel passes the sessionId through', async () => {
  const calls = []
  const invoker = { invoke: async (request) => { calls.push(request); return { accepted: true } } }
  const value = await invokeRemote(invoker, 'session.cancel', { sessionId: 's1' })
  assert.deepEqual(value, { accepted: true })
  assert.deepEqual(calls[0], { namespace: 'session', method: 'cancel', args: { request: { sessionId: 's1' } }, signal: undefined })
})

test('adapter: session.history reads the follow snapshot and translates records', async () => {
  const streamCalls = []
  const snapshot = {
    type: 'snapshot',
    header: { version: 1, id: 's1', createdAt: 1, cwd: 'C:/ws' },
    cursor: 5,
    records: [
      { type: 'event', event: { type: 'user/message', seq: 1, time: 11, data: { id: 'm1', content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'chunks', event: { type: 'chunkrow/text', seq: 2, time: 12, data: { text: 'H' } } },
      { type: 'event', event: { type: 'agent/inbox/spliced', seq: 3, time: 13, data: { target: 'next-turn', start: 0, inserted: [{ id: 'm2', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user', rpcId: 'apigw-x' } }] } } },
      { type: 'event', event: { type: 'turn/end', seq: 4, time: 14, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } } },
    ],
    hasMore: false,
    projections: { asOfSeq: 4, values: { title: 't1' } },
  }
  const streamer = {
    stream: async (request) => {
      streamCalls.push(request)
      return (async function* () { yield snapshot })()
    },
  }
  const value = await readHistory(streamer, 's1')
  assert.deepEqual(value, {
    events: [
      { event: snapshot.records[0].event },
      { event: { type: 'user/message', data: { id: 'm2', content: [{ type: 'text', text: 'hello' }] } } },
      { event: snapshot.records[3].event },
    ],
    hasMore: false,
    projections: snapshot.projections,
  }, 'wire events pass through untouched; chunks dropped; spliced user messages translated to user/message')
  assert.deepEqual(streamCalls[0], {
    namespace: 'session', method: 'follow',
    args: { request: { address: { kind: 'session', sessionId: 's1' } } },
  })
})

test('adapter: session.history fails loud when the follow stream has no snapshot', async () => {
  const streamer = { stream: async () => (async function* () {})() }
  await assert.rejects(() => readHistory(streamer, 's1'), /closed without a snapshot/)
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
  // 0.1.2 in-process seam: the host's built-in Remote dispatcher (mocked).
  const invocations = []
  root.provide('typertGateway', {
    invoke: async (request) => {
      invocations.push(request)
      if (request.method === 'list') return { items: [{ sessionId: 's1', updatedAt: 42, running: false, blank: true }] }
      throw new Error('mock: unexpected method ' + request.method)
    },
  })
  // Object form so cordis validates the Config schema and fills the defaults
  // (prefix, whitelist, ...) exactly as the real host composition does.
  const fiber = root.plugin(plugin, { proxyTarget: upstream.url, ...config })
  await fiber
  return { root, web, fiber, invocations }
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

test('proxy serves a migrated unary call in-process with the frozen envelope', async () => {
  const upstream = await startUpstream()
  const { web, fiber, invocations } = await boot({ apiKeys: ['k1'] }, upstream)
  try {
    const envelope = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: { cursor: null } })
    const res = await call(web, 'POST', '/api-gw/v1/proxy/session.list', {
      headers: { 'x-api-key': 'k1', 'content-type': 'application/json' },
      body: Buffer.from(envelope),
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), {
      type: 'server-response', rpcId: 'r1',
      result: { ok: true, value: { items: [{ sessionId: 's1', updatedAt: 42, running: false, blank: true }] } },
    })
    assert.equal(upstream.captured.length, 0, 'no HTTP upstream request may be made')
    assert.equal(invocations[0].namespace, 'session')
    assert.equal(invocations[0].method, 'list')
    assert.deepEqual(invocations[0].args, { _request: {} })
    assert.ok(invocations[0].signal instanceof AbortSignal, 'the in-process call carries cancellation')
  } finally {
    await fiber.dispose()
    await upstream.close()
  }
})

test('proxy reports unmigrated methods honestly (501) instead of touching the dead loopback', async () => {
  const upstream = await startUpstream()
  const { web, fiber } = await boot({ apiKeys: ['k1'] }, upstream)
  try {
    const res = await call(web, 'POST', '/api-gw/v1/proxy/respond', {
      headers: { 'x-api-key': 'k1' },
      body: Buffer.from('{"type":"client-request","rpcId":"q1","method":"respond","payload":{}}'),
    })
    assert.equal(res.statusCode, 501)
    assert.equal(JSON.parse(res.body).error, 'method_not_migrated')
    assert.equal(upstream.captured.length, 0)
  } finally {
    await fiber.dispose()
    await upstream.close()
  }
})

test('auth: no key, wrong key, and Bearer form', async () => {
  const upstream = await startUpstream()
  const { web, fiber, invocations } = await boot({ apiKeys: ['k1'] }, upstream)
  try {
    const none = await call(web, 'POST', '/api-gw/v1/proxy/session.list', { body: Buffer.from('{}') })
    assert.equal(none.statusCode, 401)
    assert.equal(invocations.length, 0)
    const wrong = await call(web, 'POST', '/api-gw/v1/proxy/session.list', {
      headers: { 'x-api-key': 'nope' }, body: Buffer.from('{}'),
    })
    assert.equal(wrong.statusCode, 401)
    assert.equal(invocations.length, 0)
    const bearer = await call(web, 'POST', '/api-gw/v1/proxy/session.list', {
      headers: { authorization: 'Bearer k1' },
      body: Buffer.from('{"type":"client-request","rpcId":"r1","method":"session.list","payload":{}}'),
    })
    assert.equal(bearer.statusCode, 200)
    assert.equal(invocations.length, 1)
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

