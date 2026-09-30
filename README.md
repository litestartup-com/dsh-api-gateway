# ohdsh-api-facade

A DeepSeek Harness host plugin: an **authenticated, fail-closed in-process HTTP
facade** that serves the host's session surface (the 0.1.2 typertGateway
remotes + follow/control streams + question/approval waterfalls) to remote
clients under the **frozen legacy apiproxy contract** (typical client:
dsh-agent-manager).

> The plugin does exactly three things: **authentication, whitelisting, and
> contract translation**. The 0.1.1-era loopback HTTP forwarding was removed
> with the 0.1.2 rebuild; envelopes, frame shapes, and receipts remain
> identical to 0.1.1 — every version difference is absorbed here, so clients
> need zero changes.

## Why it exists

DSH's `/api` surface sits behind a two-layer gate (trust fence + browser auth)
that remote clients cannot pass, and its in-process seams are not exported.
This plugin runs inside the DSH process and calls the host domain services
directly (typertGateway dispatcher, session streams, waterfalls), guarded by
API-key auth and a deny-by-default whitelist.

## Supported DSH versions

The facade runs **inside** a DSH host, so its compatibility surface is the host
version. The declared range lives in `package.json` `peerDependencies`
(`^0.1.2-rc.1 || ^0.2.0-0` — dual-range since facade 0.2.4: the 0.2.0 corridor
broke the old ceiling, and the DSH host enforces peers at install **and**
startup); the pairings below are the ones **verified end-to-end** — wire
contract, question/approval card chains, and GUI token capture — not merely
semver-declared:

| DSH | Status | Evidence |
| --- | --- | --- |
| `0.2.0-rc.2` | ✅ verified | Full-chain smoke + question/approval card chains + V3→V4 session-volume migration on the standalone Docker stack (facade 0.2.4, host 192.168.33.11); npm `latest` line |
| `0.1.5-rc.2` | ✅ verified | Full-chain + card-chain smoke on facade 0.2.4 (dual-compat regression of the 0.2.0 corridor work) and on `#b592b4f` before it; see the install note below |
| `0.1.2-rc.1` | ✅ verified | Full-chain smoke (`dsh-agent-manager/scripts/smoke-proxy-b.ts`, real model turn) |
| `0.1.1-rc.2` | ⚠️ legacy | Wire contract frozen from this era; not the supported base |

> **0.1.5 install note**: npm's strict peer resolution rejects the default
> install (ERESOLVE) even though the range covers 0.1.5 semantically —
> compose 0.1.5 profiles with `npm install --legacy-peer-deps`. Consumers track
> this in their version matrix (`dsh-agent-manager` `src/dsh-matrix.ts`,
> `needsLegacyPeerDeps`). The same posture applies to the 0.2.0 line.

> **0.2.0 corridor note** (what facade 0.2.4 absorbs, so clients don't have to):
> the host's `wireStream.open` grew duplex uplink/peer parameters (arity-based
> detection keeps one code path booting both host generations);
> `ctx.settings.register` is gone host-side, so the durable key path on 0.2.0
> hosts is the **composition config** (the Docker stack's entrypoint injects
> `GW_KEY` into the profile patch; `POST {prefix}/key` bootstrap keys are
> memory-only there); session logs moved to V4 (V3 volumes are migrated on
> read — one-way, back up before upgrading); and the DeepSeek session-log
> upload defaults to **on** (the Docker stack pins it off in the profile
> patch). The wire contract itself is unchanged — managers and probes pinned to
> older facade commits keep working against 0.2.0 hosts through this facade.

Consumers pin the facade **by commit**
(`github:litestartup-com/dsh-api-gateway#<sha>`), so each DSH line is
re-verified before a pin moves; verification records live in the private
design library (`dsh-facts`). The `0.1.6-alpha.*` / `0.1.7-*` lines were
superseded by `0.2.0` and are **not separately verified** (the 0.2.0 corridor
spans them via the community jump cards).

