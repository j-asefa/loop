import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, relative } from "node:path";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// Raw bytes per request. Base64 plus JSON framing stays below the broker's
// 1 MB request limit.
export const UPLOAD_CHUNK_BYTES = 512 * 1024;

// File systems limit names in bytes (255 on Linux and macOS), and Windows
// hosts also reject some characters, trailing dots or spaces and device names.
const UNSAFE_NAME = /[/\\\0-\x1f\x7f:*?"<>|]/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
export const uploadName = (name) =>
  typeof name === "string" &&
  name.length > 0 &&
  Buffer.byteLength(name) <= 255 &&
  !UNSAFE_NAME.test(name) &&
  !/^[.]+$/.test(name) &&
  !/[. ]$/.test(name) &&
  !DEVICE_NAME.test(name);

// A usable name for any upload: unsafe characters replaced, and long names
// shortened to fit while keeping the extension.
export function safeUploadName(name) {
  let clean = String(name ?? "")
    .replace(new RegExp(UNSAFE_NAME.source, "g"), "_")
    .replace(/[. ]+$/, "");
  if (DEVICE_NAME.test(clean)) clean = "_" + clean;
  const extension = extname(clean);
  const keep = Buffer.byteLength(extension) <= 32 ? extension : "";
  let stem = keep ? clean.slice(0, -keep.length) : clean;
  while (stem && Buffer.byteLength(stem + keep) > 255)
    stem = Array.from(stem).slice(0, -1).join("");
  clean = stem + keep;
  return uploadName(clean) ? clean : "file";
}

// Copies one user upload into the agent's file system, one chunk per request.
// With `check`, only reports whether the finished copy is still in place
// (a runtime restart or a recreated workspace removes it) and writes nothing.
// Chunks append to a transfer-private partial file that is renamed into place
// only after its size and SHA-256 match, so a reader never sees a torn file.
export function writeUploadChunk(root, request) {
  const { fileId, transferId, name, size, sha256, check } = request;
  const offset = check === true ? 0 : request.offset;
  const data = check === true ? "" : request.data;
  if (
    typeof fileId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      fileId,
    ) ||
    typeof transferId !== "string" ||
    !/^[a-f0-9]{32}$/.test(transferId) ||
    !uploadName(name) ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_UPLOAD_BYTES ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof data !== "string" ||
    data.length > Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4
  )
    throw new Error("Invalid upload chunk");
  const bytes = Buffer.from(data, "base64");
  if (
    bytes.toString("base64") !== data ||
    offset + bytes.length > size ||
    (bytes.length === 0 && offset !== size && check !== true)
  )
    throw new Error("Invalid upload chunk");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const base = realpathSync(root);
  const directory = join(base, fileId.toLowerCase());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const real = realpathSync(directory);
  if (
    relative(base, real) !== fileId.toLowerCase() ||
    lstatSync(directory).isSymbolicLink()
  )
    throw new Error("Upload directory escaped the workspace");
  const path = join(real, name);
  const digest = (file) =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  const complete = { path, size, complete: true, nextOffset: null };
  // Uploads are immutable, so a retried or later turn reuses the copy.
  if (
    offset === 0 &&
    existsSync(path) &&
    statSync(path).isFile() &&
    statSync(path).size === size &&
    digest(path) === sha256
  )
    return complete;
  if (check === true) return { path, size, complete: false, nextOffset: 0 };
  const partial = join(real, `.${transferId}.part`);
  // Aborted or crashed transfers leave their partial file behind. A new
  // transfer of this upload clears those older than ten minutes.
  if (offset === 0)
    for (const entry of readdirSync(real))
      if (/^\.[a-f0-9]{32}\.part$/.test(entry))
        try {
          const stale = join(real, entry);
          if (Date.now() - lstatSync(stale).mtimeMs > 10 * 60_000)
            rmSync(stale, { force: true });
        } catch {
          // Another transfer removed it first.
        }
  const descriptor = openSync(
    partial,
    offset === 0
      ? constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_TRUNC |
          constants.O_NOFOLLOW
      : constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (
      !fstatSync(descriptor).isFile() ||
      fstatSync(descriptor).size !== offset
    )
      throw new Error("Upload chunk is out of order");
    let written = 0;
    while (written < bytes.length)
      written += writeSync(
        descriptor,
        bytes,
        written,
        bytes.length - written,
        offset + written,
      );
  } catch (error) {
    closeSync(descriptor);
    rmSync(partial, { force: true });
    throw error;
  }
  closeSync(descriptor);
  const end = offset + bytes.length;
  if (end < size) return { path, size, complete: false, nextOffset: end };
  if (digest(partial) !== sha256) {
    rmSync(partial, { force: true });
    throw new Error("Upload checksum mismatch");
  }
  try {
    renameSync(partial, path);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return complete;
}
