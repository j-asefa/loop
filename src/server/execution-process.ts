import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { own, killOwned } from "../processes.js";
import { ExecutionProblem } from "../shared/problem.js";
import {
  ExecutionChildMessage,
  ExecutionParentMessage,
  EXECUTION_REQUEST_BYTES,
  EXECUTION_RESPONSE_BYTES,
  type ExecutionRequest,
} from "../shared/execution-authority.js";
import {
  executionClient,
  setExecutionTransport,
  type ExecutionTransport,
} from "./execution-client.js";
import { boundedExecutionJson } from "./execution-wire.js";
import { config } from "./config.js";
import { retireStoppedExecution } from "./execution-ownership.js";
import { groupAlive } from "../daemon.js";

export type ExecutionLifecycle = {
  open(): Promise<void>;
  schedule(): Promise<void>;
  close(): Promise<void>;
  setOrigin?(origin: string): void;
};
const disconnected = () =>
  new ExecutionProblem(
    503,
    "Execution worker disconnected. Inspect the command outcome before retrying; no command was replayed.",
    "unknown",
  );

/** The API owns the IPC connection, never a native session. Lost requests are
 * rejected, not queued for the next generation. Only lifecycle is restored. */
export class ExecutionProcess
  implements ExecutionTransport, ExecutionLifecycle
{
  private child?: ChildProcess;
  private generation: string = randomUUID();
  private state: "starting" | "ready" | "stopping" | "disconnected" =
    "disconnected";
  private pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private stopping = false;
  private scheduled = false;
  private started = false;
  private failures = 0;
  private restart?: NodeJS.Timeout;
  private origin?: string;
  private appliedOrigin?: string;
  private workerReady = false;
  private syncingOrigin?: { child: ChildProcess; promise: Promise<void> };
  status() {
    return { v: 1 as const, generation: this.generation, state: this.state };
  }
  private failPending() {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(disconnected());
    }
    this.pending.clear();
    executionClient.disconnect();
  }
  open() {
    if (this.stopping) return Promise.reject(disconnected());
    if (this.opening) return this.opening;
    const opening = (this.opening = this.launch());
    void opening.catch(() => {
      if (this.opening === opening) this.opening = undefined;
    });
    return opening;
  }
  private retry() {
    if (this.stopping || !this.started || this.restart) return;
    const delay = Math.min(5000, 250 * 2 ** Math.min(this.failures++, 5));
    this.restart = setTimeout(() => {
      this.restart = undefined;
      void this.open().catch(() => {});
    }, delay);
  }
  private invalidate(child: ChildProcess) {
    if (this.child !== child) return;
    this.workerReady = false;
    this.state = "disconnected";
    this.failPending();
    killOwned(child, "SIGKILL");
  }
  private launch(): Promise<void> {
    this.state = "starting";
    this.workerReady = false;
    this.appliedOrigin = undefined;
    this.syncingOrigin = undefined;
    // Mark remote immediately: requests during startup/restart must never
    // lazily create the old in-process authority.
    setExecutionTransport(this);
    const source = import.meta.url.endsWith(".ts");
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.child = fork(
          new URL(
            source ? "./execution-worker.ts" : "./execution-worker.js",
            import.meta.url,
          ),
          [],
          {
            execArgv: source ? ["--import", "tsx"] : [],
            env: {
              ...process.env,
              LOOP_PROFILE: "companion",
              LOOP_DATA_DIR: config.data,
            },
            detached: true,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            serialization: "json",
          },
        );
      } catch (error) {
        this.state = "disconnected";
        this.failPending();
        this.retry();
        reject(error);
        return;
      }
      child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
      child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
      let ready = false;
      const timeout = setTimeout(() => {
        reject(new Error("Execution worker did not become ready."));
        this.invalidate(child);
      }, 30_000);
      child.on("message", (raw) => {
        if (this.child !== child || this.stopping) return;
        try {
          const message = ExecutionChildMessage.parse(
            boundedExecutionJson(raw, EXECUTION_RESPONSE_BYTES + 1024),
          );
          if (message.type === "ready") {
            if (ready || message.ready.state !== "ready") throw disconnected();
            this.generation = message.ready.generation;
            ready = true;
            this.workerReady = true;
            void (async () => {
              await this.syncOrigin(child);
              if (this.scheduled) await this.lifecycle("schedule");
              await this.syncOrigin(child);
              if (this.child !== child || !this.workerReady || this.stopping)
                throw disconnected();
              this.state = "ready";
              this.started = true;
              clearTimeout(timeout);
              setExecutionTransport(this);
            })().then(resolve, (error) => {
              reject(error);
              this.invalidate(child);
            });
            return;
          }
          const value =
            message.type === "response" ? message.response : message;
          if (value.generation !== this.generation) return;
          const item = this.pending.get(value.requestId);
          if (!item) return;
          clearTimeout(item.timer);
          this.pending.delete(value.requestId);
          item.resolve(value);
        } catch {
          this.invalidate(child);
        }
      });
      const ended = (error?: Error) => {
        clearTimeout(timeout);
        if (this.child !== child) return;
        // This child was launched as our detached group leader. Stop attached
        // installers/helpers that survived it before attempting replacement.
        killOwned(child, "SIGKILL");
        this.child = undefined;
        this.workerReady = false;
        this.state = "disconnected";
        this.failPending();
        this.opening = undefined;
        reject(
          error ??
            new Error(
              "Execution worker exited before readiness; inspect loop logs.",
            ),
        );
        this.retry();
      };
      child.once("error", (error) => {
        reject(error);
        // A failed spawn need not emit exit. There is no process to wait for.
        if (!child.pid) ended(error);
        else this.invalidate(child);
      });
      child.once("exit", () => ended());
      child.once("disconnect", () => {
        if (this.child !== child) return;
        this.workerReady = false;
        this.state = "disconnected";
        this.failPending();
        // A live worker that drops IPC cannot remain an unsupervised owner.
        if (child.exitCode === null && child.signalCode === null)
          killOwned(child, "SIGTERM");
        const kill = setTimeout(() => killOwned(child, "SIGKILL"), 10_000);
        child.once("exit", () => clearTimeout(kill));
      });
      try {
        own(child);
      } catch (error) {
        reject(error);
        this.invalidate(child);
      }
    });
  }
  private exchange(
    message: z.infer<typeof ExecutionParentMessage>,
    timeout = 300_000,
  ): Promise<unknown> {
    const child = this.child;
    const lifecycle = message.type === "lifecycle";
    // Lifecycle has bounded reserved capacity and can restore a connected
    // child before public readiness. User actions cannot enter that lane.
    if (
      !child?.connected ||
      this.stopping ||
      !this.workerReady ||
      (!lifecycle && this.state !== "ready")
    )
      return Promise.reject(disconnected());
    if (this.pending.size >= (lifecycle ? 132 : 128))
      return Promise.reject(
        new ExecutionProblem(
          503,
          "Execution worker requests are busy. This request was not sent; retry after pending requests settle.",
          "refused",
        ),
      );
    const input = ExecutionParentMessage.parse(
      boundedExecutionJson(message, EXECUTION_REQUEST_BYTES + 1024),
    );
    const id =
      input.type === "request" ? input.request.requestId : input.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(disconnected());
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      child.send(input, (error) => {
        if (!error) return;
        const item = this.pending.get(id);
        if (item) {
          clearTimeout(item.timer);
          this.pending.delete(id);
          item.reject(disconnected());
        }
      });
    });
  }
  send(request: ExecutionRequest) {
    return this.exchange({ type: "request", request });
  }
  private async lifecycle(
    action: "schedule" | "origin" | "stop",
    origin?: string,
  ) {
    const response = (await this.exchange(
      {
        type: "lifecycle",
        requestId: randomUUID(),
        generation: this.generation,
        action,
        origin,
      },
      30_000,
    )) as { ok: boolean };
    if (!response.ok) throw disconnected();
  }
  private syncOrigin(child: ChildProcess): Promise<void> {
    if (this.syncingOrigin?.child === child) return this.syncingOrigin.promise;
    const promise = (async () => {
      while (this.origin && this.origin !== this.appliedOrigin) {
        if (this.child !== child || !this.workerReady) throw disconnected();
        const origin = this.origin;
        await this.lifecycle("origin", origin);
        if (this.child !== child) throw disconnected();
        this.appliedOrigin = origin;
      }
    })();
    const work = (this.syncingOrigin = { child, promise });
    const clear = () => {
      if (this.syncingOrigin === work) this.syncingOrigin = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }
  async schedule() {
    this.scheduled = true;
    await this.open();
    const child = this.child;
    try {
      await this.lifecycle("schedule");
    } catch (error) {
      if (child) this.invalidate(child);
      throw error;
    }
  }
  setOrigin(origin: string) {
    this.origin = origin;
    const child = this.child;
    if (child && this.workerReady)
      void this.syncOrigin(child).catch(() => this.invalidate(child));
  }
  close() {
    return (this.closing ??= (async () => {
      this.stopping = true;
      this.state = "stopping";
      this.workerReady = false;
      this.failPending();
      if (this.restart) clearTimeout(this.restart);
      const child = this.child;
      if (child) {
        // Closing IPC requests is intentionally not an action retry.
        if (child.connected) child.disconnect();
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolve();
          const timer = setTimeout(() => killOwned(child, "SIGKILL"), 10_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      this.state = "disconnected";
      this.failPending();
      if (this.started) {
        // Forced termination may precede native cleanup. The OS lock prevents
        // this cleanup from racing a replacement; it never recovers runs.
        const deadline = Date.now() + 2000;
        while (child?.pid && groupAlive(child.pid)) {
          if (Date.now() > deadline)
            throw new Error("Execution worker process group has not stopped.");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await retireStoppedExecution(config.data);
      }
    })());
  }
}
