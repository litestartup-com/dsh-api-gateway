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
  if [[ -n "${GW_KEY:-}${GW_ADMIN_KEY:-}${GW_ALLOW_FULL_ACCESS:-}${GW_EXPOSE_ERRORS:-}${GW_CORS_ORIGIN:-}" ]]; then
    {
      cat /opt/api-profile/cordis.patch.yml
      echo '- id: ohdsh-api-facade'
      echo '  config:'
      if [[ -n "${GW_KEY:-}" ]]; then echo "    apiKeys: ['$GW_KEY']"; fi
      if [[ -n "${GW_ADMIN_KEY:-}" ]]; then echo "    adminKey: '$GW_ADMIN_KEY'"; fi
      if [[ "${GW_ALLOW_FULL_ACCESS:-}" == "true" ]]; then echo '    allowFullAccess: true'; fi
      if [[ -n "${GW_EXPOSE_ERRORS:-}" ]]; then echo "    exposeErrors: $GW_EXPOSE_ERRORS"; fi
      if [[ -n "${GW_CORS_ORIGIN:-}" ]]; then echo "    corsOrigin: '$GW_CORS_ORIGIN'"; fi
    } > "$PATCH_FILE"
    chmod 600 "$PATCH_FILE"
    echo "[entrypoint] regenerated $PATCH_FILE (baseline + facade config from GW_*)"
  else
    echo "[entrypoint] note: no GW_* set -- the facade runs on schema defaults; the one-time"
    echo "[entrypoint]       POST {prefix}/key bootstrap is memory-only on this DSH line."
  fi
  ;;
esac

# 3) Model credentials: the DEEPSEEK_API_KEY environment variable ranks highest in the
#    DSH credential layering, so no file is needed. Without it the node still boots and
#    serves the API surface; session turns fail until a key is provided.

# 4) Start: webserver binds 0.0.0.0 via the profile patch; --port and any other CLI
#    arguments pass through to the web app (compose sends: --port 3080).
exec dsh --profile "$PROFILE_NAME" --no-open "$@"
