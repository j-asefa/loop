import type { IncomingMessage, ServerResponse } from "node:http";
import type { Request, Response } from "express";
import multer from "multer";
import { FleetUploadInput } from "../shared/fleet-workspace-upload-api.js";
import { FLEET_FILE_BYTES } from "../shared/fleet-workspace-file-api.js";
import { ExecutionRefused } from "./execution-refusal.js";

const limit = FLEET_FILE_BYTES + 16_384;
const multipart = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: FLEET_FILE_BYTES,
    files: 1,
    fields: 1,
    fieldSize: 8192,
    parts: 2,
    headerPairs: 32,
  },
}).single("file");

/** The peer source accepts only a manifest and one bounded file. The manifest
 * avoids multipart filename encodings changing the browser's durable digest;
 * no multipart field chooses the owner or the destination machine. */
export function fleetUploadBody(
  req: IncomingMessage,
  res: ServerResponse,
  signal: AbortSignal,
  current: () => void,
  receiptOnly: boolean,
): Promise<{ input: FleetUploadInput; bytes?: Buffer }> {
  const length = Number(req.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > limit)
    throw new ExecutionRefused(413, "Files can be up to 25 MB each.");
  if (
    !/^multipart\/form-data\s*;/i.test(req.headers["content-type"] ?? "") ||
    (req.headers["content-encoding"] &&
      req.headers["content-encoding"] !== "identity")
  )
    throw new ExecutionRefused(415, "Choose a file to upload.");
  return new Promise((resolve, reject) => {
    let size = 0,
      finished = false;
    const clean = () => {
      req.off("data", data);
      req.off("error", failed);
      signal.removeEventListener("abort", abort);
    };
    const failed = (error: unknown) => {
      if (finished) return;
      finished = true;
      clean();
      reject(error);
    };
    const abort = () => {
      failed(
        new ExecutionRefused(
          408,
          "The upload was cancelled before forwarding.",
        ),
      );
      req.destroy();
    };
    const data = (bytes: Buffer) => {
      try {
        current();
        size += bytes.length;
        if (size > limit)
          throw new ExecutionRefused(413, "Files can be up to 25 MB each.");
      } catch (error) {
        failed(error);
        req.destroy();
      }
    };
    req.on("data", data);
    req.once("error", failed);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    multipart(req as Request, res as Response, (error) => {
      if (finished) return;
      if (error) {
        failed(
          new ExecutionRefused(
            400,
            "The upload parts are incomplete or exceed the file limits.",
          ),
        );
        return;
      }
      try {
        current();
        signal.throwIfAborted();
        const parsed = req as Request;
        if (
          !parsed.body ||
          Object.keys(parsed.body).length !== 1 ||
          typeof parsed.body.manifest !== "string" ||
          (receiptOnly ? !!parsed.file : !parsed.file)
        )
          throw new ExecutionRefused(
            400,
            "Choose one file and its original upload description.",
          );
        const input = FleetUploadInput.parse(JSON.parse(parsed.body.manifest));
        const bytes = parsed.file?.buffer;
        if (bytes && bytes.length !== input.body.file.size)
          throw new ExecutionRefused(
            409,
            "The upload size changed before forwarding.",
          );
        finished = true;
        clean();
        resolve({ input, bytes });
      } catch (error) {
        failed(error);
      }
    });
  });
}
