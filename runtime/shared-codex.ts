import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
type ProcessPipe = EventEmitter & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
};
type Operation = {
  controlId?: string;
  action: string;
  onEvent: (event: any) => void;
  ready: boolean;
  done: boolean;
  error?: unknown;
  result?: any;
  cancel: (error?: unknown) => void;
  finish: (error?: unknown) => void;
  controls: SteeringControls;
  idle?: ReturnType<typeof idleDeadline>;
  login?: ReturnType<typeof loginDeadline>;
  timer?: ReturnType<typeof setTimeout>;
};
import { randomUUID } from "node:crypto";
import { lines } from "./protocol.ts";
import {
  RuntimeFailure,
  diagnosticText,
  runtimeFailureFacts,
} from "./diagnostics.ts";
import { idleDeadline } from "./idle-deadline.ts";
import { loginDeadline } from "./login-deadline.ts";
import { SteeringControls } from "./steering.ts";

// Multiplex the private broker/worker pipe. Only the broker holds the Docker
// socket. Cancelling an operation never terminates the shared process.
export class SharedCodex {
  operations = new Map<string, Operation>();
  declare process: ProcessPipe;
  declare stop: () => void;
  declare onClose: () => void;
  declare containerName?: string;
  closed = false;
  constructor(process: ProcessPipe, stop: () => void, onClose: () => void) {
    Object.assign(this, { process, stop, onClose });
    process.stderr.resume();
    process.stdin.on("error", () => this.close());
    process.once("error", () => this.close());
    process.once("close", (exitCode, signal) =>
      this.close(
        new RuntimeFailure(
          `The shared Codex runtime stopped (${signal ? `signal ${signal}` : `exit code ${exitCode}`}). Active turns were interrupted; inspect partial work before retrying.`,
          { phase: "process", exitCode, signal },
        ),
      ),
    );
    lines(
      process.stdout,
      (message) => {
        const m = message.event;
        if (m?.error && m.diagnostic?.phase === "process") {
          // The native process can fail before the worker pipe closes. Retire
          // this worker now so a new request cannot reuse its dead session.
          this.close(
            new RuntimeFailure(
              diagnosticText(m.error),
              runtimeFailureFacts(m.diagnostic),
            ),
          );
          return;
        }
        const op = this.operations.get(message.id);
        if (!op) return;
        if (m.finished) {
          op.finish();
          return;
        }
        if (m.steeringResult) {
          op.controls.receive(m.steeringResult);
          return;
        }
        if (m.steeringReady) op.ready = true;
        if (m.done || m.error) op.ready = false;
        if (m.chunk || m.done || m.result) op.idle?.progress();
        if (m.done) op.done = true;
        if (m.result) op.result = m.result;
        if (m.error && op.error) return;
        if (m.error)
          op.error = new RuntimeFailure(
            diagnosticText(m.error),
            runtimeFailureFacts(m.diagnostic),
          );
        if (m.login) {
          op.login?.ready();
          m.expiresAt = op.login?.expiresAt;
        }
        op.onEvent(m);
      },
      (error) => this.close(error),
    );
  }
  write(message: unknown) {
    if (this.closed || this.process.stdin.destroyed)
      throw new RuntimeFailure("Shared Codex runtime is closed");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  run(
    request: {
      action: string;
      input?: { controlId?: string };
      [key: string]: unknown;
    },
    onEvent: (event: any) => void,
    signal?: AbortSignal,
  ): Promise<any> {
    if (this.closed)
      return Promise.reject(
        new RuntimeFailure("Shared Codex runtime is closed"),
      );
    const controlId = request.input?.controlId;
    if (
      controlId &&
      [...this.operations.values()].some((op) => op.controlId === controlId)
    )
      return Promise.reject(new RuntimeFailure("Duplicate runtime control ID"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const op = {
        controlId,
        action: request.action,
        onEvent,
        ready: false,
        done: false,
      } as Operation;
      const cancel = (error = signal?.reason || new Error("Cancelled")) => {
        op.error ||= error;
        op.ready = false;
        try {
          this.write({ id, cancel: true });
        } catch (error) {
          op.finish(error);
        }
      };
      const abort = () => cancel();
      op.cancel = cancel;
      op.controls = new SteeringControls((steer) => this.write({ id, steer }));
      op.finish = (error) => {
        if (!this.operations.delete(id)) return;
        op.idle?.clear();
        op.login?.clear();
        clearTimeout(op.timer);
        op.controls.close();
        signal?.removeEventListener("abort", abort);
        if (error || op.error) reject(error || op.error);
        else if (request.action === "turn" ? !op.done : !op.result)
          reject(
            new RuntimeFailure(
              "Shared Codex operation ended before completion",
            ),
          );
        else resolve(op.result);
      };
      this.operations.set(id, op);
      if (request.action === "turn") op.idle = idleDeadline(cancel);
      else if (request.action === "login") op.login = loginDeadline(cancel);
      else
        op.timer = setTimeout(
          () => cancel(new RuntimeFailure("Codex operation timed out")),
          45000,
        );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        op.finish(signal.reason);
        return;
      }
      try {
        this.write({ id, request });
      } catch (error) {
        op.finish(error);
      }
    });
  }
  steer(controlId: string, id: string, text: string) {
    const op = [...this.operations.values()].find(
      (op) => op.ready && op.controlId === controlId,
    );
    return op?.controls.send(id, text);
  }
  cancelLogin() {
    for (const op of this.operations.values())
      if (op.action === "login") op.cancel(new Error("Sign-in cancelled"));
  }
  close(error: unknown = new RuntimeFailure("Shared Codex runtime closed")) {
    if (this.closed) return;
    this.closed = true;
    for (const op of this.operations.values()) op.finish(error);
    this.stop();
    this.onClose();
  }
}
