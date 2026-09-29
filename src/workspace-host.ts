import { companionMode } from "./server/profile.js";
import { NativeToolBridge } from "./server/native-tool-bridge.js";
import { Host } from "./host.js";
import type { Options } from "./adapters/types.js";
import { app } from "./server/index.js";
import { db } from "./server/db.js";
import { config } from "./server/config.js";
import { nativeSessions, OWNER } from "./server/native-sessions.js";
import { nativeSignIns } from "./server/native-auth.js";
import { startWorker } from "./server/worker.js";
import { z } from "zod";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

const registration = z
  .object({
    harness: z.enum(["pi", "claude", "codex", "opencode", "acp"]),
    executable: z.string().min(1).max(4096),
    project: z.string().min(1).max(4096),
    version: z.string().max(100),
    billing: z.enum(["subscription", "existing"]),
    args: z.array(z.string().max(4096)).max(32).optional(),
  })
  .strict();
export class WorkspaceHost {
  gateway: Host;
  private tools = new NativeToolBridge();
  private stopWorker?: () => Promise<void>;
  private closing = false;
  private epoch = randomUUID();
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
        executionReady: nativeSessions.registrations().length > 0,
        harnesses: nativeSessions.registrations(),
        activeRuns: db
          .prepare(
            "SELECT count(*) n FROM runs WHERE state IN ('running','awaiting_approval')",
          )
          .get(),
        agents: (db.prepare("SELECT count(*) n FROM agents").get() as any).n,
      }),
      admin: async (action, input) => {
        if (action === "/enable")
          return nativeSessions.enable(registration.parse(input));
        throw new Error("Unknown workspace control command");
      },
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
          send({ v: 2, type: "reset", epoch: this.epoch, cursor });
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
  ) {
    if (this.closing) throw new Error("Workspace is stopping");
    nativeSignIns.open();
    await this.tools.start();
    if (this.closing) {
      await this.tools.close();
      throw new Error("Workspace is stopping");
    }
    nativeSessions.tools = (conversation, generation) =>
      this.tools.issue(conversation, generation);
    nativeSessions.revokeTools = (conversation, generation) =>
      this.tools.revoke(conversation, generation);
    await this.gateway.listen();
    if (this.closing) {
      await this.gateway.close();
      throw new Error("Workspace is stopping");
    }
    const account = managed
      ? await managed()
      : runtimeNeutral
        ? (nativeSessions.addProject(options.project),
          {
            billing: {
              description:
                "Execution host ready. Choose and enable an installed runtime in the app; authentication is checked when enabling.",
            },
          })
        : await nativeSessions.enable(options);
    await beforeWorker?.();
    if (this.closing) throw new Error("Workspace is stopping");
    this.stopWorker = startWorker();
    return account;
  }
  async close() {
    this.closing = true;
    await nativeSignIns.close();
    await this.stopWorker?.();
    if (!this.stopWorker) await nativeSessions.close();
    await this.tools.close();
    await this.gateway.close();
  }
}
