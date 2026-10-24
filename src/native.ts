import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { killOwned, own } from "./processes.js";

/** An explicit error response from the harness: it received and refused the request. */
export class NativeRpcError extends Error {
  constructor(
    message: string,
    public code?: number,
    public kind?: string,
  ) {
    super(message);
    this.name = "NativeRpcError";
  }
}
/** A broken/timeout write may have executed; callers must never retry mutations. */
export class Native extends EventEmitter {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<
    string,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private seq = 0;
  private closed = false;
  /** Strict JSON-RPC peers (Muse Code's MSP) reject frames without `jsonrpc`. */
  jsonrpc = false;
  constructor(
    executable: string,
    args: string[],
    cwd: string,
    env = process.env,
    maxFrameBytes = 8 * 1024 * 1024,
  ) {
    super();
    // Supervision belongs to the Loop application, not its harnesses or the
    // commands they launch. Inheriting it can make a test workspace claim the
    // live application's service manager.
    const childEnv = { ...env };
    delete childEnv.LOOP_SERVICE;
    this.child = spawn(executable, args, {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      shell: false,
      detached: true,
    }) as ChildProcessWithoutNullStreams;
    own(this.child);
    let metadata = "";
    (this.child.stdio[3] as NodeJS.ReadableStream).on("data", (chunk) => {
      metadata += chunk.toString();
      if (metadata.length > 100000) {
        this.fail(new Error("Native metadata too large"));
        return;
      }
      let end;
      while ((end = metadata.indexOf("\n")) >= 0) {
        const line = metadata.slice(0, end);
        metadata = metadata.slice(end + 1);
        try {
          this.emit("metadata", JSON.parse(line));
        } catch {
          this.fail(new Error("Invalid metadata"));
        }
      }
    });
    let parts: string[] = [];
    let frameBytes = 0;
    const decoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk) => {
      // Collect fragments once instead of repeatedly copying/scanning a large
      // file-bearing frame on every stdout chunk. Decode split UTF-8 first.
      const segments = decoder.write(chunk).split("\n");
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        if (segment) {
          parts.push(segment);
          frameBytes += Buffer.byteLength(segment);
        }
        if (frameBytes > maxFrameBytes) {
          this.fail(new Error(`Native frame exceeds ${maxFrameBytes / 1024 / 1024} MiB.`));
          return;
        }
        if (index === segments.length - 1) break;
        const line = parts.join("");
        parts = [];
        frameBytes = 0;
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
          if (!m || typeof m !== "object" || Array.isArray(m))
            throw new Error("Expected a record");
        } catch {
          this.fail(new Error("Invalid native JSON frame."));
          return;
        }
        const p = this.pending.get(String(m.id));
        if (
          p &&
          (m.result !== undefined ||
            m.error !== undefined ||
            m.type === "response")
        ) {
          this.pending.delete(String(m.id));
          clearTimeout(p.timer);
          if (m.error || m.success === false)
            p.reject(
              typeof m.error === "object" && m.error
                ? new NativeRpcError(
                    m.error.message || "Native command failed",
                    typeof m.error.code === "number" ? m.error.code : undefined,
                    typeof m.error.data?.kind === "string" ? m.error.data.kind : undefined,
                  )
                : new Error(
                    typeof m.error === "string" ? m.error : "Native command failed",
                  ),
            );
          else p.resolve(m.type === "response" ? m.data : m.result);
        } else {
          try {
            this.emit("message", m);
          } catch {
            this.fail(
              new Error("Unsupported or malformed native protocol message."),
            );
            return;
          }
        }
      }
    });
    // Native stderr may contain credentials/transcripts: drain without persisting or forwarding.
    this.child.stderr.resume();
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", (code, signal) =>
      this.fail(new Error(`Native process exited (${signal ?? code}).`)),
    );
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit("failure", error);
    if (this.child.exitCode === null) killOwned(this.child, "SIGTERM");
  }
  write(message: unknown): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("Native process is closed."));
    const line =
      JSON.stringify(
        this.jsonrpc ? { jsonrpc: "2.0", ...(message as object) } : message,
      ) + "\n";
    return new Promise((resolve, reject) =>
      this.child.stdin.write(line, (e) => (e ? reject(e) : resolve())),
    );
  }
  request(method: string, params: unknown = {}, rpc = true): Promise<any> {
    const id = `loop-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native ${method} timed out; outcome unknown.`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.write(
        rpc
          ? { id, method, params }
          : { id, type: method, ...(params as object) },
      ).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }
  async dispose() {
    if (this.child.exitCode !== null) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Stopped"));
    }
    this.pending.clear();
    this.child.stdin.end();
    killOwned(this.child, "SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killOwned(this.child, "SIGKILL");
        resolve();
      }, 2500);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
