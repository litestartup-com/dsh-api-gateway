import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REMOTE_SANDBOX_MODES, isRemoteSandboxMode } from '../lib/sandbox-mode.js'

test('accepts the two remotely grantable modes', () => {
  for (const mode of REMOTE_SANDBOX_MODES) {
    assert.equal(isRemoteSandboxMode(mode), true, mode)
    assert.equal(isRemoteSandboxMode(mode, true), true, mode + ' with allowFullAccess')
  }
})

test('rejects danger-full-access by default, accepts it only with allowFullAccess', () => {
  assert.equal(isRemoteSandboxMode('danger-full-access'), false, 'fail-closed default')
  assert.equal(isRemoteSandboxMode('danger-full-access', true), true, 'operator opt-in')
  assert.equal(isRemoteSandboxMode('danger-full-access', false), false)
})

test('rejects junk values', () => {
  const junk = [undefined, null, 42, 0, '', 'ROOT', 'readonly', ' workspace-write', 'workspace-write\n', {}, [], ['read-only'], 'danger-full-access\n']
  for (const value of junk) {
    assert.equal(isRemoteSandboxMode(value), false, JSON.stringify(value))
    assert.equal(isRemoteSandboxMode(value, true), false, JSON.stringify(value) + ' with allowFullAccess')
  }
})
