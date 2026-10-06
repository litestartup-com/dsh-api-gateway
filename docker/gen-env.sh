#!/usr/bin/env bash
# Generate/complete .env for the standalone API stack (idempotent: an existing non-empty
# value is never overwritten). Same pattern as dsh-agent-manager/scripts/gen-env.sh.
#
# Usage: bash docker/gen-env.sh [env file]     (default: .env in the repo root)
#        DEEPSEEK_API_KEY / GW_KEY / HTTP_PORT / NGINX_IMAGE can be pre-set by exporting
#        them — exported values win over generated defaults.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$REPO_ROOT/.env}"
gen() { openssl rand -hex 32; }

ensure() { # key value
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null || [ -z "$(grep "^${key}=" "$ENV_FILE" | cut -d= -f2-)" ]; then
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

[ -f "$ENV_FILE" ] || : > "$ENV_FILE"

# Deployment red line A: the container runtime uid must equal the host file owner uid.
# Without these, compose falls back to 1000:1000 and any non-1000 deploy user loses
# write access to the ./workspaces bind mount. Every bootstrap path writes them.
ensure HOST_UID "$(id -u)"
ensure HOST_GID "$(id -g)"
ensure HTTP_PORT "${HTTP_PORT:-80}"
ensure NGINX_IMAGE "${NGINX_IMAGE:-nginx:alpine}"
ensure DSH_VERSION "${DSH_VERSION:-0.2.0-rc.2}"
ensure GW_KEY "${GW_KEY:-apigw-$(openssl rand -hex 24)}"
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  ensure DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"
fi
# OpenAI-compatible route: carried over when exported (OPENAI_BASE_URL alone activates
# it; the entrypoint resolves provider/models/defaults — see .env.example).
for k in OPENAI_BASE_URL OPENAI_API_KEY OPENAI_PROVIDER OPENAI_MODELS OPENAI_MODEL \
         OPENAI_API OPENAI_CONTEXT_WINDOW OPENAI_MAX_TOKENS FACADE_MODEL; do
  v="$(printenv "$k" 2>/dev/null || true)"
  if [ -n "$v" ]; then ensure "$k" "$v"; fi
done

chmod 600 "$ENV_FILE"
mkdir -p "$REPO_ROOT/workspaces"

echo "[gen-env] $ENV_FILE ready (idempotent)."
HAS_DSK=0; grep -q '^DEEPSEEK_API_KEY=..' "$ENV_FILE" && HAS_DSK=1
HAS_OAI=0; grep -q '^OPENAI_BASE_URL=..' "$ENV_FILE" && HAS_OAI=1
if [ "$HAS_DSK" = 0 ] && [ "$HAS_OAI" = 0 ]; then
  echo "[gen-env] WARNING: neither DEEPSEEK_API_KEY nor an OPENAI_BASE_URL route is set -- the"
  echo "[gen-env]          node will boot and serve the API surface, but session turns will"
  echo "[gen-env]          fail until you fill in one of them."
fi
