# Server operation

The server profile runs one shared web application, API and durable worker. Use a persistent Node host or Docker; static hosting alone cannot run it. For QR-based laptop or Docker companion access use [pairing](pairing.md#docker-companion). The dedicated companion Compose file is separate from the server deployment below.

## Start from a checkout

After `npm ci && npm run build`:

```sh
npm run setup
node --env-file=.env dist/cli.js server
```

This starts the compiled API and worker together in the foreground. The source equivalent is `node --env-file=.env scripts/serve.mjs`, which supervises separate API/worker processes. `npm start` runs only the API and does not load `.env`; `npm run dev` and `npm run worker` load it for their respective source processes.

Open http://localhost:3000. `GET /api/health` reports readiness. [src/server/config.ts](../src/server/config.ts) and [.env.example](../.env.example) define configuration. Setup creates/preserves secrets; do not commit `.env`.

## Docker and harness connections

Use Settings → Provider connections to connect server subscription accounts through the configured runtime broker, or register a native host. See [remote runtimes](remote-runtimes.md). The root Compose stack supplies the server and subscription runtime; the paired Docker companion is a separate deployment.

Direct subscription connections retired by migration 067 become eligible for native verification in migration 071. Check the account before running work again. Stored history and uncertain dispatch receipts remain intact and are never automatically replayed.

## Access configuration

| Setting                      | Use                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `LOOP_AUTH_MODE=single-user` | Default personal workspace; direct access restricted to local requests or a trusted gateway |
| `LOOP_AUTH_MODE=multi-user`  | Loop sign-in and separate owner-scoped workspaces                                           |
| `LOOP_SINGLE_USER_EMAIL`     | Explicit owner selection when several existing accounts are present                         |
| `LOOP_URL`                   | Actual browser origin, used for access/origin checks                                        |
| `LOOP_LISTEN_HOST`           | Direct Node listener; defaults to `127.0.0.1`                                               |
| `LOOP_BIND_ADDRESS`          | Compose published interface; defaults to `127.0.0.1`                                        |
| `LOOP_DATA_DIR`              | Persistent server data; defaults to `./data`                                                |

Changing authentication mode does not merge users' data. A database records its deployment profile; never point server and companion deployments at the same data directory.

For remote single-user access, put an authenticated HTTPS gateway before the private app port. Set `LOOP_URL` and a private `LOOP_GATEWAY_TOKEN` of at least 32 characters. The gateway must authenticate visitors and overwrite `X-Loop-Gateway-Token`; never expose this token to browser code. Forwarding headers alone do not grant access.

For Loop-managed sign-in with bundled Caddy, configure `.env`:

```dotenv
LOOP_AUTH_MODE=multi-user
LOOP_HOST=loop.example.com
LOOP_URL=https://loop.example.com
LOOP_BEHIND_PROXY=1
```

Point the hostname at the host, then run `docker compose --profile https up --build -d`. Caddy exposes 80/443; keep Loop's direct port private. `LOOP_BEHIND_PROXY` assumes a trusted proxy replaces client-IP headers; it does not authenticate visitors. Compose's loopback-proxy allowance must remain paired with local-only publication for single-user access.
