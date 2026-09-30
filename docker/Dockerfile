# ohdsh/api-facade-node — one container = one standalone DSH API node
# (DSH host + the ohdsh-api-facade plugin from this checkout + an isolated DSH_HOME).
#
# The recipe mirrors dsh-agent-manager/images/node (field-hardened; see the private
# design library fact card "container-deploy red lines"): dependencies frozen at build
# time (DSH pinned version + committed profile lock), zero install at runtime, and a
# uid-agnostic writable volume.
#
# Build from the repo root (compose does this for you):
#   docker build -f docker/Dockerfile -t ohdsh/api-facade-node .
# Building in China:
#   --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

# git: plugin/workspace tooling agents expect; curl: container healthcheck + agent use;
# jq/tzdata: TZ=Asia/Shanghai and shell quality of life; python3/make/g++: node-gyp
# fallback for when the prebuilt download of a DSH native dependency fails (the same
# lesson as the manager image: build-time tooling, unavoidable in the runtime layer).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl jq tzdata python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

ARG NPM_REGISTRY=https://registry.npmjs.org
# Pinned to a VERIFIED pairing from the README "Supported DSH versions" table.
# 0.1.5-rc.2 needs node >=22.19 (this base) and --legacy-peer-deps with explicit
# legacy peer pins — both handled by gen-profile.mjs.
ARG DSH_VERSION=0.2.0-rc.2
# pnpm pinned to a definite version (same rationale as the manager image: 9 runs
# dependency build scripts under the old, verified semantics).
RUN npm install -g @deepseek-ai/dsh@${DSH_VERSION} pnpm@9.15.9 --registry="${NPM_REGISTRY}" --no-audit --no-fund \
    && npm cache clean --force

# Dependency surface first: the facade's package.json (+ the docs npm likes to see) is
# all `npm ci` needs to materialize the tree — the file: dependency is a SYMLINK at
# install time, so code edits (lib/, src/, docs) never invalidate the expensive layer.
COPY package.json README.md README.zh.md LICENSE /opt/ohdsh-api-facade/

# Generate the profile at build time (manifest + webserver patch) and install its
# dependencies from the committed lock (npm ci; reproducible tree).
COPY docker/profile-lock ./profile-lock
COPY docker/gen-profile.mjs /usr/local/bin/gen-profile.mjs
RUN DSH_VERSION="${DSH_VERSION}" NPM_REGISTRY="${NPM_REGISTRY}" LOCK_DIR=/profile-lock \
    node /usr/local/bin/gen-profile.mjs

# Now the rest of the checkout — lib/ is what actually runs (prebuilt and committed).
COPY . /opt/ohdsh-api-facade

# Re-stamp the seed marker against the FULL tree: any content change under the checkout
# re-seeds the profile volume on next start (entrypoint compares seed versions).
RUN DSH_VERSION="${DSH_VERSION}" node /usr/local/bin/gen-profile.mjs --seed-only

COPY docker/entrypoint.sh /usr/local/bin/ohdsh-api-entrypoint
RUN chmod +x /usr/local/bin/ohdsh-api-entrypoint \
    && mkdir -p /data /workspace && chown -R 1000:1000 /data /workspace \
    # Red line B: compose passes the host deploy uid (user: ${HOST_UID}); any "fixed owner"
    # baked into the image only works for uid 1000 by coincidence. Volume root 777: any uid
    # can work in the subtree it creates itself, while files keep their creator's tight modes
    # (single-tenant node container, no multi-user surface).
    && chmod 777 /data

# DSH_HOME is a mounted volume: the first start seeds the profile from /opt/api-profile
# (a local copy, zero network). HOME points at /data too, so $DSH_HOME/settings.yaml
# (GW_KEY), credentials, and dsh's ~/.config / ~/.npm writes all land in the same
# writable volume regardless of the runtime uid.
# DSH_VERSION is re-exported at runtime: the entrypoint gates the key-injection path on it
# (legacy 0.1.2/0.1.5 lines -> settings.yaml; 0.1.7+/0.2.x -> profile patch config, card J1-04).
# The node binds 0.0.0.0 (profile patch): the compose network is internal, the port is
# NOT published to the host, and nginx is the only front door.
ENV DSH_HOME=/data \
    HOME=/data \
    NODE_ENV=production \
    TZ=Asia/Shanghai \
    DSH_VERSION=${DSH_VERSION}
WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["ohdsh-api-entrypoint"]
