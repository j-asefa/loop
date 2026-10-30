import assert from "node:assert/strict";
import { build } from "vite";
import react from "@vitejs/plugin-react";

// Exercise the production CSS pipeline as well as TS/JS. Library mode inlines
// font/image assets so the isolated HTTP fixture needs only these two outputs.
export async function browserFixtureBundle(entry) {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: "warn",
    plugins: [react()],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      __LOOP_BUILD__: "null",
    },
    build: {
      write: false,
      target: "esnext",
      minify: false,
      cssCodeSplit: false,
      lib: {
        entry,
        formats: ["es"],
        fileName: () => "client.mjs",
        cssFileName: "client",
      },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const output = (Array.isArray(result) ? result : [result]).flatMap(
    (item) => item.output,
  );
  const chunks = output.filter((item) => item.type === "chunk");
  assert.equal(chunks.length, 1);
  assert(
    output.every(
      (item) => item.type === "chunk" || item.fileName === "client.css",
    ),
    "Browser fixture must serve every generated asset",
  );
  return {
    script: chunks[0].code,
    style: output.find((item) => item.fileName === "client.css")?.source ?? "",
  };
}
