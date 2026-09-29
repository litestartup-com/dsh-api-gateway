// docker/gen-profile.mjs — build-time generator for the in-image DSH profile.
//
// Adapted from dsh-agent-manager/images/node/gen-node-profile.mjs (the field-hardened
// Hive plan 2 P2 recipe), with one deliberate difference: the facade plugin is installed
// from THIS checkout (a file: dependency on the copied build context) instead of a pinned
// GitHub commit — the image always ships the code it was built from, even before the
// branch is pushed anywhere.
//
// Image layout:
//   /opt/ohdsh-api-facade          this repo (build-context copy; lib/ is prebuilt and committed)
//   /opt/api-profile               generated DSH profile (package.json + cordis.patch.yml + npm ci tree)
//   $DSH_HOME/profiles/api-node    seeded from /opt/api-profile by the entrypoint (cp -aL:
//                                  the file: symlink is materialized so the runtime tree is
//                                  self-contained — ESM resolves peers like cordis from the
//                                  profile's own node_modules, exactly as in the manager image)
//
// Repo-side lock refresh (any OS, no docker required):
//   node docker/gen-profile.mjs --lock-only [DSH_VERSION]
//   → writes docker/profile-lock/<DSH_VERSION>.package-lock.json — commit it.
//   Refresh whenever DSH_VERSION, the facade's dependency ranges, or the peer-pin table change.
// (--seed-only is internal to the Dockerfile: re-stamps the seed marker against the full tree.)
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..')
// Version: env wins, then a positional argument, then the default (a verified pairing
// from the README "Supported DSH versions" table with a committed profile-lock entry).
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const DSH_VERSION = process.env.DSH_VERSION ?? positional[0] ?? '0.1.5-rc.2'
const NPM_REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org'
const LOCK_DIR = process.env.LOCK_DIR ?? join(import.meta.dirname, 'profile-lock')
const PROFILE_NAME = 'api-node'

// Kept in sync with dsh-agent-manager src/dsh-matrix.ts needsLegacyPeerDeps / LEGACY_PEER_PINS
// (fact card dsh-facts §12/§14): the facade peer range ^0.1.2-rc.1 does not reach the 0.1.5
// line, so npm's strict peer resolution is a guaranteed ERESOLVE without --legacy-peer-deps;
// and legacy mode skips EVERY peer, while dsh-app-boot statically imports cordis-plugin-group
// and 23 old-family-name packages exist only in the peer range — pin them as direct deps.
const LEGACY_PEER_DEPS_VERSIONS = ['0.1.5-rc.2']
const LEGACY_PEER_PINS = {
  '0.1.5-rc.2': {
    '@deepseek-ai/cordis-plugin-group': '1.0.2',
    '@deepseek-ai/cordis-plugin-hmr': '1.0.17',
    '@deepseek-ai/cordis-plugin-include': '1.0.7',
    '@deepseek-ai/dsh-anonymous-user-id': '0.1.5-rc.3',
    '@deepseek-ai/dsh-attachment': '0.1.5-rc.3',
    '@deepseek-ai/dsh-authorization': '0.1.5-rc.3',
    '@deepseek-ai/dsh-bash-local': '0.1.5-rc.3',
    '@deepseek-ai/dsh-code-runtime': '0.1.5-rc.3',
    '@deepseek-ai/dsh-compaction': '0.1.5-rc.3',
    '@deepseek-ai/dsh-fs': '0.1.5-rc.3',
    '@deepseek-ai/dsh-hook-protocol': '0.1.5-rc.3',
    '@deepseek-ai/dsh-jobs': '0.1.5-rc.3',
    '@deepseek-ai/dsh-output-retention': '0.1.5-rc.3',
    '@deepseek-ai/dsh-sandbox': '0.1.5-rc.3',
    '@deepseek-ai/dsh-sdk-protocol': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-persistence': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-query': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-telemetry': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-title-llm': '0.1.5-rc.3',
    '@deepseek-ai/dsh-settings': '0.1.5-rc.3',
    '@deepseek-ai/dsh-shell': '0.1.5-rc.3',
    '@deepseek-ai/dsh-spill': '0.1.5-rc.3',
    '@deepseek-ai/dsh-subagent-in-process-driver': '0.1.5-rc.3',
    '@deepseek-ai/dsh-util-time': '0.1.5-rc.3',
    '@deepseek-ai/dsh-util-workspace-path': '0.1.5-rc.3',
    '@deepseek-ai/dsh-workflow': '0.1.5-rc.3',
  },
}

const lockOnly = process.argv.includes('--lock-only')
const seedOnly = process.argv.includes('--seed-only')

// ---- source/dest layout ----------------------------------------------------
// The facade dependency is written as a RELATIVE file: path so the generated lock is
// byte-identical between the image build (/opt/api-profile ← ../ohdsh-api-facade) and
// the repo-side lock refresh (a temp dir with the same sibling layout).
let facadeSrc = process.env.FACADE_SRC ?? '/opt/ohdsh-api-facade'
let out = process.env.PROFILE_DIR ?? '/opt/api-profile'
const tmpRoot = join(LOCK_DIR, `.tmp-${DSH_VERSION}`)
if (lockOnly) {
  rmSync(tmpRoot, { recursive: true, force: true })
  out = join(tmpRoot, 'api-profile')
  facadeSrc = join(tmpRoot, 'ohdsh-api-facade')
  mkdirSync(out, { recursive: true })
  mkdirSync(facadeSrc, { recursive: true })
  // npm --package-lock-only only reads the manifest of a file: dep; copy it (plus the
  // readme/license npm likes to see) instead of the whole tree.
  for (const f of ['package.json', 'README.md', 'README.zh.md', 'LICENSE']) {
    if (existsSync(join(REPO_ROOT, f))) cpSync(join(REPO_ROOT, f), join(facadeSrc, f))
  }
}
const facadeRel = relative(out, facadeSrc).split('\\').join('/')

