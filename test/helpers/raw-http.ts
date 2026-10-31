import { get, type IncomingHttpHeaders } from "node:http";

// fetch automatically decompresses; transfer regressions need the wire bytes.
export function rawGet(url: string, headers: Record<string, string> = {}) {
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
  }>((resolve, reject) => {
    const request = get(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () =>
        resolve({
          status: response.statusCode!,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.setTimeout(10000, () => request.destroy(new Error("HTTP timeout")));
    request.on("error", reject);
  });
}
