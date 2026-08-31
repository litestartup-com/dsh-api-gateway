# dsh-api-gateway

English | [中文](README.zh.md)

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that turns a running Harness into an HTTP API: any third-party client — curl, Python, a browser, an IM bridge — can create agent sessions, stream replies token-by-token over SSE, and continue conversations started in the Web UI, all behind API-key authentication. API sessions drive the same agent machine the GUI drives (inbox + session log), so both worlds stay in sync.

```sh
dsh plugin --profile web add github:litestartup-com/dsh-api-gateway
```

## Features

- **REST + SSE**: 10 endpoints; token-level streaming (`assistant/chunk`), server closes the stream at `turn_end`
- **GUI settings card**: Settings → Plugins → Configurable → **dsh-api-gw** (collapsed by default, discloses via the chevron; status, soft on/off, key rotation). English by default, Chinese when the page or browser asks for it
- **Workspace membership**: API sessions land in real workspaces and show grouped in the sidebar, never under "ungrouped"
- **Session discovery & adoption**: list all sessions, read any session's full history (read-only), and adopt a GUI session to keep driving it over the API — live co-driving or cold resume with full context
- **Reasoning split**: replies separate `text` (visible answer) from `reasoning` (thinking), never concatenated
- **No silent blocking**: interactive question cards are handed back to the model as a conversational question, so a turn never stalls on a card nobody can click; permission prompts are relayed as `approval_asked` / `approval_decided` frames instead of looking like a slow turn
- **Extensible**: publishes `gateway/session-created` / `gateway/session-released` / `gateway/message` / `gateway/turn-end` on the Cordis event bus for other host plugins
- **Any language client**: works from Linux/macOS/Windows, PowerShell included (UTF-8 aware, GBK-tolerant server side)

## Install

### Recommended: `dsh plugin add`

```sh
# from GitHub (prebuilt lib/ committed — no build approval needed)
dsh plugin --profile web add github:litestartup-com/dsh-api-gateway

# from a packed tarball
dsh plugin --profile web add ./dsh-api-gateway-0.1.0.tgz
```

> The built `lib/` is committed, so GitHub installs need no build approval. Build scripts run only when packing or publishing (`prepack`).

Uninstall: `dsh plugin --profile web remove dsh-api-gateway`.

### Manual composition row (no CLI)

