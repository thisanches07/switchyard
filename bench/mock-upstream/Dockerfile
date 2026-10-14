# syntax=docker/dockerfile:1
# Benchmark mock upstream (spec 012). Build context: the repository root.
# The first stages repeat the gateway Dockerfile so BuildKit reuses its dependency layer.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY bench/mock-upstream ./bench/mock-upstream
RUN pnpm exec tsc -p bench/mock-upstream/tsconfig.json

# The compiled server and the mock provider use only Node built-ins: no node_modules needed.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=9100
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist/mock-upstream ./
USER node
EXPOSE 9100
CMD ["node", "bench/mock-upstream/main.js"]
