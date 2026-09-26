import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { AdapterEvent, Event, Snapshot, Receipt } from "./protocol.js";

export const secret = () => randomBytes(32).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function atomic(path: string, data: unknown) {
  const tmp = path + "." + randomUUID() + ".tmp";
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(data));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const parent = openSync(dirname(path), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
export function privateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Display projection only. Native session files remain the context source of truth. */
export class State {
  snapshot: Snapshot;
  events: Event[] = [];
  receipts = new Map<string, Receipt & { digest: string }>();
  private eventBytes = 0;
  constructor(
    private dir: string,
    initial: Omit<
      Snapshot,
      | "session"
      | "epoch"
      | "cursor"
      | "items"
      | "requests"
      | "status"
      | "truncated"
    >,
  ) {
    privateDir(dir);
    this.snapshot = {
      ...initial,
      session: randomUUID(),
      epoch: randomUUID(),
      cursor: 0,
      items: [],
      requests: [],
      status: "starting",
      truncated: false,
    };
    this.save();
  }
  save() {
    atomic(join(this.dir, "session.json"), {
      snapshot: this.snapshot,
      receipts: [...this.receipts.values()],
    });
  }
  apply(input: AdapterEvent): Event {
    // Bound native payloads before projection, retention and transport.
    const event: AdapterEvent = structuredClone(input);
    if (event.type === "item") event.item.text = event.item.text.slice(-64000);
    if (event.type === "delta") event.text = event.text.slice(-64000);
    if (
      event.type === "request" &&
      (JSON.stringify(event.request).length > 64000 ||
        this.snapshot.requests.length >= 25)
    ) {
      throw new Error(
        "Native request exceeds safe display bounds; refusing incomplete approval display.",
      );
    }
    const s = this.snapshot;
    switch (event.type) {
      case "status":
        s.status = event.status;
        s.recoverable = event.status === "failed" && event.recoverable === true;
        s.detail = event.detail;
        break;
      case "metadata":
        s.nativeSession = event.nativeSession;
        if (event.billing) s.billing = event.billing;
        break;
      case "error":
        s.detail = event.message.slice(0, 2000);
        break;
      case "request":
        s.requests = [
          ...s.requests.filter((r) => r.id !== event.request.id),
          event.request,
        ];
        s.status = "awaiting-input";
        break;
      case "resolved":
        s.requests = s.requests.filter((r) => r.id !== event.id);
        if (!s.requests.length && s.status === "awaiting-input")
          s.status = "running";
        break;
      case "item": {
        const index = s.items.findIndex((i) => i.id === event.item.id);
        if (index >= 0) s.items[index] = event.item;
        else s.items.push(event.item);
        break;
      }
      case "delta": {
        let item = s.items.find((i) => i.id === event.id);
        if (!item) {
          item = { id: event.id, kind: "assistant", text: "" };
          s.items.push(item);
        }
        item.text = (item.text + event.text).slice(-64000);
        break;
      }
    }
    let bytes = s.items.reduce((n, i) => n + i.text.length, 0);
    while (s.items.length > 200 || bytes > 700000) {
      bytes -= s.items.shift()!.text.length;
      s.truncated = true;
    }
    const frame: Event = { v: 1, epoch: s.epoch, cursor: ++s.cursor, event };
    this.events.push(frame);
    this.eventBytes += JSON.stringify(frame).length;
    while (this.events.length > 512 || this.eventBytes > 700000)
      this.eventBytes -= JSON.stringify(this.events.shift()).length;
    return frame;
  }
  replay(epoch: string, cursor: number): Event[] | undefined {
    if (
      epoch !== this.snapshot.epoch ||
      cursor > this.snapshot.cursor ||
      cursor < (this.events[0]?.cursor ?? 1) - 1
    )
      return;
    return this.events.filter((e) => e.cursor > cursor);
  }
  begin(id: string, digest: string): Receipt | undefined {
    const previous = this.receipts.get(id);
    if (previous) {
      if (previous.digest !== digest)
        throw new Error("Command ID reused with different content.");
      return previous;
    }
    if (this.receipts.size >= 4096)
      throw new Error(
        "This host reached its command limit. Restart with --resume to continue.",
      );
    // Persist unknown BEFORE handing to the native process. A crash never triggers an automatic retry.
    this.receipts.set(id, {
      id,
      digest,
      status: "unknown",
      message: "Native outcome not yet confirmed. Do not resend.",
    });
    this.save();
  }
  receipt(id: string, status: Receipt["status"], message?: string) {
    const old = this.receipts.get(id)!;
    const r = { ...old, status, message };
    this.receipts.set(id, r);
    this.save();
    return { id, status, message };
  }
}
