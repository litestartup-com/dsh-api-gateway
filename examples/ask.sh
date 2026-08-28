#!/usr/bin/env bash
# ask.sh — chat with a DeepSeek Harness agent through dsh-api-gateway.
#
# Needs bash 4+, curl and jq. If you'd rather not install jq, examples/ask.py is
# the same tool with no dependencies at all.
#
#   ./examples/ask.sh "介绍一下你自己"      # ask once, print the answer
#   ./examples/ask.sh                      # interactive: many turns, one session
#   ./examples/ask.sh --list               # what sessions can I see?
#
# Notices go to stderr and the answer to stdout, so `ask.sh "..." > answer.txt`
# keeps just the answer. Exit codes: 0 ok, 1 request/usage error, 2 timeout.
set -uo pipefail

BASE="${DSH_AGW_BASE:-http://127.0.0.1:3080/api-gw/v1}"
KEY="${DSH_AGW_KEY:-}"
SESSION=""
CWD=""
PROVIDER=""
MODEL=""
STREAM=1
REASONING=0
TIMEOUT=300
QUIET=0
ACTION=ask
PROMPT=""

usage() {
  cat <<'EOF'
ask.sh — ask a DeepSeek Harness agent through dsh-api-gateway

  ask.sh [options] [prompt]     ask once and print the answer
  ask.sh [options]              interactive: many turns in one session
  ask.sh --list                 list sessions the gateway can see
  ask.sh --health               gateway status (no key needed)

  -b, --base URL       gateway base URL (env DSH_AGW_BASE)
  -k, --key KEY        API key (env DSH_AGW_KEY); claimed via POST /key when unset
  -s, --session ID     talk to an existing session (adopts it first)
  -c, --cwd PATH       working directory for a new session (decides its workspace)
  -p, --provider ID    LLM provider for a new session
  -m, --model ID       model for a new session
      --no-stream      poll GET /history instead of streaming SSE
      --reasoning      also print the thinking trace (stderr)
      --timeout SEC    per-turn timeout, default 300
  -q, --quiet          answer only, no notices
  -h, --help           this text
EOF
}

note() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*" >&2; }
die() { printf 'ask.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    -b|--base) BASE="$2"; shift 2 ;;
    -k|--key) KEY="$2"; shift 2 ;;
    -s|--session) SESSION="$2"; shift 2 ;;
    -c|--cwd) CWD="$2"; shift 2 ;;
    -p|--provider) PROVIDER="$2"; shift 2 ;;
    -m|--model) MODEL="$2"; shift 2 ;;
    --no-stream) STREAM=0; shift ;;
    --reasoning) REASONING=1; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    -q|--quiet) QUIET=1; shift ;;
    -l|--list) ACTION=list; shift ;;
    --health) ACTION=health; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) PROMPT="${PROMPT:+$PROMPT }$1"; shift ;;
  esac
done

command -v curl >/dev/null || die 'curl not found'
command -v jq >/dev/null || die 'jq not found (or use examples/ask.py, which needs nothing)'

# One JSON round trip: prints the response body, fails loudly on HTTP >= 400.
api() {
  local method="$1" path="$2" body="${3:-}" out status
  local -a args=(-sS -X "$method" "$BASE$path" -w '\n%{http_code}')
  [ -n "$KEY" ] && args+=(-H "Authorization: Bearer $KEY")
  if [ -n "$body" ]; then
    # Declare the charset so the gateway decodes the body as UTF-8, and pass the
    # JSON via --data-binary @- to keep quoting out of the shell's way.
    args+=(-H 'Content-Type: application/json; charset=utf-8' --data-binary @-)
    out=$(printf '%s' "$body" | curl "${args[@]}") || die "$method $path failed (is dsh running?)"
  else
    out=$(curl "${args[@]}") || die "$method $path failed (is dsh running?)"
  fi
  status="${out##*$'\n'}"
  out="${out%$'\n'*}"
  [ "$status" -ge 400 ] && die "$method $path -> $status $out"
  printf '%s' "$out"
}

resolve_key() {
  [ -n "$KEY" ] && return 0
  KEY=$(api POST /key | jq -r '.apiKey')
  note "claimed API key: $KEY"
  note '  reuse it via DSH_AGW_KEY or --key (a second claim is refused)'
}

