// An actual production HTTP entrypoint, with no workers or model providers.
// Environment and data directory are supplied by the isolated parent fixture.
import { once } from "node:events";
const source =
  process.env.LOOP_TEST_CARDS_SOURCE ||
  (process.env.LOOP_TEST_CARDS_COMPILED === "1" ? "../../dist/" : "../../src/");
const { config } = await import(source + "server/config.js");
const { db, changes } = await import(source + "server/db.js");
const { seal } = await import(source + "server/secrets.js");
let close: () => Promise<void>;
let origin: string, owner: string, pair: string | undefined;
if (process.env.LOOP_PROFILE === "companion") {
  const { WorkspaceHost } = await import(source + "workspace-host.js");
  const { OWNER } = await import(source + "server/native-sessions.js");
  const host = new WorkspaceHost(config.data, {
    harness: "codex",
    version: "fixture",
    project: process.cwd(),
    executable: process.execPath,
    billing: "existing",
  });
  await host.gateway.listen();
  origin = host.gateway.origin;
  owner = OWNER;
  pair = host.pair().url;
  close = () => host.close();
} else {
  const { startServer } = await import(source + "server/serve.js");
  const server = startServer();
  await once(server, "listening");
  origin = config.url =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  owner =
    (
      db.prepare("SELECT owner_id FROM installation WHERE id=1").get() as
        | {
            owner_id: string;
          }
        | undefined
    )?.owner_id || "";
  close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
// This fixed mock credential exists only in the isolated fixture database.
process.send?.({
  origin,
  owner,
  pair,
  fixtureSecret: owner ? seal("fixture-api-key", owner) : undefined,
});
// IPC-only fixture observation; no production route or browser-visible state.
let finishResultWrite:
  (() => { attempted: boolean; committed: boolean }) | undefined;
process.on("message", (message) => {
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "token-write-fixture" &&
    "action" in message
  ) {
    void import("./token-writes.js")
      .then((fixture) => {
        let result: unknown;
        if (message.action === "lose-response") fixture.loseTokenResponse();
        else if (message.action === "fail-completion")
          fixture.failTokenCompletion();
        else if (
          message.action === "native-success" ||
          message.action === "native-failure"
        )
          result = fixture.nativeTokenDecision(
            message.action === "native-failure",
          );
        else throw new Error("Unknown token fixture action");
        process.send?.({ result });
      })
      .catch((error) => process.send?.({ error: String(error) }));
  }
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "interleave-result-write" &&
    "artifact" in message &&
    typeof message.artifact === "string"
  ) {
    void import("./integration-records.js")
      .then(({ interleaveResultWrite }) => {
        finishResultWrite = interleaveResultWrite(message.artifact as string);
        process.send?.({ armed: true });
      })
      .catch((error) => process.send?.({ error: String(error) }));
  }
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "finish-result-write"
  ) {
    try {
      process.send?.(finishResultWrite?.());
    } catch (error) {
      process.send?.({ error: String(error) });
    }
    finishResultWrite = undefined;
  }
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "integration-records" &&
    "owner" in message &&
    typeof message.owner === "string"
  ) {
    void import("./integration-records.js")
      .then(({ integrationRecords }) => {
        process.send?.({
          records: integrationRecords(message.owner as string),
        });
      })
      .catch((error) => process.send?.({ error: String(error) }));
  }
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "busy-timeout" &&
    "ms" in message &&
    typeof message.ms === "number" &&
    Number.isInteger(message.ms) &&
    message.ms >= 0 &&
    message.ms <= 5000
  ) {
    db.pragma(`busy_timeout = ${message.ms}`);
    process.send?.({ type: "busy-timeout", ms: message.ms });
  }
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "change-subscriber-count"
  )
    process.send?.({ count: changes.subscriberCount });
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, async () => {
    await close();
    db.close();
    process.disconnect?.();
  });
