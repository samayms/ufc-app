# syntax=docker/dockerfile:1

ARG NODE_VERSION=24
ARG LITESTREAM_VERSION=0.3.13

# --- builder: full deps, type-check, build the frontend bundle ------------
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app

# better-sqlite3 needs a C++ toolchain + python to build its native binding.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- runtime deps: prod-only install, native binding built for this image -
FROM node:${NODE_VERSION}-bookworm-slim AS runtime-deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- litestream: pinned static binary --------------------------------------
FROM debian:bookworm-slim AS litestream
ARG LITESTREAM_VERSION
WORKDIR /tmp
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL -o litestream.tar.gz \
       "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
    && tar -xzf litestream.tar.gz \
    && rm -rf /var/lib/apt/lists/*

# --- final: runtime image ---------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS final
WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/data/ufc.db

COPY --from=litestream /tmp/litestream /usr/local/bin/litestream
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY src ./src
COPY drizzle.config.ts ./
COPY litestream.yml ./
COPY --from=builder /app/dist ./dist

RUN mkdir -p /data

EXPOSE 8600

ENTRYPOINT ["litestream", "replicate", "-config", "/app/litestream.yml", "-exec", "node --env-file-if-exists=.env server/main.ts"]
