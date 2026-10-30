import "./deployment/environment.mjs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
const stamp = process.env.LOOP55_BUILD_STAMP_FILE
  ? JSON.parse(readFileSync(process.env.LOOP55_BUILD_STAMP_FILE, "utf8"))
  : null;
export default defineConfig({
  plugins: [react()],
  define: {
    __LOOP55_BUILD__: JSON.stringify(stamp ? { ...stamp, ancestors: [] } : null),
  },
  build: { outDir: "dist/client" },
  // Test files spawn fixture servers and native children of their own, so the
  // worker count is not the whole footprint. Two workers fit an agent sharing
  // an 8 GiB host; `--maxWorkers` overrides this for larger machines.
  test: { maxWorkers: 2 },
  server: {
    host: "0.0.0.0",
    proxy: { "/api": { target: "http://localhost:3000", ws: true } },
  },
});