open_session() {
  if [ -n "$SESSION" ]; then
    local adopted
    adopted=$(api POST "/sessions/$SESSION/adopt")
    note "adopted $SESSION (mode=$(jq -r '.mode' <<<"$adopted"), cwd=$(jq -r '.cwd' <<<"$adopted"))"
    return 0
  fi
  local body created
  body=$(jq -nc \
    --arg provider "$PROVIDER" --arg model "$MODEL" --arg cwd "$CWD" \
    '{} | if $provider != "" then .provider = $provider else . end
        | if $model != "" then .model = $model else . end
        | if $cwd != "" then .cwd = $cwd else . end')
  created=$(api POST /sessions "$body")
  SESSION=$(jq -r '.sessionId' <<<"$created")
  note "session $SESSION ($(jq -r '.provider + "/" + .model' <<<"$created"), workspace=$(jq -r '.workspace.title // "-"' <<<"$created"))"
}

send_message() {
  api POST "/sessions/$SESSION/messages" "$(jq -nc --arg content "$1" '{ content: $content }')" >/dev/null
}

# Attach the stream BEFORE sending the prompt: the server closes a stream at
# `turn_end`, so a client that attaches after the turn finished waits for an
# event that never comes. The `hello` frame confirms we're attached (and replays
# the history so far, which is why attaching early is harmless).
stream_turn() {
  local raw waited=0 line json kind
  raw=$(mktemp)
  curl -sN --max-time "$TIMEOUT" -H "Authorization: Bearer $KEY" \
    -H 'Accept: text/event-stream' "$BASE/sessions/$SESSION/stream" >"$raw" &
  local sse=$!
  until grep -q '"kind":"hello"' "$raw" 2>/dev/null; do
    sleep 0.1
    waited=$((waited + 1))
    if [ "$waited" -gt 100 ] || ! kill -0 "$sse" 2>/dev/null; then
      kill "$sse" 2>/dev/null; rm -f "$raw"
      die "stream did not open (key rejected, or session $SESSION is not tracked)"
    fi
  done
  send_message "$1"
  tail -n +1 -f "$raw" | while IFS= read -r line; do
    case "$line" in 'data: '*) json="${line#data: }" ;; *) continue ;; esac
    kind=$(jq -r '.kind' <<<"$json")
    case "$kind" in
      chunk)
        if [ "$REASONING" -eq 1 ]; then
          jq -j 'if .chunk.type == "text-delta" then .chunk.text else empty end' <<<"$json"
          jq -j 'if .chunk.type == "reasoning-delta" then .chunk.text else empty end' <<<"$json" >&2
        else
          jq -j 'if .chunk.type == "text-delta" then .chunk.text else empty end' <<<"$json"
        fi
        ;;
      turn_end)
        printf '\n'
        [ "$(jq -r '.reason' <<<"$json")" = completed ] || note "turn ended: $(jq -r '.reason' <<<"$json")"
        break
        ;;
    esac
  done
  kill "$sse" 2>/dev/null
  wait "$sse" 2>/dev/null
  rm -f "$raw"
}

history_message_count() {
  api GET "/sessions/$SESSION/history" | jq '[.events[] | select(.kind == "message")] | length'
}

poll_turn() {
  local seen waited=0 messages
  seen=$(history_message_count)
  send_message "$1"
  while [ "$waited" -lt "$TIMEOUT" ]; do
    sleep 2
    waited=$((waited + 2))
    messages=$(api GET "/sessions/$SESSION/history" | jq -c '[.events[] | select(.kind == "message")]')
    if [ "$(jq 'length' <<<"$messages")" -gt "$seen" ]; then
      [ "$REASONING" -eq 1 ] && jq -r 'last | .reasoning // empty' <<<"$messages" >&2
      jq -r 'last | .text // ""' <<<"$messages"
      return 0
    fi
  done
  printf 'ask.sh: no reply within %ss\n' "$TIMEOUT" >&2
  exit 2
}

turn() { if [ "$STREAM" -eq 1 ]; then stream_turn "$1"; else poll_turn "$1"; fi; }

case "$ACTION" in
  health)
    api GET /health | jq .
    exit 0
    ;;
  list)
    resolve_key
    rows=$(api GET /sessions/discover \
      | jq -r '.sessions[] | [.sessionId, (if .live then "live" elif .persisted then "saved" else "-" end), (.title // "(untitled)")] | @tsv')
    [ -z "$rows" ] && { printf '(no sessions)\n'; exit 0; }
    if command -v column >/dev/null; then printf '%s\n' "$rows" | column -t -s $'\t'; else printf '%s\n' "$rows"; fi
    exit 0
    ;;
esac

resolve_key
open_session

if [ -n "$PROMPT" ]; then
  turn "$PROMPT"
  exit 0
fi

note 'interactive mode — empty line or Ctrl-D to quit'
while true; do
  [ "$QUIET" -eq 1 ] || printf '> ' >&2
  IFS= read -r line || { printf '\n' >&2; exit 0; }
  [ -z "${line// /}" ] && exit 0
  turn "$line"
done
