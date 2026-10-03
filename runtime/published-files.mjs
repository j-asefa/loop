import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { createHash } from "node:crypto";
export const MAX_PUBLISHED_BYTES = 25 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 512 * 1024;
const types = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".zip": "application/zip",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
// A file the agent asked to publish that cannot be: missing, private,
// changing or too large. The message is written for the agent to act on and
// names only the relative path it gave, so the broker may return it as is.
export class FileRejected extends Error {
  name = "FileRejected";
}
const megabytes = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " MB";
export const fileMime = (name) =>
  types[extname(name).toLowerCase()] || "application/octet-stream";
const privatePath = (path) =>
  path.split("/").some((p) => p.startsWith(".")) ||
  /(?:^|\/)(?:auth|credentials?|secrets?|tokens?)(?:[._-]|$)/i.test(path);
export function readPublishedChunk(directory, path, offset = 0, version) {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 4096 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    privatePath(path)
  )
    throw new FileRejected(
      "Choose a generated file inside the workspace; hidden files and credentials cannot be published",
    );
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new FileRejected("Invalid file offset");
  const root = realpathSync(directory);
  const within = (value) => {
    const rel = relative(root, value);
    return rel && !privatePath(rel) && !isAbsolute(rel);
  };
  let target;
  try {
    target = realpathSync(join(root, path));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR")
      throw new FileRejected(`No file at ${path} in the workspace`);
    throw error;
  }
  if (!within(target)) throw new FileRejected("File escaped the workspace");
  const expected = statSync(target);
  const descriptor = openSync(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const actual = realpathSync(
      process.platform === "linux" ? "/proc/self/fd/" + descriptor : target,
    );
    const st = fstatSync(descriptor);
    if (
      !within(actual) ||
      !st.isFile() ||
      st.dev !== expected.dev ||
      st.ino !== expected.ino ||
      st.nlink !== 1
    )
      throw new FileRejected(
        "File changed or is not a regular workspace file",
      );
    if (st.size > MAX_PUBLISHED_BYTES)
      throw new FileRejected(
        `This file is ${megabytes(st.size)}; Loop publishes files up to 25 MB. Make it smaller, for example by compressing or splitting it, then publish again.`,
      );
    if (offset > st.size)
      throw new FileRejected("File changed during publication");
    const identity = createHash("sha256")
      .update(JSON.stringify([st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs]))
      .digest("hex");
    if (version && version !== identity)
      throw new FileRejected("File changed during publication");
    const bytes = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, st.size - offset));
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(
        descriptor,
        bytes,
        count,
        bytes.length - count,
        offset + count,
      );
      if (!n) throw new FileRejected("File changed during publication");
      count += n;
    }
    const after = fstatSync(descriptor);
    if (
      after.size !== st.size ||
      after.mtimeMs !== st.mtimeMs ||
      after.ctimeMs !== st.ctimeMs
    )
      throw new FileRejected("File changed during publication");
    return {
      name: basename(path),
      mime: fileMime(path),
      size: st.size,
      version: identity,
      offset,
      nextOffset: offset + count < st.size ? offset + count : null,
      base64: bytes.toString("base64"),
    };
  } finally {
    closeSync(descriptor);
  }
}
