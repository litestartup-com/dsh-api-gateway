#!/usr/bin/env bash
# Standalone API node entrypoint. Idempotent: a restart does not re-seed the profile
# and does not overwrite settings that already carry the current key.
# Adapted from dsh-agent-manager/images/node/entrypoint.sh — the manager-specific parts
# (brain token, MANAGER_URL) are gone: this node answers to nobody but its API clients.
set -euo pipefail

PROFILE_NAME=api-node

mkdir -p "$DSH_HOME"

# 0) Stale atomic-write lock cleanup: a leftover .credentials.yaml.lock from a crash makes
#    every boot time out on withFileLock (fact card dsh-facts §13). In the container's
#    single-process model a leftover lock can only come from a dead process: remove it.
rm -f "$DSH_HOME/.credentials.yaml.lock"

# 1) Seed/upgrade the profile: missing from the volume, or the seed version differs from
#    the image -> copy again (local, zero network). -L materializes the file:-dependency
#    symlink (node_modules/ohdsh-api-facade -> /opt/ohdsh-api-facade) so the seeded tree
#    is self-contained: ESM realpath resolution then finds the host peers (cordis,
#    dsh-session, …) in the profile's own node_modules, exactly like the manager image.
SEED_CUR=""
SEED_NEW="$(cat /opt/api-profile/.seedversion 2>/dev/null || echo unknown)"
[ -f "$DSH_HOME/profiles/$PROFILE_NAME/.seedversion" ] && SEED_CUR="$(cat "$DSH_HOME/profiles/$PROFILE_NAME/.seedversion")"
if [ ! -d "$DSH_HOME/profiles/$PROFILE_NAME" ] || [ "$SEED_CUR" != "$SEED_NEW" ]; then
  rm -rf "$DSH_HOME/profiles/$PROFILE_NAME"
  mkdir -p "$DSH_HOME/profiles"
  cp -aL /opt/api-profile "$DSH_HOME/profiles/$PROFILE_NAME"
  echo "[entrypoint] profile seeded into $DSH_HOME/profiles/$PROFILE_NAME (seed ${SEED_NEW:0:8})"
fi

# 2) Facade configuration from the environment: the env vars are the truth (derived files
#    are never edited by hand). The injection path is VERSION-GATED (upgrade card J1-04):
#    in the 0.1.7 corridor $DSH_HOME/settings.yaml became a one-shot import (renamed to
#    settings.yaml.imported at first boot) and ctx.settings.register was removed — plugin
#    configuration lives in the profile composition. So:
#      - legacy lines (0.1.2/0.1.5): the settings.yaml namespace mechanism (prod-verified;
#        rare-rewrite posture because the host appends its own keys, e.g. provisionedKey)
#      - 0.1.7+/0.2.x: regenerate the SEEDED profile's cordis.patch.yml at every boot =
#        the image baseline (/opt/api-profile copy: webserver + privacy rows) + the facade
#        config row built from GW_*. The seeded patch is a derived file (the pristine
#        baseline stays in the image layer), so unconditional regeneration IS the
#        red-line posture here — no grep dance, env changes apply on restart.
#        (Consequence on new lines: POST {prefix}/key bootstrap keys are memory-only —
#        the durable key path is GW_KEY. Documented in the README.)
#    NOTE: keys must not contain single quotes (gen-env.sh generates hex-only keys).
# NOTE the prerelease spelling: "0.1.5-rc.2" carries a DASH after the patch number —
# a `0.1.5.*` pattern silently misses it and routes the legacy line down the new path.
case "${DSH_VERSION:-}" in
0.1.2-* | 0.1.2.* | 0.1.5-* | 0.1.5.*)
  if [[ -n "${OPENAI_BASE_URL:-}${OPENAI_API_KEY:-}${OPENAI_MODEL:-}" ]]; then
    echo "[entrypoint] WARNING: OPENAI_* is not wired on the legacy DSH line (${DSH_VERSION:-unknown}) --"
    echo "[entrypoint]          the OpenAI-compatible route ships with the 0.2.x default line only."
  fi
  if [[ -n "${GW_KEY:-}" ]]; then
    NEED_WRITE=1
    if [ -f "$DSH_HOME/settings.yaml" ]; then
      NEED_WRITE=0
      grep -q '^ohdsh-api-facade:' "$DSH_HOME/settings.yaml" 2>/dev/null || NEED_WRITE=1
      if [ "$NEED_WRITE" = 0 ]; then grep -qF "$GW_KEY" "$DSH_HOME/settings.yaml" || NEED_WRITE=1; fi
      if [ "$NEED_WRITE" = 0 ] && [[ -n "${GW_ADMIN_KEY:-}" ]]; then
        grep -qF "$GW_ADMIN_KEY" "$DSH_HOME/settings.yaml" || NEED_WRITE=1
      fi
      if [ "$NEED_WRITE" = 0 ] && [[ "${GW_ALLOW_FULL_ACCESS:-}" == "true" ]]; then
        grep -q 'allowFullAccess: true' "$DSH_HOME/settings.yaml" || NEED_WRITE=1
      fi
      if [ "$NEED_WRITE" = 0 ] && [[ -n "${GW_EXPOSE_ERRORS:-}" ]]; then
        grep -q "exposeErrors: $GW_EXPOSE_ERRORS" "$DSH_HOME/settings.yaml" || NEED_WRITE=1
      fi
      if [ "$NEED_WRITE" = 0 ] && [[ -n "${GW_CORS_ORIGIN:-}" ]]; then
        grep -qF "corsOrigin: '$GW_CORS_ORIGIN'" "$DSH_HOME/settings.yaml" || NEED_WRITE=1
      fi
    fi
    if [ "$NEED_WRITE" = "1" ]; then
      {
        echo 'ohdsh-api-facade:'
        echo "  apiKeys: ['$GW_KEY']"
        if [[ -n "${GW_ADMIN_KEY:-}" ]]; then echo "  adminKey: '$GW_ADMIN_KEY'"; fi
        if [[ "${GW_ALLOW_FULL_ACCESS:-}" == "true" ]]; then echo '  allowFullAccess: true'; fi
        if [[ -n "${GW_EXPOSE_ERRORS:-}" ]]; then echo "  exposeErrors: $GW_EXPOSE_ERRORS"; fi
        if [[ -n "${GW_CORS_ORIGIN:-}" ]]; then echo "  corsOrigin: '$GW_CORS_ORIGIN'"; fi
      } > "$DSH_HOME/settings.yaml"
      chmod 600 "$DSH_HOME/settings.yaml"
      echo "[entrypoint] wrote $DSH_HOME/settings.yaml (GW_* refreshed)"
    fi
  else
    echo "[entrypoint] note: GW_KEY is not set -- no static API key is written; the one-time"
    echo "[entrypoint]       POST {prefix}/key bootstrap stays open until the first key is minted."
  fi
  ;;
