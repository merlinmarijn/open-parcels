# syntax=docker/dockerfile:1.10
#
# One image for amd64 and arm64 (the Home Assistant Pi is aarch64).
# Debian slim rather than Alpine: native modules ship glibc builds.

ARG NODE_VERSION=26
# The node:26-slim index (amd64 + arm64) by digest, so a moved tag never changes the build. Bump:
# `docker buildx imagetools inspect node:26-slim`, copy the Digest line here.
ARG NODE_DIGEST=sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5
# Tailscale is built in (optional, off unless TS_STATE_DIR is set). Pinned; bump deliberately.
ARG TAILSCALE_VERSION=v1.104.7
# Its index digest; bump both together (the digest wins over the tag).
ARG TAILSCALE_DIGEST=sha256:72c1e19e0aedca96b8533bbb0b4368564410ff20b17e53b804eb6c1f04a31be4

# --- Tailscale binaries (copied into the runtime; no sidecar container needed) ----------------------
FROM tailscale/tailscale:${TAILSCALE_VERSION}@${TAILSCALE_DIGEST} AS tailscale

# --- Build: compile TypeScript with the full toolchain -------------------------------------------
FROM node:${NODE_VERSION}-slim@${NODE_DIGEST} AS build
# Compilers for better-sqlite3 when no prebuilt binary matches this Node ABI and architecture.
RUN apt-get update \
 && apt-get install --no-install-recommends -y python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/
COPY web/package.json web/
# The shared rules ship as a vendored, integrity-pinned tarball (no install scripts).
COPY server/vendor/ server/vendor/
RUN npm ci --workspace server --workspace web --include-workspace-root
COPY server/ server/
RUN npm run build --workspace server
# The web UI: a static build the server serves at / (the API client is generated and committed).
COPY web/ web/
RUN npm run build --workspace web

# --- Production dependencies only -----------------------------------------------------------------
FROM build AS deps
# The runtime copies only the root node_modules: fail here if npm ever nests a server dependency.
RUN rm -rf node_modules server/node_modules \
 && npm ci --workspace server --omit=dev \
 && test ! -e server/node_modules

# --- Runtime ------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim@${NODE_DIGEST} AS runtime
RUN apt-get update \
 && apt-get install --no-install-recommends -y tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /var/lib/tailscale \
 && chown node:node /data /var/lib/tailscale
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/server/package.json ./server/package.json
COPY --from=build --chown=root:root /app/server/dist ./server/dist
COPY --from=build --chown=root:root /app/web/dist ./web/dist
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/
COPY --chmod=755 docker/tailscale-entrypoint.sh /usr/local/bin/tailscale-entrypoint.sh

ENV NODE_ENV=production \
    OPENPARCELS_DATA_DIR=/data \
    OPENPARCELS_PORT=3000

# Runs as the image's unprivileged `node` user (uid 1000). The application files are owned by root
# and read-only for it; /data is the only place it writes, plus /var/lib/tailscale for the
# optional built-in Tailscale (a named volume mounted there inherits the ownership).
USER node
VOLUME ["/data"]
EXPOSE 3000

# Probes the address the server listens on; a wildcard (the default) is reached on loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const h=process.env.OPENPARCELS_HOST||'';const a=['','0.0.0.0','::'].includes(h)?'127.0.0.1':h.includes(':')?'['+h+']':h;fetch('http://'+a+':'+(process.env.OPENPARCELS_PORT||3000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# The entrypoint starts Tailscale first when TS_STATE_DIR is set, then execs the app; without it,
# it only execs the app.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tailscale-entrypoint.sh"]
CMD ["node", "server/dist/main.js"]

LABEL org.opencontainers.image.title="open-parcels" \
      org.opencontainers.image.description="Self-hosted parcel and order tracking for every carrier, shop and mailbox." \
      org.opencontainers.image.source="https://github.com/open-parcels/open-parcels"
