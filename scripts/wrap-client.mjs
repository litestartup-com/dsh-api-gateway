#!/usr/bin/env node
/**
 * Wrap tsc's ESM output for the client half into the `__ModuleLoader__.load`
 * bundle shape the DSH browser runtime expects.
 *
 * The deepseek-harness monorepo does this with its shared `tsdown` client
 * config; this standalone repo keeps a minimal, dependency-free equivalent
 * for its single-file client (src/client.tsx).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'lib', 'client.js')
const id = 'dsh-api-gateway'

let src = readFileSync(file, 'utf8')

// tsc emits ESM for client.tsx:
//   import React from 'react';
//   ... React.createElement(...) ...
//   export const inject = ['slots'];
//   export function apply(ctx) { ... }
// Rewrite those three surfaces into CJS factory form.
src = src.replace(/^import React from ['"]react['"];\r?\n/m, '')
src = src.replace(/^export const inject = /m, 'const inject = ')
src = src.replace(/^export function apply\(/m, 'function apply(')

const bundle = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(id)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  '    var React = require("react");',
  src,
  '    exports.inject = inject;',
  '    exports.apply = apply;',
  '    return module.exports;',
  '  }',
  '});',
  '',
].join('\n')

writeFileSync(file, bundle)
