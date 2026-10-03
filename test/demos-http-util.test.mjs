// Regression tests for the demo BFF path helpers.
//
// safeJoin hardcoded the POSIX separator in its containment check, so on
// Windows every legitimate path was judged a traversal (400s across the KB
// file CRUD and static serving). Found while standing up the demos on the
// pi-api-facade stack on a Windows host; the fix uses path.sep.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { safeJoin } from '../examples/demos/lib/http-util.mjs'

const root = mkdtempSync(join(tmpdir(), 'demo-http-util-'))
writeFileSync(join(root, 'file.md'), '# x\n')

test('safeJoin resolves a plain relative path under the root', () => {
  const abs = safeJoin(root, 'file.md')
  assert.equal(abs, join(root, 'file.md'))
})

test('safeJoin resolves nested relative paths (both separator styles)', () => {
  assert.equal(safeJoin(root, 'a/b.md'), join(root, 'a', 'b.md'))
  assert.equal(safeJoin(root, 'a\\b.md'), join(root, 'a', 'b.md'))
})

test('safeJoin strips leading slashes without escaping the root', () => {
  assert.equal(safeJoin(root, '/file.md'), join(root, 'file.md'))
  assert.equal(safeJoin(root, '\\file.md'), join(root, 'file.md'))
})

test('safeJoin rejects traversal and absolute escapes', () => {
  assert.equal(safeJoin(root, '../outside.md'), null)
  assert.equal(safeJoin(root, 'a/../../outside.md'), null)
  const elsewhere = join(tmpdir(), 'definitely-outside.md')
  assert.equal(safeJoin(root, elsewhere), null)
})

test('safeJoin rejects empty and non-string input', () => {
  assert.equal(safeJoin(root, ''), null)
  assert.equal(safeJoin(root, null), null)
})

test('the containment check uses the platform separator (regression: Windows 400s)', () => {
  // On every platform: a child path must start with root + sep — the exact
  // invariant that broke when '/' was hardcoded.
  const abs = safeJoin(root, 'file.md')
  assert.ok(abs.startsWith(root + sep))
})
