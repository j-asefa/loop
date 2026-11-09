import { lookup } from "node:dns/promises";
import { Agent, fetch } from "undici";
import ipaddr from "ipaddr.js";
import { Problem } from "./domain.js";

export class WebhookDestinationRefused extends Problem {
  constructor() {
    super(
      400,
      "Receiver destination is not allowed by this installation's webhook policy",
    );
  }
}
export function webhookPolicy() {
  return {
    installation: "companion" as const,
    local_receivers: true,
  };
}
function webhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookDestinationRefused();
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new WebhookDestinationRefused();
  return url;
}
function webhookAddress(url: URL, address: string) {
  let range: string;
  try {
    const parsed = ipaddr.process(address);
    range = parsed.range();
    // IANA allocates public IPv6 unicast from 2000::/3. A generic "unicast"
    // classification also includes reserved space such as deprecated ::/96.
    if (
      parsed.kind() === "ipv6" &&
      range === "unicast" &&
      !parsed.match(ipaddr.parseCIDR("2000::/3"))
    )
      throw new WebhookDestinationRefused();
  } catch {
    throw new WebhookDestinationRefused();
  }
  const local = ["loopback", "private", "uniqueLocal"].includes(range);
  if ((!local && range !== "unicast") || (!local && url.protocol !== "https:"))
    throw new WebhookDestinationRefused();
  return local;
}
export async function webhookDestination(
  value: string,
  signal = AbortSignal.timeout(10000),
) {
  const url = webhookUrl(value),
    host = url.hostname.replace(/^\[|\]$/g, "");
  signal.throwIfAborted();
  const resolve = ipaddr.isValid(host)
    ? Promise.resolve([
        { address: host, family: ipaddr.parse(host).kind() === "ipv4" ? 4 : 6 },
      ])
    : lookup(host, { all: true, verbatim: true });
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const addresses = await Promise.race([resolve, cancelled]);
    signal.throwIfAborted();
    if (!addresses.length) throw new WebhookDestinationRefused();
    const local = addresses
      .map((entry) => webhookAddress(url, entry.address))
      .some(Boolean);
    return { url, addresses, local };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
/** Fresh resolution and a fresh dispatcher for every attempt. TLS still checks
 * the URL's hostname; the socket lookup can return only the checked addresses. */
export async function postWebhook(
  destination: Awaited<ReturnType<typeof webhookDestination>>,
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) {
  const { url, addresses } = destination;
  const dispatcher = new Agent({
    connect: {
      timeout: 10000,
      lookup: (_hostname, options, callback) => {
        const selected = addresses.filter(
          (entry) => !options.family || entry.family === options.family,
        );
        if (!selected.length) {
          callback(new WebhookDestinationRefused(), [], 0);
          return;
        }
        if (options.all) callback(null, selected);
        else callback(null, selected[0].address, selected[0].family);
      },
    },
    headersTimeout: 10000,
    bodyTimeout: 10000,
  });
  try {
    const response = await fetch(url, {
      method: "POST",
      body,
      headers,
      dispatcher,
      redirect: "manual",
      signal,
    });
    await response.body?.cancel();
    return response.status;
  } finally {
    await dispatcher.destroy();
  }
}
