# Support widget demo — zero-dependency node BFF + static UI.
# Build context is the repo root (compose.demos.yml sets it). The BFF holds the facade
# API key; the browser never sees it. The support persona is seeded into the mounted
# workspace as AGENTS.md (the harness injects it as workspace instructions).
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app

COPY examples/demos/lib /app/lib
COPY examples/demos/seed/cs /app/cs/seed
COPY examples/demos/cs/server.mjs /app/cs/server.mjs
COPY examples/demos/cs/public /app/cs/public
COPY examples/demos/web/style.css /app/cs/public/style.css
COPY examples/demos/web/icons.js /app/cs/public/icons.js
COPY examples/demos/web/vendor /app/cs/public/vendor

ENV NODE_ENV=production
EXPOSE 8102
CMD ["node", "cs/server.mjs"]
