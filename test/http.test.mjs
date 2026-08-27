/**
 * Unit tests for the HTTP plumbing (CORS negotiation, route splitting, body
 * decoding). Runs against the BUILT output (`lib/`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeBody, mapHeader, resolveCorsOrigin, routeSegments } from '../lib/http.js'

test('resolveCorsOrigin passes wildcard through without Vary', () => {
  assert.deepEqual(resolveCorsOrigin('*', 'https://a.example'), { origin: '*', vary: false })
  assert.deepEqual(resolveCorsOrigin(['*', 'https://a.example'], undefined), { origin: '*', vary: false })
  assert.deepEqual(resolveCorsOrigin([], undefined), { origin: '*', vary: false })
})

test('resolveCorsOrigin echoes a matching origin from an allow-list', () => {
  const list = ['https://a.example', 'https://b.example']
  assert.deepEqual(resolveCorsOrigin(list, 'https://b.example'), { origin: 'https://b.example', vary: true })
})

test('resolveCorsOrigin never emits a joined list for a non-matching origin', () => {
  const list = ['https://a.example', 'https://b.example']
  const { origin } = resolveCorsOrigin(list, 'https://evil.example')
  assert.equal(origin, null)
  const missing = resolveCorsOrigin(list, undefined)
  assert.equal(missing.origin, null)
})

test('resolveCorsOrigin allows a single configured origin even without an Origin header', () => {
  assert.deepEqual(resolveCorsOrigin('https://a.example', undefined), { origin: 'https://a.example', vary: true })
  assert.deepEqual(resolveCorsOrigin(['https://a.example'], 'https://a.example'), { origin: 'https://a.example', vary: true })
})

test('routeSegments strips the prefix and the query string', () => {
  assert.deepEqual(routeSegments('/api-gw/v1', '/api-gw/v1/sessions/abc/stream?since=3'), ['sessions', 'abc', 'stream'])
  assert.deepEqual(routeSegments('/api-gw/v1', '/api-gw/v1'), [])
  assert.deepEqual(routeSegments('/api-gw/v1', '/api-gw/v1/'), [])
  assert.deepEqual(routeSegments('api-gw/v1/', '/api-gw/v1/health'), ['health'])
})

test('routeSegments rejects URLs outside the prefix', () => {
  assert.equal(routeSegments('/api-gw/v1', '/other/health'), null)
  assert.equal(routeSegments('/api-gw/v1', '/api-gw'), null)
  assert.equal(routeSegments('/api-gw/v1', '/api-gw/v2/health'), null)
  assert.equal(routeSegments('/api-gw/v1', undefined), null)
})

test('decodeBody defaults to UTF-8', () => {
  const buf = Buffer.from('{"content":"你好"}', 'utf8')
  assert.equal(decodeBody(buf, 'application/json'), '{"content":"你好"}')
  assert.equal(decodeBody(buf, 'application/json; charset=UTF-8'), '{"content":"你好"}')
  assert.equal(decodeBody(buf, undefined), '{"content":"你好"}')
})

test('decodeBody honours a declared legacy charset (PowerShell 5.1 sends GBK)', () => {
  // GBK bytes for 你好 — must not be read as UTF-8.
  const gbk = Buffer.from([0x7b, 0x22, 0x63, 0x22, 0x3a, 0x22, 0xc4, 0xe3, 0xba, 0xc3, 0x22, 0x7d])
  assert.equal(decodeBody(gbk, 'application/json; charset=gbk'), '{"c":"你好"}')
})

test('decodeBody falls back to UTF-8 for an unknown charset', () => {
  const buf = Buffer.from('{"a":1}', 'utf8')
  assert.equal(decodeBody(buf, 'application/json; charset=not-a-charset'), '{"a":1}')
})

test('mapHeader keeps only known string fields', () => {
  assert.deepEqual(mapHeader({ id: 's1', title: 't', cwd: '/w', secret: 'x' }), { id: 's1', title: 't', cwd: '/w' })
  assert.deepEqual(mapHeader({ id: 1, title: null }), { id: null, title: null, cwd: null })
  assert.deepEqual(mapHeader(null), { id: null, title: null, cwd: null })
  assert.deepEqual(mapHeader(undefined), { id: null, title: null, cwd: null })
})
