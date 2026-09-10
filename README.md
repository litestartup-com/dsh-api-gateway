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

## Install

```powershell
dsh plugin --profile web add github:litestartup-com/dsh-api-gateway
```

Add one row to the host composition (see `examples/cordis.yml`) and restart DSH.

> Naming note: DSH ships a built-in package named `@deepseek-ai/dsh-api-gateway`
> (the typert dispatcher) which is unrelated to this plugin. This plugin is the
> **external HTTP facade**; its settings namespace / composition row / service
> field are all `ohdsh-api-facade`.

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
