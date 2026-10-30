FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
ARG LOOP55_BUILD_SOURCE_FILE
RUN LOOP55_BUILD_SOURCE_FILE="$LOOP55_BUILD_SOURCE_FILE" npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 LOOP55_DATA_DIR=/data LOOP55_LISTEN_HOST=0.0.0.0
COPY --from=build --chown=node:node /app /app
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","dist/cli.js","server"]
