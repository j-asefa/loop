import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
const stamp = process.env.LOOP_BUILD_STAMP_FILE
  ? JSON.parse(readFileSync(process.env.LOOP_BUILD_STAMP_FILE, "utf8"))
  : null;
export default defineConfig({
  plugins: [react()],
  define: {
    __LOOP_BUILD__: JSON.stringify(stamp ? { ...stamp, ancestors: [] } : null),
  },
  build: { outDir: "dist/client" },
  server: {
    host: "0.0.0.0",
    proxy: { "/api": { target: "http://localhost:3000", ws: true } },
  },
});
