# KB Studio demo — zero-dependency node BFF + static UI.
# Build context is the repo root (compose.demos.yml sets it): the image bakes in the
# repo docs that the knowledge base syncs from, because the KB of this demo IS this
# project's own documentation.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app

# Authoritative docs the KB's content/docs/ area is synced from (Refresh-from-repo).
COPY README.md openapi.yaml .env.example docker-compose.yml /seed-docs/
COPY examples/cordis.yml /seed-docs/cordis.yml

# Shared facade client + chat bridge, demo seed (persona, welcome note), server, UI.
COPY examples/demos/lib /app/lib
COPY examples/demos/seed/kb /app/kb/seed
COPY examples/demos/kb/server.mjs /app/kb/server.mjs
COPY examples/demos/kb/public /app/kb/public
COPY examples/demos/web/style.css /app/kb/public/style.css
COPY examples/demos/web/vendor /app/kb/public/vendor

ENV NODE_ENV=production
EXPOSE 8101
CMD ["node", "kb/server.mjs"]
