import { lookup } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import ipaddr from "ipaddr.js";
import { Problem } from "../domain.js";
export function publicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export function safeUrl(value: string | URL) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Problem(400, "Enter a valid HTTPS server URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local") ||
    (ipaddr.isValid(host) && !publicAddress(host))
  )
    throw new Problem(
      400,
      "Only public HTTPS MCP servers are supported. Private/local servers need an isolated bridge.",
    );
  return url;
}
const dispatcher = new Agent({
  connect: {
    lookup: (hostname: string, options: any, callback: any) => {
      lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (error) return callback(error);
        if (
          !addresses.length ||
          addresses.some((a) => !publicAddress(a.address))
        )
          return callback(
            new Error("Private network addresses are not allowed"),
          );
        const selected =
          addresses.find(
            (a) => !options.family || a.family === options.family,
          ) || addresses[0];
        if (options.all) callback(null, addresses);
        else callback(null, selected.address, selected.family);
      });
    },
  },
  headersTimeout: 20000,
  bodyTimeout: 30000,
  maxRedirections: 0,
} as any);
export const safeFetch: typeof fetch = async (input, init) => {
  const original =
      typeof input === "string" || input instanceof URL ? input : input.url,
    url = safeUrl(original);
  const signal = AbortSignal.any([
    AbortSignal.timeout(45000),
    ...(init?.signal ? [init.signal] : []),
  ]);
  const base =
    input instanceof Request
      ? {
          method: input.method,
          headers: input.headers,
          body: input.body,
          duplex: "half",
        }
      : {};
  const response = await undiciFetch(url, {
    ...base,
    ...init,
    dispatcher,
    redirect: "error",
    signal,
  } as any);
  const type = response.headers.get("content-type") || "";
  let total = 0;
  const reader = response.body?.getReader();
  const body = reader
    ? new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              controller.close();
              return;
            }
            total += chunk.value.byteLength;
            if (total > 4 * 1024 * 1024) {
              await reader.cancel();
              controller.error(new Error("MCP response exceeds 4 MB"));
              return;
            }
            controller.enqueue(chunk.value);
          } catch (e) {
            controller.error(e);
          }
        },
        async cancel() {
          await reader.cancel();
        },
      })
    : null;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers as any,
  });
};
