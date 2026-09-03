import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REMOTE_SANDBOX_MODES, isRemoteSandboxMode } from '../lib/sandbox-mode.js'

test('accepts the two remotely grantable modes', () => {
  for (const mode of REMOTE_SANDBOX_MODES) {
    assert.equal(isRemoteSandboxMode(mode), true, mode)
  }
})

test('rejects danger-full-access (host-UI only)', () => {
  assert.equal(isRemoteSandboxMode('danger-full-access'), false)
})

test('rejects junk values', () => {
  const junk = [undefined, null, 42, 0, '', 'ROOT', 'readonly', ' workspace-write', 'workspace-write\n', {}, [], ['read-only']]
  for (const value of junk) {
    assert.equal(isRemoteSandboxMode(value), false, JSON.stringify(value))
  }
})
