import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "../shared/uploads.js";
import { Problem } from "../shared/problem.js";
import { config } from "./config.js";

export function openVerified(
  key: string,
  size: number,
  checksum: string,
): Buffer {
  if (!/^objects\/[a-f0-9]{64}\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(key))
    throw new Problem(409, "Invalid artifact identity");
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_BYTES)
    throw new Problem(413, `Published files can be up to ${MAX_UPLOAD_LABEL}`);
  let descriptor: number;
  try {
    descriptor = openSync(
      join(config.data, key),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Problem(404, "Local file unavailable");
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new Problem(409, "Invalid artifact identity");
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== size)
      throw new Problem(409, "Artifact integrity check failed");
    // A growing or replaced file cannot make a download allocate beyond the
    // retained publication's bounded size. Check the same open descriptor.
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!count) throw new Problem(409, "Artifact integrity check failed");
      offset += count;
    }
    if (
      readSync(descriptor, Buffer.alloc(1), 0, 1, offset) ||
      createHash("sha256").update(bytes).digest("base64") !== checksum
    )
      throw new Problem(409, "Artifact integrity check failed");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}
