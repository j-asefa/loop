import type { Readable } from "node:stream";

/** Consume only the private extension handshake, never model/stdout events. */
export function waitForPiTools(stream: Readable, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", data);
      stream.off("end", failed);
      stream.off("close", failed);
      stream.off("error", failed);
      if (ready) resolve();
      else reject(new Error("Managed Pi workspace tools failed to initialize"));
    };
    const failed = () => finish(false);
    const data = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 1024) return failed();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        finish(message.type === "loop-mcp-ready" && message.ready === true);
      } catch { failed(); }
    };
    const timer = setTimeout(failed, timeoutMs);
    stream.on("data", data);
    stream.once("end", failed);
    stream.once("close", failed);
    stream.once("error", failed);
    if (stream.destroyed || stream.readableEnded) failed();
  });
}
