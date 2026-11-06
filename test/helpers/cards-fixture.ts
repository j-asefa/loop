import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { installFixtureProjection } from "./projected-writer.js";
import { fleetDeviceFromLink } from "../../src/shared/fleet-pairing.js";

export async function cardsFixture(
  compiled: boolean | string = false,
  options: {
    projectedWrites?: boolean;
    nodeEnv?: "test" | "production";
    relay?: boolean;
    webhookReceiver?: string;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "loop-card-access-"));
  const encryptionKey = randomBytes(32).toString("hex");
  const launch = () =>
    spawn(
      process.execPath,
      [
        ...(options.webhookReceiver
          ? [
              "--experimental-test-module-mocks",
              "--import",
              fileURLToPath(
                new URL("../fixtures/webhook-network.mjs", import.meta.url),
              ),
            ]
          : []),
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
          LOOP_DATA_DIR: dir,
          LOOP_URL: "http://127.0.0.1",
          PORT: "0",
          LOOP_TEST_CARDS_COMPILED: compiled ? "1" : "0",
          LOOP_TEST_CARDS_SOURCE: typeof compiled === "string" ? compiled : "",
          LOOP_TEST_CARDS_RELAY: options.relay ? "1" : "0",
          LOOP_TEST_WEBHOOK_RECEIVER: options.webhookReceiver || "",
          NODE_ENV: options.nodeEnv ?? "test",
          TEST: options.nodeEnv === "production" ? "" : process.env.TEST,
          LOOP_ENCRYPTION_KEY: encryptionKey,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
  let child = launch();
  let errors = "";
  child.stderr?.on("data", (chunk) => {
    errors += chunk;
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  let ready: {
    origin: string;
    transportOrigin: string;
    owner: string;
    pair: string;
    fixtureSecret: string;
  };
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
  // Opt in when exercising Feed: this independent connection must commit its
  // projection with its source writes, exactly like the production worker.
  if (options.projectedWrites) installFixtureProjection(database);
  let { origin, transportOrigin } = ready;
  const owner = ready.owner;
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
          port: new URL(transportOrigin).port,
          path,
          method: options.method || (options.body ? "POST" : "GET"),
          headers: {
            host: new URL(origin).host,
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
  const response = await request("/pair", {
    body: {
      ...fleetDeviceFromLink(ready.pair, origin),
      name: "Card fixture",
    },
    headers: { origin },
  });
  if (response.status !== 200)
    throw new Error(
      `Could not pair isolated card fixture (${response.status}): ${await response.text()}`,
    );
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0];
  const csrf = (
    await (await request("/session", { headers: { cookie } })).json()
  ).csrf;
  const browser = {
    origin,
    host: new URL(origin).host,
    cookie,
    "x-loop-csrf": csrf,
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    database.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  // Each server process holds about 250 MiB, so a fixture started inside a
  // Vitest test closes when that test finishes even if the test does not call
  // close(). A fixture started in beforeAll belongs to its file and must be
  // closed in afterAll. Scripts outside Vitest (browser smokes) never load the
  // runner.
  if (process.env.VITEST) {
    const { expect, onTestFinished } = await import("vitest");
    if (expect.getState().currentTestName) onTestFinished(close);
  }
  return {
    get stderr() {
      return errors;
    },
    dir,
    origin,
    get transportOrigin() {
      return transportOrigin;
    },
    owner,
    db: database,
    fixtureSecret: ready.fixtureSecret,
    request,
    browser,
    async webhookFixture(
      action: string,
      input: Record<string, unknown> = {},
    ): Promise<unknown> {
      const reply = once(child, "message");
      child.send({ type: "webhook-fixture", action, input });
      const [result] = await reply;
      if (result.error) throw new Error(result.error);
      return result.result;
    },
    async webhookNetwork(addresses: string[], holdLookupAfter?: number) {
      const reply = once(child, "message");
      child.send({ type: "webhook-network", addresses, holdLookupAfter });
      const [result] = await reply;
      if (!result.network)
        throw new Error("Webhook fixture network did not update");
    },
    async restart() {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      child = launch();
      child.stderr?.on("data", (chunk) => {
        errors += chunk;
      });
      const timeout = setTimeout(() => child.kill(), 20000);
      try {
        const restarted = await Promise.race([
          once(child, "message").then(([message]) => message),
          once(child, "exit").then(() => {
            throw new Error("Card fixture did not restart: " + errors);
          }),
        ]);
        origin = restarted.origin;
        transportOrigin = restarted.transportOrigin;
        browser.origin = origin;
        browser.host = new URL(origin).host;
      } finally {
        clearTimeout(timeout);
      }
    },
    async linkCompanion(remote: {
      origin: string;
      browser: { cookie: string };
    }): Promise<void> {
      const reply = once(child, "message");
      child.send({
        type: "link-companion",
        source: { origin: remote.origin, cookie: remote.browser.cookie },
      });
      const [result] = await reply;
      if (!result.linked) throw new Error("Fixture companion was not linked");
    },
    async tokenWriteFixture(
      action:
        | "lose-response"
        | "fail-completion"
        | "native-success"
        | "native-failure",
    ) {
      const reply = once(child, "message");
      child.send({ type: "token-write-fixture", action });
      const [result] = await reply;
      if (result.error) throw new Error(result.error);
      return result.result as
        | {
            decision: string;
            run: string;
            conversation: string;
            generation: string;
          }
        | undefined;
    },
    async interleaveResultWrite(artifact: string) {
      const armed = once(child, "message");
      child.send({ type: "interleave-result-write", artifact });
      const [result] = await armed;
      if (result.error) throw new Error(result.error);
      return async () => {
        const reply = once(child, "message");
        child.send({ type: "finish-result-write" });
        const [state] = await reply;
        if (state.error) throw new Error(state.error);
        return state as { attempted: boolean; committed: boolean };
      };
    },
    async integrationRecords(
      who = owner,
    ): Promise<
      ReturnType<
        typeof import("../fixtures/integration-records.js").integrationRecords
      >
    > {
      const reply = once(child, "message");
      child.send({ type: "integration-records", owner: who });
      const [result] = await reply;
      if (result.error) throw new Error(result.error);
      return result.records;
    },
    async setBusyTimeout(ms: number): Promise<void> {
      const reply = once(child, "message");
      child.send({ type: "busy-timeout", ms });
      await reply;
    },
    async stopListening(): Promise<void> {
      const reply = once(child, "message");
      child.send({ type: "stop-listener" });
      const [result] = await reply;
      if (result.error) throw new Error(result.error);
    },
    async eventDelta(
      message: string,
      text: string,
      who = owner,
    ): Promise<number> {
      const reply = once(child, "message");
      child.send({ type: "token-event-delta", message, text, owner: who });
      const [result] = await reply;
      if (result.error) throw new Error(result.error);
      return result.event;
    },
    async eventSubscriberCount(): Promise<number> {
      const reply = once(child, "message");
      child.send({ type: "change-subscriber-count" });
      return (await reply)[0].count;
    },
    async tokenSocketCount(): Promise<number> {
      const reply = once(child, "message");
      child.send({ type: "token-socket-count" });
      return (await reply)[0].count;
    },
    close,
  };
}
