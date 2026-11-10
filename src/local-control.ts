import { request } from "node:http";

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
