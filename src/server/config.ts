import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
export const config = {
  url: process.env.LOOP_URL || "http://localhost:3000",
  port: Number(process.env.PORT || 3000),
  data: resolve(process.env.LOOP_DATA_DIR || "./data"),
  production: process.env.NODE_ENV === "production",
};
mkdirSync(config.data, { recursive: true, mode: 0o700 });
