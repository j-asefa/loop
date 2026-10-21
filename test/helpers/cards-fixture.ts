import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";

export async function cardsFixture(
  mode: "server" | "companion" | "multi-user",
  compiled = false,
) {
  const dir = mkdtempSync(join(tmpdir(), "loop-card-access-"));
  let port = 0;
  if (mode === "multi-user") {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
  }
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../fixtures/cards-server.ts", import.meta.url)),
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("LOOP_"),
          ),
        ),
        LOOP_PROFILE: mode === "companion" ? "companion" : "server",
        LOOP_AUTH_MODE: mode === "multi-user" ? "multi-user" : "single-user",
        LOOP_DATA_DIR: dir,
        LOOP_URL: "http://127.0.0.1" + (port ? ":" + port : ""),
        PORT: String(port),
        LOOP_TEST_CARDS_COMPILED: compiled ? "1" : "0",
        NODE_ENV: "test",
        LOOP_LISTEN_HOST: "127.0.0.1",
        LOOP_BIND_ADDRESS: "127.0.0.1",
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        LOOP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let errors = "";
  child.stderr?.on("data", (chunk) => {
    errors += chunk;
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  let ready: { origin: string; owner: string; pair?: string };
  try {
    ready = await Promise.race([
      once(child, "message").then(([message]) => message),
      once(child, "exit").then(() => {
        throw new Error("Card fixture did not start: " + errors);
      }),
    ]);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const database = new Database(join(dir, "loop.db"));
  database.pragma("foreign_keys = ON");
  const { origin } = ready;
  let owner = ready.owner;
  const request = (
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {},
  ) =>
    new Promise<Response>((resolve, reject) => {
      const payload = options.body ? JSON.stringify(options.body) : undefined;
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: new URL(origin).port,
          path,
          method: options.method || (options.body ? "POST" : "GET"),
          headers: {
            "content-type": "application/json",
            ...(payload
              ? { "content-length": String(Buffer.byteLength(payload)) }
              : {}),
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const headers = new Headers();
            for (const [key, values] of Object.entries(res.headers))
              for (const value of Array.isArray(values)
                ? values
                : values
                  ? [values]
                  : [])
                headers.append(key, value);
            resolve(
              new Response(Buffer.concat(chunks).toString(), {
                status: res.statusCode,
                headers,
              }),
            );
          });
          res.on("error", reject);
        },
      );
      req.on("error", (error) =>
        reject(
          new Error(
            `${options.method || "GET"} ${path}: ${error.message}; fixture stderr: ${errors}`,
          ),
        ),
      );
      req.end(payload);
    });
  let cookie = "",
    csrf = "";
  if (ready.pair) {
    const response = await request("/pair", {
      body: {
        secret: new URLSearchParams(new URL(ready.pair).hash.slice(1)).get(
          "pair",
        ),
        name: "Card fixture",
      },
      headers: { origin },
    });
    if (response.status !== 200)
      throw new Error("Could not pair isolated card fixture");
    cookie = response.headers.get("set-cookie")!.split(";", 1)[0];
    csrf = (await (await request("/session", { headers: { cookie } })).json())
      .csrf;
  }
  if (mode === "multi-user") {
    const response = await request("/api/auth/sign-up/email", {
      headers: { origin },
      body: {
        name: "Card owner",
        email: "cards@example.com",
        password: "fixture-cards-owner-password",
      },
    });
    if (response.status !== 200)
      throw new Error(
        "Could not create isolated card account: " + (await response.text()),
      );
    owner = (await response.json()).user.id;
    cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
  }
  const browser = { origin, cookie, "x-loop-csrf": csrf };
  return {
    mode,
    dir,
    origin,
    owner,
    db: database,
    request,
    browser,
    async close() {
      database.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
