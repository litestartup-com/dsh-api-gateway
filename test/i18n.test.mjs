/**
 * Unit tests for the settings-card dictionary and language resolution.
 *
 * Runs against the BUILT output (`lib/`) so it also guards the shape the
 * deployment actually loads. Run `pnpm build` first (CI does).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { STRINGS, dictFor, documentLanguages, resolveLocale } from '../lib/i18n.js'

test('resolveLocale takes the first understood candidate', () => {
  assert.equal(resolveLocale(['zh-CN', 'en']), 'zh')
  assert.equal(resolveLocale(['en-GB', 'zh']), 'en')
  assert.equal(resolveLocale(['de', 'fr', 'zh-Hant']), 'zh')
})

test('resolveLocale matches by prefix, case and separator insensitively', () => {
  for (const tag of ['zh', 'zh-CN', 'zh-Hant-TW', 'ZH', ' zh-hk ', 'zh_TW']) {
    assert.equal(resolveLocale([tag]), 'zh', tag)
  }
  for (const tag of ['en', 'en-US', 'EN-gb', 'en_AU']) {
    assert.equal(resolveLocale([tag]), 'en', tag)
  }
})

test('resolveLocale falls back to English on nothing usable', () => {
  assert.equal(resolveLocale([]), 'en')
  assert.equal(resolveLocale([undefined, null, '', '  ', 42, {}]), 'en')
  assert.equal(resolveLocale(['de-DE', 'ja']), 'en')
  // A language whose name merely contains 'zh' is not Chinese.
  assert.equal(resolveLocale(['azh']), 'en')
})

test('every language carries the same keys, including field rows', () => {
  const [reference, ...others] = Object.keys(STRINGS).map((locale) => STRINGS[locale])
  for (const dict of others) {
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(reference).sort())
    assert.deepEqual(Object.keys(dict.fields).sort(), Object.keys(reference.fields).sort())
    for (const key of Object.keys(dict.fields)) {
      assert.deepEqual(Object.keys(dict.fields[key]).sort(), ['hint', 'label'])
    }
  }
})

test('no string is empty and every parameterized string uses its argument', () => {
  for (const [locale, dict] of Object.entries(STRINGS)) {
    for (const [key, value] of Object.entries(dict)) {
      if (key === 'fields') continue
      if (typeof value === 'function') continue
      assert.ok(typeof value === 'string' && value.trim() !== '', `${locale}.${key}`)
    }
    for (const [key, text] of Object.entries(dict.fields)) {
      assert.ok(text.label.trim() !== '', `${locale}.fields.${key}.label`)
      assert.ok(text.hint.trim() !== '', `${locale}.fields.${key}.hint`)
    }
    assert.match(dict.sessionCount(7), /7/)
    assert.match(dict.entry('/api-gw/v1'), /\/api-gw\/v1/)
    assert.match(dict.numberRequired('Max live sessions'), /Max live sessions/)
  }
})

test('dictFor returns the dictionary of the resolved language', () => {
  assert.equal(dictFor(['zh-CN']), STRINGS.zh)
  assert.equal(dictFor(['fr']), STRINGS.en)
})

test('documentLanguages is safe without a DOM', () => {
  assert.ok(Array.isArray(documentLanguages()))
})