## Install

```powershell
dsh plugin --profile web add github:litestartup-com/dsh-api-gateway
```

Add one row to the host composition (see `examples/cordis.yml`) and restart DSH.

> Naming note: DSH ships a built-in package named `@deepseek-ai/dsh-api-gateway`
> (the typert dispatcher) which is unrelated to this plugin. This plugin is the
> **external HTTP facade**; its settings namespace / composition row / service
> field are all `ohdsh-api-facade`.

## Docker deployment (standalone API stack)

The repo ships a self-contained compose stack that runs the facade as a
**standalone, public-facing API service** — no manager and no extra wiring
required:

```
client ──HTTP──▶ nginx (:${HTTP_PORT}) ──/api-gw/ only──▶ gateway container
                                                          = DSH host + this facade
```

The gateway port is never published; nginx is the only front door and it is
**fail-closed**: only `/api-gw/` is proxied, everything else (the DSH web GUI,
`/api`, assets) answers 404. Behind that door the facade enforces its own
API-key auth and the deny-by-default method whitelist — two independent layers.

### Quickstart

```bash
bash docker/gen-env.sh          # generate .env (HOST_UID/GID, a random GW_KEY) — idempotent
# edit .env: fill in DEEPSEEK_API_KEY (required for real session turns)
docker compose up -d --build    # builds the node image (pinned DSH + committed lock) and boots
node docker/smoke.mjs           # wiring acceptance; add --model for one real model turn
node docker/probe-cards.mjs     # question/approval card chains (respond roundtrips; needs a model key)
```

The API base becomes `http://<host>:${HTTP_PORT}/api-gw/v1`, authenticated with
`GW_KEY` from `.env` as `X-API-Key`:

```bash
curl -s http://127.0.0.1/api-gw/v1/health
curl -s -X POST http://127.0.0.1/api-gw/v1/proxy/session.list \
  -H "X-API-Key: $GW_KEY" -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"1","method":"session.list","payload":{}}'
```

### Files

| Path | Role |
| --- | --- |
| `docker-compose.yml` | nginx + gateway services, health-gated startup |
| `docker/Dockerfile` | one container = one DSH API node (pinned DSH + the facade from this checkout) |
| `docker/gen-profile.mjs` | build-time profile generator (lock-driven `npm ci`; `--lock-only` refreshes the lock) |
| `docker/profile-lock/` | committed dependency locks (reproducible trees, one per DSH version) |
| `docker/entrypoint.sh` | idempotent seeding: profile → volume, `GW_KEY` → settings.yaml |
| `docker/nginx/gateway.conf` | the fail-closed front door (API prefix only; WebSocket-upgrade aware) |
| `docker/gen-env.sh` | `.env` generator (HOST_UID/GID red line, random `GW_KEY`) |
| `docker/probe-lib.mjs` | shared probe machinery (config, envelopes, raw-WS client) |
| `docker/smoke.mjs` | zero-dependency stack acceptance (includes a raw-WS mux check) |
| `docker/probe-cards.mjs` | question/approval card-chain probe (respond roundtrips + sandbox escalation + file-on-disk proof) |

### .env reference

