# Conformance kit

One suite, any facade. `conformance.mjs` asserts the **intersection** of what
every implementation of the frozen apiproxy contract guarantees — currently
[ohdsh-api-facade](https://github.com/litestartup-com/dsh-api-gateway) (DSH
runtime, this repo) and
[pi-api-facade](https://github.com/litestartup-com/pi-api-facade) (Pi runtime).
It is deliberately not a copy of either repo's own suite: implementation-specific
extras (host fields, typewriter chunks, card chains) stay in `docker/smoke.mjs`,
`docker/probe-cards.mjs`, and each facade's tests.

Zero dependencies (it reuses `docker/probe-lib.mjs`, which carries its own
minimal RFC 6455 client); Node >= 20.

## Run it

```bash
SMOKE_BASE=http://127.0.0.1:8090 SMOKE_KEY=<api-key> node conformance/conformance.mjs
```

| Knob | Meaning |
| --- | --- |
| `SMOKE_BASE` / `--base` | front door or facade base URL (defaults from the repo `.env`, like the other probes) |
| `SMOKE_KEY` / `--key` | API key (defaults to `GW_KEY` from the repo `.env`) |
| `--cwd` / `CONFORMANCE_CWD` | host-side cwd for `session.create` (default `/workspace/conformance`; on a compose stack it is auto-created under the writable `/workspace` mount) |
| `--prompt` / `RUN_PROMPT=1` | additionally run one real turn: needs provider credentials on a real engine (spends tokens); free against the pi facade's fake engine |

## What it asserts

Carrier level: health open; missing/wrong key 401 (the body is NOT asserted —
this facade's provisioning flow advertises `POST /key` in its 401 while
pi-api-facade must never carry that hint; each repo asserts its own body
policy); whitelist fail-closed 403; malformed envelope and envelope/path
method mismatch are non-200.

Envelope level: `host.describe` version + `allowFullAccess`; `session.models`
catalog shape; create/list/history/pending/respond receipts; sandbox-mode
semantics (live pin ok, unknown session 409, bad mode rejected); mux refuses a
wrong key before the upgrade; uplink data frames close 1008 (downstream-only);
whitelisted-but-unimplemented methods answer with well-formed envelopes
(implemented **or** an honest error code — both pass).

With `--prompt`: one full turn — mux envelopes obey
`method === payload.type`; history contains `user/message`,
`assistant/message`, `turn/end`; the billing invariant (usage carries the DSH
field names `inputTokens`/`outputTokens`, `cost` never rides the wire — the
manager prices runs itself); a session that has run is listable. Note: a
**fresh, never-prompted** session is NOT required to appear in `session.list` —
DSH persists on create while Pi writes the session file only once the first
message exists (upstream design), and the manager never lists before prompting.

## CI

- This repo: the `docker` job runs the kit against the live gateway stack
  (wiring mode).
- pi-api-facade: its `demos-stack` job clones this repo (pinned by commit) and
  runs the kit against the Pi facade with `RUN_PROMPT=1` (fake engine — free).

A red kit in either repo means the two facades have drifted apart on the frozen
contract. Fix the drift, not the kit — unless the contract itself moved, which
is a manager-side decision first.
