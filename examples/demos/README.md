# Web demos — KB Studio & Support widget

Two web demos that share **one** standalone API node (the base compose stack in the
repo root). They tell the two halves of the facade story:

| Demo | URL | Sandbox pin | What it shows |
| --- | --- | --- | --- |
| **KB Studio** | `http://<host>:${HTTP_PORT}/kb/` | `workspace-write` | Managing a knowledge base: direct file CRUD from the UI **plus** an AI steward that drafts/reorganizes notes over natural language — with every tool approval auto-decided by the BFF and echoed in the chat |
| **Support widget** | `http://<host>:${HTTP_PORT}/cs/` | `read-only` | A customer-service agent grounded in the same knowledge base: it can read everything, change nothing, and asks clarifying questions that render as interactive chat cards |

The knowledge base is **this project's own documentation** (synced from the repo), so
the support widget doubles as a real support channel for ohdsh-api-facade.

## Architecture (the BFF pattern)

```
browser ──HTTP/SSE──▶ demo BFF (holds GW_KEY) ──/api-gw/v1──▶ gateway container
                       zero-dep node server                    DSH host + facade
                       mux WS → SSE bridge                     sessions pinned per demo
```

- The facade API key **never reaches the browser** — each demo is a small
  backend-for-frontend that owns its sessions, its approval policy, and the
  WebSocket→SSE bridge.
- Both demos share the base stack's single gateway node: one DSH host serving
  multiple applications, each session pinned to its own sandbox mode via
  `POST {prefix}/sessions/{id}/sandbox-mode` right after creation.
- Personas come from `AGENTS.md` files seeded into each workspace — the harness
  injects them as workspace instructions, no prompt hacks.
- Everything is **zero-dependency** (node ≥ 20 builtins only, vanilla JS, vendored
  marked + DOMPurify): no package.json, no build step.

## Run

Prerequisite: the base stack is configured (`.env` with `GW_KEY` and
`DEEPSEEK_API_KEY` — see the repo root README "Docker deployment").

```bash
mkdir -p workspaces/kb workspaces/cs
docker compose -f docker-compose.yml -f examples/demos/compose.demos.yml up -d --build
```

Then open `http://<host>:${HTTP_PORT}/kb/` and `…/cs/`.

The KB's `content/docs/` area is seeded from the docs baked into the kb image; the
**⟳ Refresh from repo** button re-syncs it (rebuild the image after repo doc changes).
`content/notes/` is the free CRUD area — the welcome note explains the layout.

## Layout

```
examples/demos/
├── lib/facade-client.mjs    zero-dep facade wire client (RPC, respond, sandbox pin,
│                            pending recovery, raw-WS mux with auto-reconnect)
├── lib/chat-bridge.mjs      session store + mux→SSE bridging + approval policy hook
├── lib/http-util.mjs        JSON/SSE/static/path-guard helpers
├── kb/server.mjs            KB Studio BFF (file CRUD + docs sync + chat)
├── kb/public/               KB Studio UI
├── cs/server.mjs            Support widget BFF (read-only sessions + chat)
├── cs/public/               Support widget UI
├── seed/kb/                 KB persona (AGENTS.md) + welcome note
├── seed/cs/                 support persona (AGENTS.md)
├── web/style.css            shared design system
├── web/vendor/              vendored marked.min.js + purify.min.js (MIT)
├── nginx/locations.d/       /kb/ and /cs/ proxy locations (mounted over the base)
└── compose.demos.yml        the overlay (two BFF services + nginx rewiring)
```

## What each demo exercises on the wire

- `session.create` + `sessions/{id}/sandbox-mode` pin (per-demo permission posture)
- `session.prompt` (queue mode) and `session.history` (transcript on page load)
- mux WebSocket: `session/event` frames (`assistant/chunk` text/reasoning deltas →
  live typing, `tool/call`/`tool/result` → activity chips, `turn/end` → finalize)
- the respond bridge: `question/requested` → interactive card → `POST /respond`
  receipt; `approval/requested` → BFF policy (KB: auto `allowed-once` — the pinned
  sandbox is the real guard; CS: auto `rejected`, defense in depth)
- `GET answerer/pending` on every mux (re)connect — card-loss recovery

## Demo-grade caveats (be honest, they are examples)

- The BFF endpoints themselves are unauthenticated: fine on a LAN/dev box, **do not
  expose /kb/ or /cs/ publicly without adding an auth layer in front of the BFFs**.
- The KB steward auto-approves tool calls (transparency in the chat log). A real
  deployment should implement a genuine approval policy in `approvalPolicy`.
- Sessions accumulate (no `session.delete` on the whitelist yet): "New conversation"
  just drops the local sid; the node keeps old sessions until the volume is cleared.
- Markdown rendering is sanitized with DOMPurify, but treat any user-facing deployment
  to a full security review first.
