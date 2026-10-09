import { runtimeSetupState } from "./runtime-setup.js";
import { companionMode } from "./server/profile.js";
import { Host } from "./host.js";
import type { Options } from "./adapters/types.js";
import { app } from "./server/index.js";
import { db } from "./server/db.js";
import { config } from "./server/config.js";
import { nativeSessions, OWNER } from "./server/native-sessions.js";
import { startWorker } from "./server/worker.js";
import { WebSocket } from "ws";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DockerMcpSharing } from "./mcp-docker-sharing.js";

// Identifies the browser assets this launch serves. A reconnecting page
// compares it to offer a reload without discarding its draft.
const BUILD = (() => {
  try {
    return createHash("sha256")
      .update(readFileSync(new URL("./web/index.html", import.meta.url)))
      .digest("hex")
      .slice(0, 12);
  } catch {
    return "development";
  }
})();

export class WorkspaceHost {
  gateway: Host;
  private mcpSharing = new DockerMcpSharing();
  private stopWorker?: () => Promise<void>;
  private closing = false;
  private epoch = randomUUID();
  /** Set before start() to serve the gateway behind the connection service. */
  listenOptions?: Parameters<Host["listen"]>[0];
  /** Launch facts owned by the CLI (connection, supervisor), merged into status. */
  statusExtras: () => object = () => ({});
  constructor(dir: string, options: Options) {
    if (!companionMode)
      throw new Error(
        "WorkspaceHost requires LOOP_PROFILE=companion before loading the application",
      );
    this.gateway = new Host(dir, {
      harness: options.harness,
      project: options.project,
      version: options.version,
      billing: { mode: options.billing, description: "Workspace host" },
      capabilities: {
        approvals: true,
        questions: true,
        resume: true,
        liveAttach: false,
        terminal: false,
      },
    });
    this.gateway.workspace = {
      http: app,
      status: () => ({
        workspace: true,
        state: "ready",
        project: options.project,
        serverReady: true,
        executionReady: runtimeSetupState() === "ready",
        executionBackend: "hapi",
        harnesses: db
          .prepare(
            "SELECT json_extract(metadata,'$.flavor') name FROM connections WHERE owner_id=? AND status='connected' AND json_extract(metadata,'$.backend')='hapi'",
          )
          .all(OWNER),
        activeRuns: db
          .prepare(
            "SELECT count(*) n FROM runs WHERE state IN ('running','awaiting_approval')",
          )
          .get(),
        agents: (db.prepare("SELECT count(*) n FROM agents").get() as any).n,
        build: BUILD,
        ...this.statusExtras(),
      }),
      admin: async (action, input) => {
        throw new Error("Unknown workspace control command");
      },
      shareTools: (sourceId, action) =>
        sourceId
          ? action === "disconnect"
            ? this.mcpSharing.disconnect(sourceId)
            : this.mcpSharing.connect(sourceId)
          : this.mcpSharing.status(),
      originChanged: (origin) => {
        config.url = origin;
      },
      connect: (socket, url) => {
        let cursor = Number(url.searchParams.get("cursor"));
        const bounds = () =>
          db
            .prepare(
              "SELECT min(id) first,max(id) last FROM events WHERE owner_id=?",
            )
            .get(OWNER) as { first: number | null; last: number | null };
        const range = bounds();
        const send = (data: unknown) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (socket.bufferedAmount > 2 * 1024 * 1024) {
            socket.close(4008, "Reconnect for current workspace state");
            return;
          }
          socket.send(JSON.stringify(data));
        };
        if (
          url.searchParams.get("epoch") !== this.epoch ||
          !Number.isSafeInteger(cursor) ||
          cursor < (range.first || 1) - 1 ||
          cursor > (range.last || 0)
        ) {
          cursor = range.last || 0;
          // Cursor captured and subscription installed in one JS turn. Clients refresh
          // their projections, then continue receiving every newer committed event.
          send({ v: 2, type: "reset", epoch: this.epoch, cursor, build: BUILD });
        }
        const poll = () => {
          const events = db
            .prepare(
              "SELECT id,run_id,type,payload FROM events WHERE owner_id=? AND id>? ORDER BY id LIMIT 100",
            )
            .all(OWNER, cursor) as { id: number }[];
          if (events.length) {
            cursor = events.at(-1)!.id;
            send({ v: 2, type: "events", epoch: this.epoch, cursor, events });
          }
        };
        poll();
        const timer = setInterval(poll, 120);
        return () => clearInterval(timer);
      },
    };
  }
  get port() {
    return this.gateway.port;
  }
  get origin() {
    return this.gateway.origin;
  }
  pair() {
    return this.gateway.pair();
  }
  setOrigin(origin: string) {
    this.gateway.setOrigin(origin);
  }
  async start(
    options: Options,
    beforeWorker?: () => Promise<void>,
    managed?: () => Promise<any>,
    runtimeNeutral = false,
    onListening?: () => Promise<void>,
  ) {
    if (this.closing) throw new Error("Workspace is stopping");
    await this.gateway.listen(this.listenOptions);

    this.mcpSharing.start();
    if (this.closing) {
      await this.gateway.close();
      throw new Error("Workspace is stopping");
    }
    // Pairing and the public gateway can be made available before runner startup.
    // Register the project first so a paired client can inspect its workspace.
    nativeSessions.addProject(options.project);
    await onListening?.();
    if (this.closing) throw new Error("Workspace is stopping");
    const account = (await managed?.()) ?? {
      billing: {
        description:
          "Workspace ready. Harness execution requires a working HAPI runner. Check loop logs and restart Loop to retry setup.",
      },
    };
    await beforeWorker?.();
    if (this.closing) throw new Error("Workspace is stopping");
    this.stopWorker = startWorker();
    return account;
  }
  async close() {
    this.closing = true;
    this.mcpSharing.close();
    await this.stopWorker?.();
    if (!this.stopWorker) await nativeSessions.close();
    await this.gateway.close();
  }
}