*)
  PATCH_FILE="$DSH_HOME/profiles/$PROFILE_NAME/cordis.patch.yml"
  HAVE_GW=0
  if [[ -n "${GW_KEY:-}${GW_ADMIN_KEY:-}${GW_ALLOW_FULL_ACCESS:-}${GW_EXPOSE_ERRORS:-}${GW_CORS_ORIGIN:-}" ]]; then HAVE_GW=1; fi
  # OpenAI-compatible LLM route (opt-in): the built-in pi-ai adapter row (llm-pi-ai)
  # ships dormant in the base bundle. The env vocabulary is SHARED with the sibling
  # pi-api-facade project (OPENAI_* here; PI_OPENAI_* there, with OPENAI_* accepted as
  # aliases) so one operator/manager dictionary feeds both node kinds. Semantics mirror
  # the pi side:
  #   OPENAI_BASE_URL    activates the route (the only required var; absolute http(s),
  #                      up to — not including — /chat/completions, usually ends in /v1)
  #   OPENAI_API_KEY     optional — omit for key-less endpoints (Ollama). When set, the
  #                      patch stores apiKeyEnv (the NAME of the env var) and the DSH
  #                      credential layer resolves the process env per request, so the
  #                      key never lands on disk
  #   OPENAI_PROVIDER    route key (default `openai` = the pi-ai built-in openai catalog
  #                      route with its endpoint overridden — catalog model ids come
  #                      free; a custom id declares a brand-new route)
  #   OPENAI_MODELS      comma-separated model ids. Optional on the built-in `openai`
  #                      route; needed in practice for custom ids. NOTE the one honest
  #                      difference vs pi: a DSH explicit models list REPLACES the
  #                      route's catalog, where pi ADDS to it (config.d.ts semantics)
  #   OPENAI_MODEL       single-model shorthand, used when OPENAI_MODELS is absent
  #   FACADE_MODEL       default model for new sessions, `provider/model` (the same
  #                      contract as the pi side's PI_FACADE_MODEL; works standalone to
  #                      re-pin the default to any mounted route). Unset: the first
  #                      declared model on the route, else the bundle default stays
  #   OPENAI_API         wire protocol (default openai-completions; dsh-side superset —
  #                      pi-ai also serves openai-responses / anthropic-messages / …)
  #   OPENAI_CONTEXT_WINDOW / OPENAI_MAX_TOKENS
  #                      route-level capacity fallbacks for models that declare none
  HAVE_LLM=0
  LLM_PROVIDER="${OPENAI_PROVIDER:-openai}"
  LLM_MODELS_CSV="${OPENAI_MODELS:-${OPENAI_MODEL:-}}"
  if [[ -n "${OPENAI_BASE_URL:-}" ]]; then
    HAVE_LLM=1
    if [[ "$LLM_PROVIDER" != "openai" && -z "$LLM_MODELS_CSV" ]]; then
      echo "[entrypoint] WARNING: custom OPENAI_PROVIDER '$LLM_PROVIDER' without OPENAI_MODELS --"
      echo "[entrypoint]          a declared route serves no models until the list is set."
    fi
  elif [[ -n "${OPENAI_API_KEY:-}${LLM_MODELS_CSV}" ]]; then
    echo "[entrypoint] WARNING: OPENAI_API_KEY/OPENAI_MODELS set without OPENAI_BASE_URL --"
    echo "[entrypoint]          the OpenAI-compatible route stays off."
  fi
  # Default model for new sessions: FACADE_MODEL (provider/model) wins; else the first
  # declared model on the activated route; else the bundle default row is left alone.
  DEF_PROVIDER=""
  DEF_MODEL=""
  if [[ -n "${FACADE_MODEL:-}" ]]; then
    if [[ "$FACADE_MODEL" == */* ]]; then
      DEF_PROVIDER="${FACADE_MODEL%%/*}"
      DEF_MODEL="${FACADE_MODEL#*/}"
    else
      echo "[entrypoint] WARNING: FACADE_MODEL '$FACADE_MODEL' is not provider/model -- ignored."
    fi
  elif [[ "$HAVE_LLM" = 1 && -n "$LLM_MODELS_CSV" ]]; then
    DEF_PROVIDER="$LLM_PROVIDER"
    DEF_MODEL="${LLM_MODELS_CSV%%,*}"
    DEF_MODEL="$(printf '%s' "$DEF_MODEL" | tr -d '[:space:]')"
  fi
  if [ "$HAVE_GW" = 1 ] || [ "$HAVE_LLM" = 1 ] || [[ -n "$DEF_PROVIDER" ]]; then
    {
      cat /opt/api-profile/cordis.patch.yml
      if [ "$HAVE_GW" = 1 ]; then
        echo '- id: ohdsh-api-facade'
        echo '  config:'
        if [[ -n "${GW_KEY:-}" ]]; then echo "    apiKeys: ['$GW_KEY']"; fi
        if [[ -n "${GW_ADMIN_KEY:-}" ]]; then echo "    adminKey: '$GW_ADMIN_KEY'"; fi
        if [[ "${GW_ALLOW_FULL_ACCESS:-}" == "true" ]]; then echo '    allowFullAccess: true'; fi
        if [[ -n "${GW_EXPOSE_ERRORS:-}" ]]; then echo "    exposeErrors: $GW_EXPOSE_ERRORS"; fi
        if [[ -n "${GW_CORS_ORIGIN:-}" ]]; then echo "    corsOrigin: '$GW_CORS_ORIGIN'"; fi
      fi
      if [ "$HAVE_LLM" = 1 ]; then
        echo '- id: llm-pi-ai'
        echo '  config:'
        echo '    providers:'
        echo "      ${LLM_PROVIDER}:"
        echo "        api: '${OPENAI_API:-openai-completions}'"
        echo "        baseURL: '${OPENAI_BASE_URL}'"
        if [[ -n "${OPENAI_API_KEY:-}" ]]; then echo '        apiKeyEnv: OPENAI_API_KEY'; fi
        if [[ -n "${OPENAI_CONTEXT_WINDOW:-}" ]]; then echo "        defaultContextWindow: ${OPENAI_CONTEXT_WINDOW}"; fi
        if [[ -n "${OPENAI_MAX_TOKENS:-}" ]]; then echo "        defaultMaxTokens: ${OPENAI_MAX_TOKENS}"; fi
        if [[ -n "$LLM_MODELS_CSV" ]]; then
          echo '        models:'
          IFS=',' read -ra LLM_MODELS <<< "$LLM_MODELS_CSV" || true
          for m in "${LLM_MODELS[@]}"; do
            m="$(printf '%s' "$m" | tr -d '[:space:]')"
            if [[ -n "$m" ]]; then echo "          - id: '${m}'"; fi
          done
        fi
      fi
      if [[ -n "$DEF_PROVIDER" && -n "$DEF_MODEL" ]]; then
        # New sessions default to this pick. Every other mounted route stays available:
        # session.models lists them all and session.selectModel pins per session.
        echo '- id: agent-default-model'
        echo '  config:'
        echo "    provider: '${DEF_PROVIDER}'"
        echo "    model: '${DEF_MODEL}'"
      fi
    } > "$PATCH_FILE"
    chmod 600 "$PATCH_FILE"
    echo "[entrypoint] regenerated $PATCH_FILE (baseline + facade/llm config from env)"
  else
    echo "[entrypoint] note: no GW_* set -- the facade runs on schema defaults; the one-time"
    echo "[entrypoint]       POST {prefix}/key bootstrap is memory-only on this DSH line."
  fi
  ;;
esac

# 3) Model credentials, both routes resolve from the process environment (the top
#    credential layer, no files needed): DEEPSEEK_API_KEY for the official DeepSeek
#    adapter; OPENAI_API_KEY via the llm-pi-ai profile's apiKeyEnv when the
#    OpenAI-compatible route is configured. Without any key the node still boots and
#    serves the API surface; session turns fail until a key is provided.

# 4) Start: webserver binds 0.0.0.0 via the profile patch; --port and any other CLI
#    arguments pass through to the web app (compose sends: --port 3080).
exec dsh --profile "$PROFILE_NAME" --no-open "$@"
