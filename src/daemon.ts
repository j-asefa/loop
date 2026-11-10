import { openSync, closeSync, writeSync, renameSync, fstatSync } from "node:fs";
import { writeFile, chmod, rm, open } from "node:fs/promises";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const PAIRING_SECRET = /#(pair|fleet)=[\w-]+/g;

/**
 * Routes this process's stdout and stderr into a log capped at maxBytes, with
 * one previous file kept as `.1`. Writes are synchronous, so rotating (rename,
 * then reopen) between two writes never drops or splits a line. A single write
 * larger than the cap is kept whole.
 */
export function installDaemonLog(path: string, maxBytes = LOG_MAX_BYTES) {
  let fd = openSync(path, "a", 0o600);
  let size = fstatSync(fd).size;
  // Set once the current file has become `.1`, until a new file is opened.
  let renamed = false;
  const rotate = () => {
    size = 0;
    try {
      if (!renamed) renameSync(path, path + ".1");
      renamed = true;
      const next = openSync(path, "a", 0o600);
      closeSync(fd);
      fd = next;
      renamed = false;
    } catch (e) {
      // Keep writing to the open file rather than losing output, and retry
      // once another maxBytes has been written.
      writeSync(
        fd,
        `Loop: could not rotate ${path} (${(e as Error).message}); logging continues in the current file.\n`,
      );
    }
  };
  const write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    done?: (error?: Error | null) => void,
  ) => {
    const data =
      typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
        : chunk;
    try {
      if (size > 0 && size + data.length > maxBytes) rotate();
      writeSync(fd, data);
      size += data.length;
    } catch {
      // Losing a log line must never take the workspace down.
    }
    const callback = typeof encoding === "function" ? encoding : done;
    if (callback) queueMicrotask(() => callback());
    return true;
  };
  process.stdout.write = write as typeof process.stdout.write;
  process.stderr.write = write as typeof process.stderr.write;
  // Node prints a fatal exception straight to fd 2, which still points at the
  // file first opened (by now possibly `.1` or deleted), so log it here too.
  // Native fatal errors (such as running out of memory) still bypass this.
  process.on("uncaughtExceptionMonitor", (error) =>
    write(`${(error as Error)?.stack ?? error}\n`),
  );
}

/**
 * Moves the previous run's log to `.1` with pairing secrets redacted, so a
 * fresh 0600 log starts each launch. Keep only its last LOG_MAX_BYTES.
 */
export async function retireLog(path: string) {
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return;
  let previous: string;
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - LOG_MAX_BYTES);
    const { buffer, bytesRead } = await file.read(
      Buffer.alloc(size - start),
      0,
      size - start,
      start,
    );
    previous = buffer.subarray(0, bytesRead).toString("utf8");
    // Drop a partial first line, which could hold a cut-off secret.
    if (start > 0) {
      const line = previous.indexOf("\n");
      previous = line < 0 ? "" : previous.slice(line + 1);
    }
  } finally {
    await file.close();
  }
  await writeFile(
    path + ".1",
    previous.replace(PAIRING_SECRET, "#$1=<redacted>"),
    { mode: 0o600 },
  );
  await chmod(path + ".1", 0o600);
  await rm(path, { force: true });
}