The plugin is an ordinary Cordis row; you can also compose it by hand. It publishes a cross-session HTTP surface, so it belongs in the **host composition** (or the profile's patch layer) — never inside an agent preset:

```yaml
- id: dsh-api-gw
  name: dsh-api-gateway
  config:
    prefix: /api-gw/v1          # route prefix
    enabled: true               # master switch (also toggleable at runtime)
    apiKeys: []                 # pre-provisioned static API keys
    allowKeyProvision: true     # one-time POST /key bootstrap (only while no key exists)
    # provisionedKey            # written by the gateway itself -- do not set by hand
    adminKey: change-me         # enables admin endpoints + card controls
    maxSessions: 20             # concurrent session cap
    workspaceMode: auto         # auto (join a workspace) | ungrouped
    defaultWorkspacePath: ''    # fallback directory for auto mode
    allowDiscover: true         # GET /sessions/discover
    allowAdopt: true            # POST /sessions/:id/adopt
    corsOrigin: '*'             # '*' or an explicit origin / list (list is matched against the request Origin)
    exposeErrors: true          # include internal details in error responses
    questionMode: conversation  # conversation (ask in the reply) | host (leave it to the GUI)
    sseHeartbeatMs: 30000       # SSE heartbeat interval (0 disables)
    bodyTimeoutMs: 30000        # request body read timeout
```

Every key has a schema default — see `examples/cordis.yml` for the annotated row.

## Quick start

With DSH running, ask an agent something. The script claims the API key, opens a
session, sends the prompt and prints the reply token by token:

```bash
./examples/ask.py "introduce yourself"     # any OS, stdlib only
```

```powershell
.\examples\ask.ps1 "introduce yourself"    # Windows-native, no extra tools
```

Drop the prompt for interactive mode (many turns, one session). `--help` lists
everything; the flags you'll actually reach for:

| Flag | Meaning |
| --- | --- |
| `-s <id>` | talk to an existing session — including one open in the GUI |
| `-l` | list every session the gateway can see |
| `--no-stream` | skip SSE, poll for the final answer |
| `-c <path>` | working directory (and therefore workspace) of a new session |

The raw protocol, if you'd rather see the wire:

```bash
BASE=http://127.0.0.1:3080/api-gw/v1
KEY=$(curl -s -X POST $BASE/key | jq -r .apiKey)                       # claimable once ever; the key itself is durable
SID=$(curl -s -X POST $BASE/sessions -H "Authorization: Bearer $KEY" | jq -r .sessionId)
curl -sN $BASE/sessions/$SID/stream -H "Authorization: Bearer $KEY" &   # attach before asking
curl -s -X POST $BASE/sessions/$SID/messages -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"content":"hello"}'         # 202 accepted
```

### Client examples

Three readable, self-documenting clients — same flags, same behaviour:

| Script | Needs | Notes |
| --- | --- | --- |
| `examples/ask.py` | Python 3.8+ | stdlib only; the reference client |
| `examples/ask.ps1` | PowerShell 5.1+ | UTF-8 safe on Windows |
| `examples/ask.sh` | bash 4+, curl, jq | |

Two things they get right that ad-hoc snippets often don't:

- **Attach the stream before sending.** The server ends a stream at `turn_end`, so a client that attaches after the turn finished waits forever; attaching early is free because the first `hello` frame replays the history. Missed the turn entirely? Read `GET /sessions/:id/history`.
- **Declare the charset.** The server decodes bodies per the request `Content-Type` (UTF-8 default, GBK-tolerant). PowerShell 5.1 otherwise sends ANSI/GBK and mangles non-ASCII prompts, and `curl.exe -d '{"a":"b"}'` under PowerShell 5.1 loses the inner quotes (invalid JSON → 400, silenced by `-s`). Send UTF-8 bytes, or `--data-binary "@file"`.

## Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | none | Status (reachable while disabled) |
| POST | `/key` | first call only (no key set) | Bootstrap an API key; persisted, then closed for good |
| POST | `/sessions` | API key | Create a session (`provider/model/maxTokens/cwd/workspace`) |
| GET | `/sessions/discover` | API key | List sessions (id/title/cwd/live/persisted) — no content |
| POST | `/sessions/:id/adopt` | API key | Adopt an existing session (`live` co-drive / `resumed` cold-resume); returns full history |
| POST | `/sessions/:id/messages` | API key | Send a message (string or block array) |
| GET | `/sessions/:id/stream` | API key | SSE: hello(replay)→chunk→message→tool_call/tool_result→approval_asked/approval_decided→turn_end |
| GET | `/sessions/:id/history` | API key | Full history of **any** session (read-only) |
| POST | `/sessions/:id/cancel` | API key | Cancel the active turn |
| DELETE | `/sessions/:id` | API key | Release the session's `maxSessions` slot — **history is kept** |
| POST | `/admin/enable` | Admin key | Runtime soft switch `{"enabled": bool}` |
| POST | `/admin/rotate-key` | Admin key | Rotate `provisionedKey` (leaves `apiKeys` untouched) |

Auth headers, either form: `Authorization: Bearer <key>` (recommended, RFC 6750) or `X-API-Key: <key>`.

Full spec: [openapi.yaml](./openapi.yaml).

### Releasing sessions

`maxSessions` caps how many sessions this gateway holds, and creation fails once the cap is reached. `DELETE /sessions/:id` gives a slot back, which matters for clients that open a session per task: without it a long-running deployment reaches the cap and then cannot create *or* adopt anything until the gateway is reloaded.

What it does and does not do:

| | |
| --- | --- |
| Frees the `maxSessions` slot | yes |
| Ends open SSE streams for that session | yes |
| Disposes the agent | only when this gateway owns it (`created` / `resumed`) |
| Touches a co-driven GUI session (`live`) | **no** — it stops tracking, the Web UI keeps its session |
| Deletes the transcript | **no** — `GET /sessions/:id/history` keeps working and `POST /sessions/:id/adopt` brings the session back |

It is idempotent: releasing an unknown or already-released id answers `200` with `released: false`, so a client can call it unconditionally in a cleanup path. A turn still in flight is cancelled first.

```jsonc
// DELETE /api-gw/v1/sessions/<id>
{ "ok": true, "sessionId": "...", "released": true, "disposed": true, "mode": "created", "historyRetained": true }
```

## Interactive asks (questions and approvals)

A Harness agent has two ways to stop and wait for a human, and they are not the same problem. The gateway treats them differently on purpose.

### Questions become conversation

The `ask_user_question` tool blocks a tool call until someone answers a card in the Web GUI. For an API-driven session that card is unanswerable: the turn would hang until it is cancelled, its duration and cost would stop meaning anything, and an unattended client (cron, CI, an IM bridge) would simply stall.

So `questionMode: conversation` (the default) gives the gateway's own sessions a provider that hands the question **back to the model**, telling it to ask in its reply and end the turn. The client then answers with an ordinary `POST /sessions/:id/messages`. No new endpoint, no protocol state, no held-open turn — and the question, the answer and the cost all land in the transcript like any other exchange.

```jsonc
// what the client sees: a failed tool call carrying the instruction, then a normal reply
{ "kind": "tool_result", "isError": true, "text": "This session is driven remotely through the API gateway…" }
{ "kind": "message", "text": "Two options here: (1) keep the old rows, (2) drop them. Which?" }
```

This applies **only to sessions the gateway created or resumed**. A co-driven GUI session (`live`) keeps the deployment's own provider: someone is watching that browser, and stealing their card would be worse than not handling it. Set `questionMode: host` to opt out entirely and leave every question to the GUI.

> Implementation note, because it is easy to get wrong: the provider slot is a single field that throws `DUPLICATE_PROVIDER` on a second registration, so the gateway does **not** register alongside the GUI. It takes a private service scope (`ctx.isolate`) and registers there, leaving the host slot untouched. `test/questions.test.mjs` pins that behaviour against the real packages.

### Approvals are visible, not yet answerable

A permission prompt is raised by the runtime in the middle of a tool call, not chosen by the model — there is nothing to reword and no way to defer it. It cannot be turned into conversation, so the gateway relays the audit trail instead:

| frame | meaning |
| --- | --- |
| `approval_asked` | `{ id, toolName, callId, reason }` — the turn is **stopped**, not slow |
| `approval_decided` | `{ id, outcome }` — `allowed-once` / `rejected` / `cancelled` / `unavailable` |
| `approval_policy` | `{ policy, source }` — `ask` or `never` for this session |

That closes the worst gap, which was that a blocked turn and a thinking turn looked identical over the API. It does not let an API client *decide*: with no answerer composed, the deployment's fail-closed default applies and the outcome is `unavailable`. Until answering lands (v0.2.0), an API-only deployment has two honest options — watch the GUI to answer prompts, or run under `policy: never` and accept deterministic rejection.

## Security model

**Why can `POST /key` just hand out a key?** It's a first-call bootstrap, not an open mint:

- Only when **no key exists at all** (`apiKeys` empty **and** `provisionedKey` unset) does `POST /key` generate a 32-char random key.
- The key is **persisted before it is returned**, into the settings scope as `provisionedKey`. So it keeps working across restarts, and the bootstrap closes **permanently** — every later call gets 403 `key_already_provisioned`. That is what "once" means here: **once ever**, not once per restart.
- By default the gateway listens on loopback, so the only possible "first caller" is you, the deployer — equivalent to setting a password at first boot.
- A deployment that configures `apiKeys` has the bootstrap closed from the start: configuring a key *is* having a key.
- Don't trust the window? Close it: `allowKeyProvision: false`, keys only from `apiKeys: [...]`.
- Rotate with `POST /admin/rotate-key` (needs `adminKey`). It replaces `provisionedKey` only and leaves `apiKeys` alone — that list is the operator's, and the gateway has no business revoking it.
- Keys are **never logged**. To check whether a key is set, read `apiKeySet` from `GET /health`.

> A deployment with no settings provider cannot persist anything, so it falls back to an in-memory key (lost on restart), reports `persisted: false`, and logs a warning. Such deployments should use `apiKeys` directly.

Defense in depth (production checklist):

1. `allowKeyProvision: false` + pre-provisioned `apiKeys`
2. Keep the gateway loopback-bound; put a reverse proxy + TLS in front if exposed
3. Separate `adminKey` from API keys
4. Per-session agent contexts; session ids are cryptographically random
5. `Authorization: Bearer` as the canonical header (`X-API-Key` kept as an alias)
6. Constant-time key comparison (`crypto.timingSafeEqual`), CSPRNG key generation

Known gaps (public, see roadmap): no per-key rate limiting/quotas, no revocation list, no multi-key management UI, no audit. For hostile multi-tenant scenarios wait for v0.2+, or front the gateway yourself. Holding an API key can discover/read/adopt **all** sessions — a feature for single-owner setups, a risk otherwise; disable via `allowDiscover`/`allowAdopt` (per-key allowlists land in v0.2.0).

## Workspace membership

API sessions join workspaces just like GUI sessions — sidebar shows them grouped, never "ungrouped". `POST /sessions` accepts `workspace` in three forms:

```jsonc
{ "workspace": "C:\\projects\\team-a" }                                // path string
{ "workspace": { "path": "C:\\projects\\team-a", "title": "Team A" } } // + title on create
{ "workspace": { "id": "ws-xxx" } }                                    // existing workspace id
```

Rules (deterministic, server-side):

- Path resolves to an existing workspace → reused; otherwise **auto-created** (title defaults to the basename)
- Unknown `id` → 400 with the current workspace list (id/title/path)
- No `workspace` → `workspaceMode`: `auto` (default — resolve-or-create for the session cwd / `defaultWorkspacePath`) or `ungrouped`
- Both `cwd` and `workspace` given → workspace wins; session cwd is forced to the workspace canonical path (the durable membership invariant: header cwd == workspace path)
- Path pointing at a missing directory → 400 (the gateway never creates directories)

Responses and `history` include `workspace: { id, path, title }`. Shared collaborative workspaces (multiple keys on one path) arrive in v0.2.0.

## Session discovery & adoption (continue GUI sessions over the API)

```bash
# ① discover sessions
curl -s $BASE/sessions/discover -H "Authorization: Bearer $KEY"

# ② adopt one: live co-driving, or cold resume; returns the full history
curl -s -X POST $BASE/sessions/$SID/adopt -H "Authorization: Bearer $KEY"
# → { "mode": "live" | "resumed", "history": [...] }

# ③ keep chatting — identical to gateway-created sessions
curl -s -X POST $BASE/sessions/$SID/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"content":"continue where we left off"}'
```

| mode | Meaning | Lifecycle |
| --- | --- | --- |
| `created` | Gateway-created session | Owned by the gateway |
| `live` | **Co-driving** a GUI-open session: API messages appear in the GUI flow, turns queue from both sides | Borrowed only — plugin stop just untracks it |
| `resumed` | Cold-resume of an offline session (needs `sessionPersistence`) | Owned by the gateway after resume |

`GET /sessions/:id/history` works for **any** session (read-only, no adoption needed); `/messages`, `/stream`, `/cancel` require adoption first.

## vs the official Python SDK

DeepSeek Harness also ships an official **Python SDK** ([tutorial](https://deepseek-harness.github.io/deepseek-harness/guide/python-sdk) / [SDK reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.md)). The two are **not the same thing and not substitutes**:

| | Official Python SDK | This gateway |
| --- | --- | --- |
| Nature | **Embedded runtime**: `pip install deepseek-harness-sdk` ships a platform wheel and drives a bundled `dsh-jsonrpc-agent` **subprocess** over JSON-RPC stdio | **A door into a running Harness**: a host-composition plugin exposing REST + SSE |
| Model credentials | DeepSeek API keys (`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`) | Gateway's own API keys (independent of model credentials) |
| Sessions | Private JSONL under `session_root`, unrelated to any deployment or GUI | The deployment's shared session corpus: GUI-visible, workspace-grouped, adoptable |
| Capabilities | Minimal default composition (local bash etc., no skills, no compaction; customizable via `cordis`) | The deployment's default agent preset (tools/skills/sandbox policy) |
| Platforms | Linux x64/arm64, macOS 14+ arm64; **no Windows** | Any client language/platform, Windows PowerShell included |
| Isolation | `danger-full-access`; run in disposable environments/containers | Inherits the deployment sandbox and approval policy (asks are relayed for audit; answering them lands in v0.2.0) |
| Best for | One-off isolated tasks from Python scripts without a long-running deployment | Third parties connecting to **your running deployment**, multi-language, unified auth/limits/audit, continuing GUI sessions |

Choose the SDK for disposable Python tasks; choose this gateway for everything that needs a persistent, shared, cross-language door. Don't mix the two: DeepSeek `sk-…` keys don't open this gateway, and `pip install deepseek-harness-sdk` does not connect to it.

## Extensibility (for other plugins)

The gateway publishes three events on the Cordis event bus; other host plugins subscribe with `ctx.on(...)` (listeners are fiber-owned and can never break the gateway):

- `gateway/session-created` → `{ sessionId, mode: 'created' | 'live' | 'resumed', workspace, cwd }`
- `gateway/message` → `{ sessionId, messageId, text, usage }` (on each committed assistant reply; `usage` is the step's token accounting or `null`)
- `gateway/turn-end` → `{ sessionId, turn, reason, detail, usage, provider, model }` (`usage` is the turn total summed over its steps, `null` when no step reported accounting)

Typical uses: audit persistence, external alerting, forwarding to IM/webhooks, custom rate-limit sidecars.

## Development & testing

```sh
pnpm install
pnpm build        # tsc
pnpm smoke        # end-to-end smoke against a running gateway
```

Smoke env: `DSH_AGW_BASE` (default `http://127.0.0.1:3080/api-gw/v1`), `DSH_AGW_KEY` (optional — claims a key if absent), `DSH_AGW_PROMPT`. CI (`.github/workflows/ci.yml`) runs build + syntax checks, with an optional smoke job activated by repository variables.

## Roadmap

Milestones ordered by "security first, then experience, then ecosystem"; each version ships independently.

| Version | Theme | Contents |
| --- | --- | --- |
| **v0.1.0** | Baseline (current) | REST + SSE, settings card, reasoning/text split, workspace membership, session adopt, cross-platform docs |
| **v0.2.0** | Multi-tenant security ★ | Multi-key CRUD/revocation, per-key rate limiting (429 + `Retry-After`), **workspace model: per-key isolated + shared collaborative workspaces (`shared`/`isolated`)**, per-key approval policy **and answering approvals over the API** (`approval_request` frame + a decision endpoint), audit (requests/sessions/token usage per key), session persistence (resume after restart) |
| **v0.3.0** | Admin UI | Full admin settings page (keys/limits/workspace bindings, session monitor, usage audit, soft switch) + typert `@Remote` config surface (the admin page's foundation) + per-key agent preset selection |
| **v0.4.0** | Duplex streaming | `webServer.registerUpgrade` WebSocket full-duplex (send/stream/cancel on one connection); SSE stays as the lightweight option; **opt-in relay of interactive question cards** (including `plan-review`, whose verdict is machine-readable and therefore the one case prose cannot replace) for rich clients — a stateful bidirectional flow that belongs on duplex, not on SSE |
| **v0.5.0** | Ecosystem & ops | Python/Node HTTP thin clients (OpenAPI-generated — **not** the official embedded SDK, see above), deployment guide (reverse proxy + TLS, Docker Compose), metrics/telemetry export, OpenAPI generation in CI |

**Out of scope / deferred**: horizontal multi-process scaling, built-in TLS termination (a reverse proxy's job), OAuth/OIDC (revisit after the key-based model settles).

## License

MIT
