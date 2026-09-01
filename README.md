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
    questions: host             # host (leave it to the deployment's UI) | gateway (relay to API clients)
    approvals: host             # host | gateway (relay permission prompts to API clients)
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
| GET | `/sessions/:id/stream` | API key | SSE: hello(replay + open asks)→chunk→message→tool_call/tool_result→question_asked/approval_pending→turn_end |
| GET | `/sessions/:id/history` | API key | Full history of **any** session (read-only) |
| GET | `/sessions/:id/questions` | API key | Questions awaiting an answer, and who owns answering (`answeredBy`) |
| POST | `/sessions/:id/questions/:questionId/answer` | API key | Answer a question, unblocking the tool call |
| POST | `/sessions/:id/questions/:questionId/cancel` | API key | Decline it: the tool call fails and the turn goes on |
| GET | `/sessions/:id/approvals` | API key | Permission prompts awaiting a decision |
| POST | `/sessions/:id/approvals/:decisionId/decide` | API key | `allowed-once` or `rejected` |
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

An agent has two ways to stop and wait for a human: `ask_user_question`, which the model chooses, and a permission prompt, which the runtime raises mid-tool-call. Both block the turn until someone answers. The gateway's job is not to change that — it is to let the someone be an API client instead of a browser.

Nothing here touches the agent, the tool or the model. `ask()` still blocks the tool call and still returns a human answer; the only thing that moves is **where that human sits**.

### Questions: `questions: gateway`

The question is relayed as a frame, and answered over HTTP:

```jsonc
// SSE, no `seq` -- this is live negotiation, not a durable log entry
{ "kind": "question_asked", "sessionId": "...", "questionId": "apigw-q-…",
  "questions": [ { "id": "q1", "question": "Drop the old rows?",
                   "options": [ { "label": "Keep" }, { "label": "Drop", "description": "irreversible" } ] } ] }
```

```bash
curl -X POST "$GW/sessions/$SID/questions/$QID/answer" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"answers":[{"id":"q1","selected":["Keep"]}]}'
```

Every asked question must be answered and every label must be one that was offered (or accompanied by `custom` free text) — the answer becomes a tool result the model acts on, so a partial or invented one is refused with `400` and the question stays open. `POST …/questions/:id/cancel` declines instead: the tool call fails, which the model can act on. `question_resolved` closes the ask for every listener, so the first answer wins.

**Ownership is an offer, not a seizure.** The `userQuestions` slot holds exactly one provider and a second registration *throws* — and the browser UI's backend does not guard its own call, so a gateway that grabbed the slot first would take the whole GUI down with it. So the gateway asks for the slot only when its first session appears (by then the host tree is up, so it always loses a contested slot) and stands down quietly when it is taken. `GET /sessions/:id/questions` reports who actually owns it as `answeredBy`.

To free the slot, disable the `@deepseek-ai/dsh-host-apiproxy` row in the profile. That is the browser UI's backend — **not** the HTTP carrier (`@deepseek-ai/dsh-host-webserver`), so the gateway keeps serving normally; what you give up is the local browser UI for that profile.

### Approvals: `approvals: gateway`

Permission prompts need no slot, because `approval/request` is a waterfall and answerers compose — this can be turned on in a profile that also serves the GUI.

```jsonc
{ "kind": "approval_pending", "decisionId": "apigw-ap-…", "toolName": "write_file", "callId": "…", "reason": "…" }
```

```bash
curl -X POST "$GW/sessions/$SID/approvals/$DID/decide" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"outcome":"allowed-once"}'
```

Only `allowed-once` and `rejected` are accepted, and `allowed-once` is the vocabulary's sole grant: it covers the exact call being decided. There is deliberately no way from here to widen a session's policy or to remember a decision. Prompts for sessions this gateway does not drive are passed straight on to the deployment's own answerers.

### Audit frames (always on)

Independent of the settings above, the approval audit trail is relayed, so a **stopped** turn is never mistaken for a slow one:

| frame | meaning |
| --- | --- |
| `approval_asked` | `{ id, toolName, callId, reason }` — the turn is stopped, waiting on a decision |
| `approval_decided` | `{ id, outcome }` — `allowed-once` / `rejected` / `cancelled` / `unavailable` |
| `approval_policy` | `{ policy, source }` — `ask` or `never` for this session |

With `approvals: host` and nobody watching the deployment's UI, the fail-closed default applies and the outcome is `unavailable`. `policy: never` is the deterministic stance for unattended runs: every prompt is rejected without asking anyone.

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
| Isolation | `danger-full-access`; run in disposable environments/containers | Inherits the deployment sandbox and approval policy; asks and approvals can be relayed to the client and answered over HTTP |
| Best for | One-off isolated tasks from Python scripts without a long-running deployment | Third parties connecting to **your running deployment**, multi-language, unified auth/limits/audit, continuing GUI sessions |

Choose the SDK for disposable Python tasks; choose this gateway for everything that needs a persistent, shared, cross-language door. Don't mix the two: DeepSeek `sk-…` keys don't open this gateway, and `pip install deepseek-harness-sdk` does not connect to it.

## Extensibility (for other plugins)

The gateway publishes these events on the Cordis event bus; other host plugins subscribe with `ctx.on(...)` (listeners are fiber-owned and can never break the gateway):

- `gateway/session-created` → `{ sessionId, mode: 'created' | 'live' | 'resumed', workspace, cwd }`
- `gateway/session-released` → `{ sessionId, mode, disposed }`
- `gateway/message` → `{ sessionId, messageId, text, usage }` (on each committed assistant reply; `usage` is the step's token accounting or `null`)
- `gateway/turn-end` → `{ sessionId, turn, reason, detail, usage, provider, model }` (`usage` is the turn total summed over its steps, `null` when no step reported accounting)
- `gateway/question-asked` → `{ sessionId, questionId, questions }` and `gateway/question-answered` → `{ sessionId, questionId, answers }`
- `gateway/approval-pending` → `{ sessionId, decisionId, toolName, callId, reason }` and `gateway/approval-decided` → `{ sessionId, decisionId, outcome }`

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
| **v0.1.0** | Baseline (current) | REST + SSE, settings card, reasoning/text split, workspace membership, session adopt, interactive questions and approvals answerable over the API, cross-platform docs |
| **v0.2.0** | Multi-tenant security ★ | Multi-key CRUD/revocation, per-key rate limiting (429 + `Retry-After`), **workspace model: per-key isolated + shared collaborative workspaces (`shared`/`isolated`)**, per-key approval policy, audit (requests/sessions/token usage per key), session persistence (resume after restart) |
| **v0.3.0** | Admin UI | Full admin settings page (keys/limits/workspace bindings, session monitor, usage audit, soft switch) + typert `@Remote` config surface (the admin page's foundation) + per-key agent preset selection |
| **v0.4.0** | Duplex streaming | `webServer.registerUpgrade` WebSocket full-duplex (send/stream/cancel on one connection); SSE stays as the lightweight option. Questions and approvals already work over SSE + POST; duplex buys lower round-trip latency and server-initiated withdrawal |
| **v0.5.0** | Ecosystem & ops | Python/Node HTTP thin clients (OpenAPI-generated — **not** the official embedded SDK, see above), deployment guide (reverse proxy + TLS, Docker Compose), metrics/telemetry export, OpenAPI generation in CI |

**Out of scope / deferred**: horizontal multi-process scaling, built-in TLS termination (a reverse proxy's job), OAuth/OIDC (revisit after the key-based model settles).

## License

MIT
