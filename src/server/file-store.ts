import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  mkdirSync,
  writeFileSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "../shared/uploads.js";
import { Problem } from "../shared/problem.js";
import { config } from "./config.js";

export function openVerified(
  key: string,
  size: number,
  checksum: string,
): Buffer {
  if (key.length > 300 || !/^objects(?:\/[a-f0-9-]+)+$/.test(key))
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

export function storeFile(owner: string, bytes: Buffer) {
  if (bytes.length > MAX_UPLOAD_BYTES)
    throw new Problem(413, `Published files can be up to ${MAX_UPLOAD_LABEL}`);
  const digest = createHash("sha256").update(bytes).digest();
  const checksum = digest.toString("base64");
  const key = `objects/${createHash("sha256").update(owner).digest("hex")}/${digest.toString("hex")}`;
  const path = join(config.data, key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Existing content is verified too: a corrupt object is never silently reused.
  openVerified(key, bytes.length, checksum);
  return { key, size: bytes.length, checksum };
}
