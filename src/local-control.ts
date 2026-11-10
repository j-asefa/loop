import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Problem } from "./shared/problem.js";

type Target = { socketPath: string } | { port: number };
type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  timeout?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
};

export class ControlError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Local control performs one attempt. A lost response never authorizes replay. */
export function jsonClient(target: Target, token?: string) {
  return async function send<T = any>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const {
      method = "POST",
      body = {},
      timeout = 5000,
      maxBytes = 100000,
    } = options;
    const payload = method === "GET" ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          ...target,
          path,
          method,
          timeout,
          headers: {
            "Content-Type": "application/json",
            ...options.headers,
            ...(token === undefined
              ? {}
              : { Authorization: "Bearer " + token }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              const error = new ControlError(
                "Local control response is too large",
              );
              reject(error);
              req.destroy(error);
              return;
            }
            chunks.push(chunk);
          });
          res.on("aborted", () =>
            reject(new ControlError("Local control response was interrupted")),
          );
          res.on("error", reject);
          res.on("end", () => {
            let value: any;
            try {
              value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              reject(new ControlError("Invalid local control response"));
              return;
            }
            if (res.statusCode === 200) resolve(value);
            else
              reject(
                new ControlError(
                  typeof value?.error === "string"
                    ? value.error
                    : "Local control request failed",
                  res.statusCode,
                ),
              );
          });
        },
      );
      req.on("timeout", () =>
        req.destroy(new ControlError("Local control request timed out")),
      );
      req.on("error", reject);
      req.end(payload);
    });
  };
}

export const BACKEND_PROBE = {
  path: "/__loop/backend-probe",
  header: "x-loop-probe",
} as const;

type BodyPolicy = {
  maxBytes: number;
  requireJson?: boolean;
  allowEmpty?: boolean;
};
const HOST_BODY = { maxBytes: 100000, requireJson: true } as const;

export async function readJsonBody(
  req: IncomingMessage,
  policy: BodyPolicy = HOST_BODY,
) {
  if (policy.requireJson && req.headers["content-type"] !== "application/json")
    throw new Error("Expected application/json");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > policy.maxBytes) throw new Error("Request too large");
    chunks.push(buffer);
  }
  if (!bytes && policy.allowEmpty) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function equalSecret(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function jsonReply(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

export function problemReply(
  res: ServerResponse,
  error: unknown,
  fallback: string,
) {
  if (res.headersSent) {
    res.end();
    return;
  }
  // Problem messages are explicitly safe for callers; diagnostics and arbitrary exceptions are not.
  jsonReply(res, error instanceof Problem ? error.status : 400, {
    error: error instanceof Problem ? error.message : fallback,
  });
}

type Reply = [status: number, value: unknown, afterReply?: () => void];
type Operation = (input: any) => Reply | Promise<Reply>;

export function jsonServer(
  operations: (path: string) => Operation | undefined,
  options: {
    token: () => string;
    authMessage: string;
    invalidMessage: string;
    body?: BodyPolicy;
    methodStatus?: 403 | 405;
  },
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (
        req.headers.origin ||
        !equalSecret(
          req.headers.authorization ?? "",
          "Bearer " + options.token(),
        )
      )
        return jsonReply(res, 403, { error: options.authMessage });
      if (req.method !== "POST")
        return options.methodStatus === 405
          ? jsonReply(res, 405, {})
          : jsonReply(res, 403, { error: options.authMessage });
      const operation = operations(req.url ?? "");
      if (!operation)
        return jsonReply(res, 404, { error: "Unknown operation" });
      const [status, value, afterReply] = await operation(
        await readJsonBody(req, options.body),
      );
      jsonReply(res, status, value);
      afterReply?.();
    } catch (error) {
      problemReply(res, error, options.invalidMessage);
    }
  };
}
