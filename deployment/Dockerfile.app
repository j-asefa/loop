ARG NODE_IMAGE=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY public ./public
COPY runtime ./runtime
COPY scripts ./scripts
COPY migrations ./migrations
COPY deployment ./deployment
COPY index.html tsconfig.json vite.config.ts ./
RUN npm run build && npm prune --omit=dev
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production PORT=3000 LOOP_LISTEN_HOST=0.0.0.0 LOOP_DATA_DIR=/data
COPY --from=build --chown=1000:1000 /app /app
RUN mkdir -p /run/loop/private /data && chown -R 1000:1000 /run/loop /data
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server/serve.ts"]
