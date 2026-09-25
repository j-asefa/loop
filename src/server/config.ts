import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
export const config = {
  url: process.env.LOOP_URL || "http://localhost:3000",
  port: Number(process.env.PORT || 3000),
  listenHost: process.env.LOOP_LISTEN_HOST || "127.0.0.1",
  authMode: process.env.LOOP_AUTH_MODE || "single-user",
  singleUserEmail: process.env.LOOP_SINGLE_USER_EMAIL || "",
  gatewayToken: process.env.LOOP_GATEWAY_TOKEN || "",
  loopbackProxy: process.env.LOOP_LOOPBACK_PROXY === "1",
  bindAddress: process.env.LOOP_BIND_ADDRESS || "127.0.0.1",
  data: resolve(process.env.LOOP_DATA_DIR || "./data"),
  production: process.env.NODE_ENV === "production",
};
mkdirSync(config.data, { recursive: true, mode: 0o700 });
