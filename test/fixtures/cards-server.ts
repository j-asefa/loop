import { installResultReadHook } from "../helpers/result-read-hook.js";
// An actual production HTTP entrypoint, with no workers or model providers.
// Environment and data directory are supplied by the isolated parent fixture.
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { join } from "node:path";
const source =
  process.env.LOOP55_TEST_CARDS_SOURCE ||
  (process.env.LOOP55_TEST_CARDS_COMPILED === "1"
    ? "../../dist/"
    : "../../src/");
const { config } = await import(source + "server/config.js");
const { db, changes } = await import(source + "server/db.js");
installResultReadHook(db);
const { seal } = await import(source + "server/secrets.js");
let close: () => Promise<void>;
let stopListening: () => Promise<void>;
let origin: string, owner: string, pair: string | undefined;
let transportOrigin: string | undefined;
const tokenSockets = new Set<Duplex>();
function observeTokenSocket(req: IncomingMessage, socket: Duplex) {
  if (req.url?.split("?")[0] !== "/api/events/stream") return;
  tokenSockets.add(socket);
  socket.once("close", () => tokenSockets.delete(socket));
}
if (process.env.LOOP55_PROFILE === "companion") {
  const { WorkspaceHost } = await import(source + "workspace-host.js");
  const { OWNER } = await import(source + "server/native-sessions.js");
  const host = new WorkspaceHost(config.data, {
    harness: "codex",
    version: "fixture",
    project: process.cwd(),
    executable: process.execPath,
    billing: "existing",
  });
  const upgrade = host.gateway.workspace!.tokenEvents!.upgrade;
  host.gateway.workspace!.tokenEvents!.upgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    observeTokenSocket(req, socket);
    upgrade(req, socket, head);
  };
  if (process.env.LOOP55_TEST_CARDS_RELAY === "1") {
    const { Relay } = await import(source + "relay.js");
    const relay = new Relay();
    const path = join(config.data, "gateway.sock");
    await host.gateway.listen({ socket: path });
    await relay.listen("127.0.0.1");
    // Model the TLS edge: the local relay receives HTTP with the public HTTPS
    // Host/Origin, just as it does behind cloudflared. No live tunnel is used.
    transportOrigin = "http://127.0.0.1:" + relay.port;
    origin = "https://cards-fixture.loop55.test";
    host.setOrigin(origin);
    relay.setBackend({ generation: 1, path });
    close = async () => {
      await host.close();
      await relay.close();
    };
  } else {
    await host.gateway.listen();
    origin = host.gateway.origin;
    close = () => host.close();
  }
  owner = OWNER;
  pair = host.pair().url;
  stopListening = () => host.close();
} else {
  const { startServer } = await import(source + "server/serve.js");
  const server = startServer();
  server.on("upgrade", observeTokenSocket);
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
  stopListening = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
// This fixed mock credential exists only in the isolated fixture database.
process.send?.({
  origin,
  transportOrigin: transportOrigin ?? origin,
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
    message.type === "webhook-fixture" &&
    "action" in message &&
    "input" in message
  ) {
    void import("./webhooks.js")
      .then(({ webhookFixture }) =>
        webhookFixture(
          String(message.action),
          message.input as Record<string, unknown>,
        ),
      )
      .then((result) => process.send?.({ result }))
      .catch((error) => process.send?.({ error: String(error) }));
  }
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "stop-listener"
  )
    void stopListening()
      .then(() => process.send?.({ stopped: true }))
      .catch((error) => process.send?.({ error: String(error) }));
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "token-event-delta" &&
    "owner" in message &&
    "message" in message &&
    "text" in message
  ) {
    void import("../../src/server/db.js")
      .then(({ emit }) => {
        const row = db
          .prepare(
            "SELECT id,conversation_id,revision FROM messages WHERE id=? AND owner_id=?",
          )
          .get(message.message, message.owner) as
          { id: string; conversation_id: string; revision: number } | undefined;
        if (!row) throw new Error("Fixture message not found");
        const event = emit(
          String(message.owner),
          { kind: "message", id: row.id },
          "message.delta",
          {
            messageId: row.id,
            conversationId: row.conversation_id,
            revision: row.revision + 1,
            baseRevision: row.revision,
            offset: 0,
            chunkIndex: 0,
            text: String(message.text),
          },
        );
        process.send?.({ event: Number(event) });
      })
      .catch((error) => process.send?.({ error: String(error) }));
  }
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
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "token-socket-count"
  )
    process.send?.({ count: tokenSockets.size });
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, async () => {
    await close();
    db.close();
    process.disconnect?.();
  });
