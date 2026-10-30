import { retainedPath } from "../name-upgrade.js";
import "../../runtime/environment.mjs";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { assertPreviewDataDir } from "../preview-context.js";
export const config = {
  url: process.env.LOOP55_URL || "http://localhost:3000",
  port: Number(process.env.PORT || 3000),
  changePollMs: Number(process.env.LOOP55_CHANGE_POLL_MS || 250),
  listenHost: process.env.LOOP55_LISTEN_HOST || "127.0.0.1",
  authMode: process.env.LOOP55_AUTH_MODE || "single-user",
  singleUserEmail: process.env.LOOP55_SINGLE_USER_EMAIL || "",
  gatewayToken: process.env.LOOP55_GATEWAY_TOKEN || "",
  loopbackProxy: process.env.LOOP55_LOOPBACK_PROXY === "1",
  bindAddress: process.env.LOOP55_BIND_ADDRESS || "127.0.0.1",
  data: resolve(process.env.LOOP55_DATA_DIR || "./data"),
  database: retainedPath(
    resolve(process.env.LOOP55_DATA_DIR || "./data"),
    "loop55.db",
    "loop.db",
  ),
  production: process.env.NODE_ENV === "production",
};
assertPreviewDataDir(config.data);
mkdirSync(config.data, { recursive: true, mode: 0o700 });