| Variable | Default | Description |
| --- | --- | --- |
| `HTTP_PORT` | `80` | External nginx port (plain HTTP; TLS is not wired in v1) |
| `GW_KEY` | generated | Static facade API key (`X-API-Key`). Empty leaves the one-time `POST /key` bootstrap open — not recommended on a public surface |
| `DEEPSEEK_API_KEY` | — | Model credential; required for real session turns |
| `DSH_VERSION` | `0.2.0-rc.2` | Pinned DSH line baked into the image (needs a matching `docker/profile-lock/` entry; `0.1.5-rc.2` remains supported) |
| `NGINX_IMAGE` | `nginx:alpine` | Override where alpine cannot be pulled (e.g. `docker.m.daocloud.io/library/nginx:alpine`) |
| `NODE_IMAGE` / `NPM_REGISTRY` | docker.io / npmjs | Build-time mirrors for GFW builds |
| `HOST_UID` / `HOST_GID` | `1000` | Container runtime uid = host file-owner uid (written by `gen-env.sh`) |
| `GW_ADMIN_KEY` | — | Optional: enables the `{prefix}/admin/*` endpoints |
| `GW_ALLOW_FULL_ACCESS` | — | Optional `true`: the sandbox route may grant `danger-full-access` (risk notice under Configuration) |
| `GW_EXPOSE_ERRORS` | — | Optional `false`: strip internal error details (recommended for public deployments) |
| `GW_CORS_ORIGIN` | — | Optional: tighten CORS origin(s) for public deployments |

### Sessions & workspaces

`./workspaces` on the host is mounted at `/workspace` in the gateway container.
When creating a session through the API, pass a `cwd` under that mount (e.g.
`/workspace/my-project`) — the same tree is visible as
`./workspaces/my-project` on the host. DSH state (settings, credentials,
session logs) lives in the `gateway-data` named volume and survives
`docker compose down`; `down -v` wipes it.

### Upgrades & lock refresh

`docker compose up -d --build` rebuilds the image from the current checkout.
The entrypoint re-seeds the profile into the volume whenever the image's
seed version changes (DSH pin, facade version, or plugin content) — no manual
step, and `.env`'s `GW_KEY` remains the source of truth for the key.

Refresh the committed lock first whenever `DSH_VERSION` or the facade's
dependency ranges change:

```bash
node docker/gen-profile.mjs --lock-only 0.2.0-rc.2
# → writes docker/profile-lock/0.2.0-rc.2.package-lock.json — commit it
```

> Debug note: the DSH web GUI is not exposed. If you need it, uncomment the
> loopback mapping in `docker-compose.yml` (`127.0.0.1:3081:3080`) and reach it
> through an SSH tunnel — never on a public surface.

## Configuration

| Field | Default | Description |
| --- | --- | --- |
| `prefix` | `/api-gw/v1` | Route prefix |
| `enabled` | `true` | Master switch (also toggleable via the admin endpoint) |
| `apiKeys` | `[]` | Static API keys |
| `provisionedKey` | — | Key minted by `POST {prefix}/key`, persisted in settings |
| `allowKeyProvision` | `true` | Allow the one-time unauthenticated key bootstrap |
| `adminKey` | — | Enables the admin endpoints when set |
| `corsOrigin` | `*` | CORS origin(s) |
| `exposeErrors` | `true` | Include internal error details in responses |
| `allowFullAccess` | `false` | Allow the sandbox route to grant `danger-full-access` (**risk notice**: operator opt-in; the gateway logs a warning at boot and on every hit, and applies no environment restriction) |
| `proxyWhitelist` | default list | Optional whitelist override |

`proxyTarget` is kept only for 0.1.1-era config compatibility (deprecated; its
value no longer takes part in any request path).

## Endpoints

| Method | Path | Auth |
| --- | --- | --- |
| GET | `{prefix}/health` | none |
| POST | `{prefix}/key` | first call only (one-time bootstrap) |
| POST | `{prefix}/admin/enable` | X-Admin-Key |
| POST | `{prefix}/admin/rotate-key` | X-Admin-Key |
| POST | `{prefix}/proxy/<method>` | X-API-Key / Bearer |
| POST | `{prefix}/respond` and `{prefix}/proxy/respond` | X-API-Key / Bearer |
| POST | `{prefix}/sessions/{id}/sandbox-mode` | X-API-Key / Bearer |
| GET | `{prefix}/events.mux` (WebSocket upgrade) | X-API-Key |

