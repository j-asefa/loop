import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createSecureServer, type ServerHttp2Stream } from "node:http2";
import { gzipSync } from "node:zlib";

const dir = mkdtempSync(join(tmpdir(), "loop-github-api-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
// In the server the undici package loads (the MCP network layer imports it)
// before any request is sent, and becomes the global dispatcher.
const { Agent, setGlobalDispatcher } = await import("undici");
setGlobalDispatcher(new Agent());
const { db } = await import("../src/server/db");
const { githubRest, createGithubClient, withGithubClient } =
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
  const githubClient = createGithubClient({
    fetch: undefined,
    base: `https://127.0.0.1:${(github.address() as any).port}`,
  });
  const verify = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const { data } = await githubClient.rest<any[]>(
      "token",
      "/repos/acme/api/pulls/42/files",
    );
    expect(data).toEqual([{ filename: "src/limit.ts" }]);
  } finally {
    if (verify === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = verify;
    await new Promise<void>((resolve) => github.close(() => resolve()));
  }
});

it("isolates overlapping client scopes and restores the outer client after failure", async () => {
  const client = (base: string) =>
    createGithubClient({
      base,
      fetch: async (url, init) => {
        await Promise.resolve();
        return Response.json({
          url,
          authorization: new Headers(init.headers).get("authorization"),
        });
      },
    });
  const first = client("https://first.test");
  const second = client("https://second.test");
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const [a, b] = await Promise.all([
    withGithubClient(first, async () => {
      await ready;
      return (await githubRest("first-token", "/user")).data;
    }),
    withGithubClient(second, async () => {
      release();
      await Promise.resolve();
      return (await githubRest("second-token", "/user")).data;
    }),
  ]);
  expect(a).toEqual({
    url: "https://first.test/user",
    authorization: "Bearer first-token",
  });
  expect(b).toEqual({
    url: "https://second.test/user",
    authorization: "Bearer second-token",
  });
  await withGithubClient(first, async () => {
    await expect(
      withGithubClient(second, async () => {
        expect(
          (await githubRest<{ url: string }>("nested", "/user")).data.url,
        ).toBe("https://second.test/user");
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");
    expect((await githubRest<{ url: string }>("outer", "/user")).data.url).toBe(
      "https://first.test/user",
    );
  });
});

it("keeps the injected client while a POST body arrives in delayed chunks", async () => {
  const { default: express } = await import("express");
  const { request } = await import("node:http");
  const client = (base: string) =>
    createGithubClient({
      base,
      fetch: async (url) => Response.json({ url }),
    });
  const injected = client("https://injected.test");
  const fallback = client("https://fallback.test");
  const app = express();
  app.use((_req, _res, next) => withGithubClient(injected, next));
  app.use(express.json());
  app.post("/", async (_req, res, next) => {
    try {
      res.json((await githubRest("fixture", "/user")).data);
    } catch (error) {
      next(error);
    }
  });
  const server = withGithubClient(fallback, () => app.listen(0, "127.0.0.1"));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: (server.address() as { port: number }).port,
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve(body));
        },
      );
      req.on("error", reject);
      req.write('{"delayed":');
      setTimeout(() => req.end("true}"), 25);
    });
    expect(JSON.parse(result)).toEqual({ url: "https://injected.test/user" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
