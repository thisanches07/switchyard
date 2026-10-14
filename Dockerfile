# syntax=docker/dockerfile:1
# Debian (glibc) rather than Alpine: the Kafka client used from spec 006 ships glibc prebuilds
# (linux x64 and arm64), so neither platform compiles native code.
# Two images from one file (spec 013): `--target gateway` (the default) and `--target worker`.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# dist/ is platform independent: compile once on the build machine, even for arm64 under QEMU.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    SWITCHYARD_CONFIG=/app/config/switchyard.example.yaml
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle
COPY config ./config
USER node

# Usage worker (spec 006). No HTTP server, so no HEALTHCHECK: its readiness signal is the
# `usage worker started` log line once both usage topics exist.
FROM runtime AS worker
CMD ["node", "--import", "./dist/infra/telemetry/register-worker.js", "dist/worker.js"]

# Gateway: last stage, so a plain `docker build .` still produces it.
FROM runtime AS gateway
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--import", "./dist/infra/telemetry/register.js", "dist/server.js"]