// ---- facade content hash (seed-version input) -------------------------------
// Any content change under the checkout (lib/, package.json, src/…) reshapes the seed, so
// an image rebuild with new plugin code re-seeds the profile volume on next start.
function hashTree(dir) {
  const h = createHash('sha1')
  const walk = (d, prefix) => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(d, e.name), rel)
      else if (e.isFile()) { h.update(rel); h.update(readFileSync(join(d, e.name))) }
    }
  }
  walk(dir, '')
  return h.digest('hex')
}

// ---- profile manifest + patch + seed marker ---------------------------------
const facadePkg = JSON.parse(readFileSync(join(facadeSrc, 'package.json'), 'utf8'))

// The port passes CLI --port through as a dynamic expression (a hard-coded 3080 would
// override --port — the same pit the manager image documents).
const patchYaml = "- id: webserver\n  config:\n    host: '0.0.0.0'\n    port: !!js ctx.webStartup.port ?? 3080\n"

if (seedOnly) {
  // The Dockerfile re-invokes this script AFTER `COPY .` has completed the checkout:
  // re-stamp .seedversion against the full tree content (the first run only saw the
  // manifest layer) and leave the installed dependency tree untouched.
  const seed = createHash('sha1')
    .update(`${DSH_VERSION}|${facadePkg.version}|${patchYaml}|`)
    .update(hashTree(facadeSrc))
    .digest('hex')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, '.seedversion'), seed + '\n', 'utf8')
  console.log(`[gen-profile] seed re-stamped against the full tree (${seed.slice(0, 8)})`)
  process.exit(0)
}

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'package.json'), JSON.stringify(
  {
    name: 'dsh-profile-api-node',
    private: true,
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ohdsh-api-facade'],
        // A node profile does not enable the live patch watcher (avoids a hard HMR dependency).
        patchReload: 'startup',
      },
    },
    dependencies: {
      '@deepseek-ai/dsh-base': DSH_VERSION,
      '@deepseek-ai/dsh-web-app': DSH_VERSION,
      'ohdsh-api-facade': `file:${facadeRel}`,
      ...(LEGACY_PEER_PINS[DSH_VERSION] ?? {}),
    },
  },
  null,
  2,
) + '\n', 'utf8')
writeFileSync(join(out, 'cordis.patch.yml'), patchYaml, 'utf8')
writeFileSync(
  join(out, '.seedversion'),
  createHash('sha1')
    .update(`${DSH_VERSION}|${facadePkg.version}|${patchYaml}|`)
    .update(lockOnly ? 'lockgen' : hashTree(facadeSrc))
    .digest('hex') + '\n',
  'utf8',
)

// ---- dependency installation -------------------------------------------------
// With a lock: `npm ci` (reproducible tree). Without one (or when the lock's facade entry
// has drifted from this checkout): fall back to `npm install` and warn loudly — the same
// degradation posture as the manager image ("container leftovers", fact card §14).
const lockFile = join(LOCK_DIR, `${DSH_VERSION}.package-lock.json`)
let hasLock = existsSync(lockFile)
if (hasLock) {
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
  const lockedFacade = lock.packages?.[facadeRel]
  if (lockedFacade && lockedFacade.version !== facadePkg.version) {
    console.warn(
      `[gen-profile] WARNING: lock records ohdsh-api-facade ${lockedFacade.version} but this checkout is ${facadePkg.version} — `
      + `falling back to npm install (NOT reproducible). Refresh: node docker/gen-profile.mjs --lock-only ${DSH_VERSION}`,
    )
    hasLock = false
  }
}
if (hasLock) cpSync(lockFile, join(out, 'package-lock.json'))

const installArgs = [
  ...(hasLock ? ['ci'] : ['install']),
  '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`,
]
if (LEGACY_PEER_DEPS_VERSIONS.includes(DSH_VERSION)) installArgs.push('--legacy-peer-deps')

if (lockOnly) {
  execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund',
    `--registry=${NPM_REGISTRY}`,
    ...(LEGACY_PEER_DEPS_VERSIONS.includes(DSH_VERSION) ? ['--legacy-peer-deps'] : [])],
  { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' })
  mkdirSync(LOCK_DIR, { recursive: true })
  cpSync(join(out, 'package-lock.json'), join(LOCK_DIR, `${DSH_VERSION}.package-lock.json`))
  rmSync(tmpRoot, { recursive: true, force: true })
  console.log(`[gen-profile] lock refreshed: ${join(LOCK_DIR, `${DSH_VERSION}.package-lock.json`)} — commit it`)
} else {
  if (!hasLock) {
    console.warn(`[gen-profile] WARNING: no usable lock at ${lockFile} — falling back to npm install; the dependency tree is NOT reproducible`)
  }
  execFileSync('npm', installArgs, { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' })
  console.log(`[gen-profile] ${out} ready (DSH ${DSH_VERSION}, facade ${facadePkg.version} from ${facadeRel}, ${hasLock ? 'npm ci' : 'npm install'}, profile "${PROFILE_NAME}")`)
}
