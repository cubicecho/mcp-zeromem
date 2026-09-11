# syntax=docker/dockerfile:1

# ── Stage 1: native ───────────────────────────────────────────────────────────
# Builds the Rust engine twice over: as the napi-rs addon the Node server loads
# in-process, and as the `zm` CLI used by host-side hooks and the test harness.
#
# The suite (trixie) is pinned to match node:26-slim below. The addon is a
# shared object linked against this image's glibc; a newer suite here than in
# the runtime stage fails at load time with a GLIBC version error.
FROM rust:1-trixie AS native

# The napi CLI is a Node program: borrow node + npm from the runtime image
# rather than installing a second, possibly different, Node.
COPY --from=node:26-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:26-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the binding workspace's dev dependency (@napi-rs/cli) is needed here, but
# npm ci wants every workspace manifest to resolve the lockfile.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY app/package.json ./app/
COPY crates/zeromem-node/package.json ./crates/zeromem-node/
RUN npm ci -w crates/zeromem-node --include-workspace-root=false

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN npm run build -w crates/zeromem-node \
  && cargo build --release -p zeromem-core --bin zm

# ort-sys links ONNX Runtime statically by default. If a build ever switches to
# the dynamic library the addon would load fine here and fail in the runtime
# stage, so fail the build at the point where it is cheap to notice.
RUN ldd crates/zeromem-node/*.node | grep -q onnxruntime \
  && { echo 'the addon links libonnxruntime dynamically; add it to the runtime stage' >&2; exit 1; } \
  || true

# ── Stage 2: build ────────────────────────────────────────────────────────────
# Builds shared/server/app. Needs the addon's generated index.js/index.d.ts so
# the server's imports of @mcp-zeromem/native typecheck.
FROM node:26-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY app/package.json ./app/
COPY crates/zeromem-node/package.json ./crates/zeromem-node/
RUN npm ci

# Copy the rest of the source (.dockerignore excludes node_modules, data, dist, target, .git)
COPY . .
COPY --from=native /app/crates/zeromem-node/index.js /app/crates/zeromem-node/index.d.ts ./crates/zeromem-node/
COPY --from=native /app/crates/zeromem-node/*.node ./crates/zeromem-node/

# shared typecheck → server tsc (server/dist) → app vite build (app/dist)
RUN npm run build:ts

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
FROM node:26-slim

# ca-certificates + libssl3: the embedding model (bge-small-en-v1.5, ~130 MB)
# is fetched over HTTPS on first use, and the engine links OpenSSL dynamically
# for that.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace manifests + production dependencies. `npm ci --omit=dev` also
# creates the node_modules/@mcp-zeromem/{shared,native} workspace symlinks the
# server needs at runtime.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY app/package.json ./app/
COPY crates/zeromem-node/package.json ./crates/zeromem-node/
RUN npm ci --omit=dev && npm cache clean --force

# @mcp-zeromem/shared is a source-only TS package: its exports point at
# ./src/index.ts and Node 26 type-strips it natively, so the source ships as is.
COPY shared ./shared

# The addon: loader, types, and the platform-named .node artifact.
COPY --from=native /app/crates/zeromem-node/index.js /app/crates/zeromem-node/index.d.ts /app/crates/zeromem-node/types.d.ts ./crates/zeromem-node/
COPY --from=native /app/crates/zeromem-node/*.node ./crates/zeromem-node/
# The CLI, for `docker exec -i mcp-zeromem zm …` hooks and for the harness.
COPY --from=native /app/target/release/zm /usr/local/bin/zm

COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/app/dist ./app/dist
# The harness numbers per commit, for the Eval page.
COPY docs/eval/history.jsonl ./docs/eval/history.jsonl
COPY docs/curator-playbook.md ./docs/curator-playbook.md

ENV NODE_ENV=production
# The store lives under /data. ZEROMEM_HOME is the same directory so `zm`
# inside the container and the server agree on it; HOME too, so nothing in the
# image ever resolves a store under /root by accident.
ENV DATA_DIR=/data
ENV ZEROMEM_HOME=/data
ENV HOME=/data
# The embedding model is downloaded next to the store, so it survives a
# restart and is shared with a host-side `zm` pointed at the same directory.
ENV ZEROMEM_MODELS=/data/models

RUN mkdir -p /data && chown node:node /data
USER node

VOLUME /data

EXPOSE 3000

LABEL io.modelcontextprotocol.server.name="io.github.cubicecho/mcp-zeromem"

# /api/status is unauthenticated liveness; anything but 2xx means the engine
# failed to open its store. The start period covers the first-boot model
# download; the server warms the engine before it listens.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e 'fetch("http://localhost:" + (process.env.PORT || 3000) + "/api/status").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

CMD ["node", "server/dist/index.js"]
