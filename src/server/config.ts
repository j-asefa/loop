import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { assertPreviewDataDir } from "../preview-context.js";
export const config = {
  url: process.env.LOOP_URL || "http://localhost:3000",
  port: Number(process.env.PORT || 3000),
  changePollMs: Number(process.env.LOOP_CHANGE_POLL_MS || 250),
  data: resolve(process.env.LOOP_DATA_DIR || "./data"),
  database: join(resolve(process.env.LOOP_DATA_DIR || "./data"), "loop.db"),
  production: process.env.NODE_ENV === "production",
};
assertPreviewDataDir(config.data);
mkdirSync(config.data, { recursive: true, mode: 0o700 });
