# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# Two stages so the runtime image carries no TypeScript toolchain and no dev
# dependencies. The target is a small edge device that also runs ChirpStack and
# Postgres, so image size and resident memory both matter.

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# No package-lock.json is committed (org convention), so `npm install` resolves at
# build time. Copy only the manifest first: the dependency layer is then cached and
# reused whenever only source files change.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree that gets copied forward.
RUN npm prune --omit=dev

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# tini reaps zombies and forwards SIGTERM, which `serve` needs for a clean
# shutdown that waits on an in-flight sounding.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    LEADSMAN_CONFIG=/etc/leadsman/leadsman.json \
    LEADSMAN_LOG_FORMAT=json

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations

# Config is mounted, not baked, so operators change checks without a rebuild.
RUN mkdir -p /etc/leadsman && chown -R node:node /etc/leadsman

# The bundled node user — never root. The engine only needs to reach Postgres.
USER node

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/cli.js"]
CMD ["serve"]

# `leadsman run --dry-run` exercises config parsing, rule loading, the database
# connection, and every check's SQL without writing anything — a real readiness
# signal rather than a process-is-alive check. It costs one sounding per interval,
# so keep the interval well above the sounding duration on slow hardware.
HEALTHCHECK --interval=5m --timeout=60s --start-period=30s --retries=3 \
  CMD node dist/cli.js run --dry-run > /dev/null 2>&1 || exit 1
