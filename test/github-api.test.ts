import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createSecureServer, type ServerHttp2Stream } from "node:http2";
import { gzipSync } from "node:zlib";

const dir = mkdtempSync(join(tmpdir(), "loop55-github-api-"));
process.env.LOOP55_DATA_DIR = dir;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
// In the server the undici package loads (the MCP network layer imports it)
// before any request is sent, and becomes the global dispatcher.
const { Agent, setGlobalDispatcher } = await import("undici");
setGlobalDispatcher(new Agent());
const { db } = await import("../src/server/db");
const { githubRest, withGithubFixture } =
  await import("../src/server/github-api");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("decodes GitHub's gzipped HTTP/2 responses with the production fetch", async () => {
  // GitHub answers over HTTP/2 and compresses larger responses, such as a
  // pull request's files. Node's built-in fetch on undici's dispatcher loses
  // the encoding there; this local server does the same over TLS.
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const github = createSecureServer({
    key: readFileSync(join(dir, "key.pem")),
    cert: readFileSync(join(dir, "cert.pem")),
  });
  github.on("stream", (stream: ServerHttp2Stream) => {
    stream.respond({
      ":status": 200,
      "content-type": "application/json",
      "content-encoding": "gzip",
    });
    stream.end(gzipSync(JSON.stringify([{ filename: "src/limit.ts" }])));
  });
  await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
  const restore = withGithubFixture(
    undefined,
    `https://127.0.0.1:${(github.address() as any).port}`,
  );
  const verify = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const { data } = await githubRest<any[]>(
      "token",
      "/repos/acme/api/pulls/42/files",
    );
    expect(data).toEqual([{ filename: "src/limit.ts" }]);
  } finally {
    if (verify === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = verify;
    restore();
    await new Promise<void>((resolve) => github.close(() => resolve()));
  }
});
