// A virtual public network for server-profile HTTP contract fixtures. The real
// policy and pinned lookup run; only the final transport is mapped to the local
// recording receiver. Companion fixtures use real loopback connections instead.
import { mock } from "node:test";
import * as dns from "node:dns/promises";
import * as undici from "undici";
import assert from "node:assert/strict";

const host = "webhook.fixture.test";
let addresses = ["93.184.215.14"];
let remainingLookups = Infinity;
process.on("message", (message) => {
  if (message?.type !== "webhook-network") return;
  addresses = message.addresses;
  remainingLookups = message.holdLookupAfter ?? Infinity;
  process.send?.({ network: true });
});
mock.module("node:dns/promises", {
  namedExports: {
    ...dns,
    lookup: async (name, options) => {
      if (name !== host) return dns.lookup(name, options);
      if (remainingLookups-- <= 0) return new Promise(() => {});
      return addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }));
    },
  },
});
class ReceiverAgent extends undici.Agent {
  constructor(options) {
    super(options);
    this.fixtureLookup = options?.connect?.lookup;
  }
}
const fixtureFetch = async (input, init) => {
  const url = new URL(input);
  if (url.hostname !== host) return undici.fetch(input, init);
  assert.equal(init.redirect, "manual");
  const pinned = await new Promise((resolve, reject) =>
    init.dispatcher.fixtureLookup(host, { all: true }, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
  assert.deepEqual(
    pinned,
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    })),
  );
  const target = new URL(
    url.pathname + url.search,
    process.env.LOOP55_TEST_WEBHOOK_RECEIVER,
  );
  return undici.fetch(target, { ...init, dispatcher: undefined });
};
mock.module("undici", {
  namedExports: {
    ...Object.fromEntries(
      Object.entries(undici).filter(([key]) => key !== "default"),
    ),
    Agent: ReceiverAgent,
    fetch: fixtureFetch,
  },
  defaultExport: {
    ...undici.default,
    Agent: ReceiverAgent,
    fetch: fixtureFetch,
  },
});
