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

# 2) Facade settings from the environment: the env var is the truth (derived files are
#    never edited by hand). The file is rewritten whenever it is missing, sits outside
#    this plugin's namespace, or does not reflect the current GW_* values — a volume can
#    hold the previous release's old key or old namespace (the 0.1.1->0.1.2 lesson baked
#    into the manager entrypoint: grep for the key alone is not enough).
#    Rewrite = whole file, so it is kept RARE on purpose: the host appends its own keys
#    here at runtime (e.g. the facade's provisionedKey) and a needless rewrite would wipe
#    them. Every set knob is checked; when all are present the file is left untouched.
#    NOTE: keys must not contain single quotes (gen-env.sh generates hex-only keys).
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

# 3) Model credentials: the DEEPSEEK_API_KEY environment variable ranks highest in the
#    DSH credential layering, so no file is needed. Without it the node still boots and
#    serves the API surface; session turns fail until a key is provided.

# 4) Start: webserver binds 0.0.0.0 via the profile patch; --port and any other CLI
#    arguments pass through to the web app (compose sends: --port 3080).
exec dsh --profile "$PROFILE_NAME" --no-open "$@"
