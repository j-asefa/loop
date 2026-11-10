import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readBuildStamp } from "./scripts/build-stamp.ts";
const stamp = readBuildStamp();
export default defineConfig({
  plugins: [react()],
  define: {
    __LOOP_BUILD__: JSON.stringify(stamp ? { ...stamp, ancestors: [] } : null),
  },
  build: { outDir: "dist/web" },
  // Test files spawn fixture servers and native children of their own, so the
  // worker count is not the whole footprint. Two workers fit an agent sharing
  // an 8 GiB host; `--maxWorkers` overrides this for larger machines.
  test: { maxWorkers: 2 },
});
