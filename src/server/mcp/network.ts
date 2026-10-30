import { MCP_TOOL_TIMEOUT_MS } from "./timeouts.js";
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
// HTTPS requests and fleet WebSockets use the same connection-time DNS guard.
export const publicNetworkLookup = (
  hostname: string,
  options: any,
  callback: any,
) => {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      return callback(new Error("Private network addresses are not allowed"));
    const selected =
      addresses.find((a) => !options.family || a.family === options.family) ||
      addresses[0];
    if (options.all) callback(null, addresses);
    else callback(null, selected.address, selected.family);
  });
};
export const publicNetworkDispatcher = new Agent({
  connect: { lookup: publicNetworkLookup },
  headersTimeout: 20000,
  bodyTimeout: 30000,
  maxRedirections: 0,
} as any);
const guardedFetch =
  (timeout: number, streaming = false): typeof fetch =>
  async (input, init) => {
    const original =
        typeof input === "string" || input instanceof URL ? input : input.url,
      url = safeUrl(original);
    // Request objects carry cancellation too; an explicit init signal overrides it.
    const callerSignal =
      init?.signal !== undefined
        ? init.signal
        : input instanceof Request
          ? input.signal
          : undefined;
    const signal = streaming
      ? callerSignal
      : AbortSignal.any([
          AbortSignal.timeout(timeout),
          ...(callerSignal ? [callerSignal] : []),
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
      dispatcher: publicNetworkDispatcher,
      headersTimeout: streaming ? 45000 : timeout,
      bodyTimeout: timeout,
      redirect: "error",
      signal,
    } as any);
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
              if (!streaming && total > 4 * 1024 * 1024) {
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
export const safeFetch = guardedFetch(45000);
export const safeToolFetch = guardedFetch(MCP_TOOL_TIMEOUT_MS);
// A runtime response is a potentially long sequence of bounded NDJSON events,
// not one MCP result. Its caller owns cancellation and validates each event.
// Retain an idle-connection timeout without limiting total run duration/bytes.
export const safeRuntimeFetch = guardedFetch(1800000, true);