`POST {prefix}/proxy/<method>` takes a client-request envelope and returns a
server-response envelope (HTTP is always 200; success lives in `result.ok`).
Methods served in-process: `session.list` / `session.create` / `session.prompt`
/ `session.cancel` / `session.history` (follow-stream snapshot translation) /
`session.rename` / `session.fork` / `session.updateQueue` / `session.attachment`
/ `session.models` (modelCatalog translation) / `session.selectModel` /
`host.describe` (synthesized protocol constant `0.0.1`, DSH-FACTS §6). Anything
whitelisted but not migrated answers 501 `method_not_migrated` — the facade
never silently forwards down a dead path.

`sessions/{id}/sandbox-mode` pins `{ "mode": "read-only" | "workspace-write" }`
(`danger-full-access` requires `allowFullAccess: true`) on a **live** session by
writing a durable `sandbox/mode` log event. Cold/unknown sessions → 409
`session_not_live`. This is the only wire channel that can pin a session's
sandbox mode (used once, right after creation).

`respond` uses the legacy `{ accepted, reason? }` receipts; question claims /
declines (ASK_CANCELLED semantics) / approval outcomes behave exactly as 0.1.1.

The mux upgrade path is also registered at `{prefix}/proxy/events.mux`, so
clients with the uniform "base + method" convention (the manager's rpc base is
`/api-gw/v1/proxy`) need no special case. The mux pipe is **downlink only**
(clients sending frames are closed with 1008). Live traffic = per-session
follow streams (session events) + one host-wide control stream (live
projections as per-key `session/projection` frames). Reconnection is the
client's job.

## Default whitelist

```
session.list, session.create, session.history,
session.prompt, session.cancel, session.rename,
session.fork, session.updateQueue, session.attachment,
session.models, session.selectModel,
respond,  host.describe
```

Anything else → `403 { error: 'method_not_allowed' }` without touching host
services. The privileged plane (`credentials.*`, `settings.*`,
`host.openPath`, `host.pickDirectory`, `llm.discoverModels`, …) is unreachable
through the facade. Note the real method name is `host.describe`
(`host.version` does not exist).

## Security model

- Non-degradable auth: constant-time key comparison, CSPRNG keys, one-time
  key bootstrap (closes permanently once any key exists).
- Fail-closed whitelist; unmigrated methods answer 501 honestly — there is no
  path that silently forwards to a dead channel.
- `respond` only settles pending entries this plugin itself forwarded (rpcId
  match); anything unknown is not-pending.
- Keys are never logged; `apiKeys`/`adminKey` are redacted on the settings wire
  surface.

## Deploy steps

1. Build and commit: `pnpm build && pnpm test` (all green; `lib/` must be
   committed).
2. Update the host install: `dsh plugin update` (or `pnpm install` under
   `profiles/web`).
3. Restart DSH.
4. Run acceptance (below).

## Acceptance

1. `GET {prefix}/health` → 200, `upstream: ok`.
2. `POST {prefix}/proxy/credentials.set` (with a valid key) → 403
   `method_not_allowed`.
3. `POST {prefix}/proxy/session.list` with a wrong key → 401.
4. With a valid key: `POST {prefix}/proxy/host.describe` → `{ version:
   '0.0.1' }`; `session.list` returns the session list.
5. WebSocket to `ws://host{prefix}/proxy/events.mux` (with `X-API-Key` in the
   handshake): after `session.prompt` you should see `session/event` frames up
   to `turn/end`, with projection updates streamed as `session/projection`
   frames.

Automated acceptance: `dsh-agent-manager/scripts/smoke-proxy-b.ts` (the
manager's end-to-end smoke over the proxy path, including a real model turn).

## Uninstall

Remove the plugin row from the composition (optionally
`dsh plugin remove ohdsh-api-facade`) and restart.

## Documentation scope

This repository ships only what consumers need: this README, `README.zh.md`,
`openapi.yaml`, examples, and tests. Internal design and the refactor plan live
in a private design library — the code, the wire contract, and the examples are
the complete, runnable, self-hostable deliverable.

## License

MIT
