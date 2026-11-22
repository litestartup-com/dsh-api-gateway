# Changelog

All notable changes to the facade are documented here. The facade is consumed
by commit pin (`github:litestartup-com/dsh-api-gateway#<sha>`), so each entry
records the peer window and the compatibility verification scope for that
release.

## 0.2.9

### Fixed

- **Question/approval resume on 0.2.x hosts**: `$events/result` is now sent with the
  owner peer. The shared Fetch handler defaults to the browser peer, so the host
  rejected the result as cross-peer (or read an undefined `signal`) and interactive
  cards never resumed.

## 0.2.8

### Changed

- **0.2.2 compatibility** (align-06): `session/control` projection delta frames are
  adapted to the batched `changes: [{key, val}]` shape used by DSH 0.2.2-rc.5.
- **Tool failure codes**: `tool/result` errors now surface `data.error.name` and
  `data.error.code` to remote clients instead of a generic failure.
- Tests: 89/89 passing on the 0.2.2-rc.5 types.

## 0.2.7

### Fixed

- **In-process invoke/stream** now passes the owner peer to the host gateway
  (`session.list` and other 0.2.x calls no longer die on
  `Cannot read properties of undefined (reading 'signal')`).

## 0.2.6

### Changed

- **Peer window expanded** in `package.json` `peerDependencies`, from
  `^0.1.2-rc.1 || ^0.2.0-0` to
  `^0.1.2-rc.1 || ^0.2.0-0 || ^0.2.1-rc.1 || ^0.2.2-0`, for
  `@deepseek-ai/dsh-sandbox-policy`, `@deepseek-ai/dsh-session`, and
  `@deepseek-ai/dsh-settings`. The previous window did not match `0.2.1-rc.5`
  or `0.2.2-rc.5` (npm semver prerelease rules require the same
  major.minor.patch); the expansion lets the `0.2.1` and `0.2.2` DSH corridors
  resolve against this facade.

### Compatibility verification scope

- **Declared (semver)**: `0.1.2-rc.1`, `0.2.0`, `0.2.1-rc.1`, `0.2.2-0`.
- **Verified end-to-end (unchanged this release)**: `0.2.0-rc.2`, `0.1.5-rc.2`,
  `0.1.2-rc.1`. `0.2.1-rc.5` and `0.2.2-rc.5` are declared but **not yet
  verified**; the manager version matrix marks them `pending` until the pilot
  and conformance gates pass (ALIGN-26 follow-up cards).
- **Gate for this release**: `npm run build` (type check) + `npm test` (unit)
  green. The pinned conformance suite is re-run in the ALIGN-26 matrix step,
  not as part of this peer-range change.
