import test from "node:test";
import assert from "node:assert/strict";
import { TunnelSupervisor } from "../src/tunnel.js";
import { until } from "./helpers.js";

test("the tunnel reconnects with capped backoff for as long as the workspace runs", async () => {
  const outcomes = ["a", "fail", "fail", "fail", "b", "c"];
  const opened: (() => void)[] = [];
  const changes: [string, boolean][] = [];
  const logs: string[] = [];
  const waits: number[] = [];
  const supervisor = new TunnelSupervisor(
    (exited) => {
      const outcome = outcomes.shift()!;
      opened.push(exited);
      return {
        start: async () => {
          if (outcome === "fail") throw new Error("Quick Tunnel exited early.");
          return `https://${outcome}.trycloudflare.com`;
        },
        stop: async () => {},
      };
    },
    (origin, reconnected) => changes.push([origin, reconnected]),
    {
      log: (message) => logs.push(message),
      initialDelay: 50,
      maxDelay: 150,
      // Record each backoff instead of waiting it out.
      schedule: (ms, run) => {
        waits.push(ms);
        setImmediate(run);
      },
    },
  );
  assert.equal(await supervisor.start(), "https://a.trycloudflare.com");
  assert.deepEqual(changes, [["https://a.trycloudflare.com", false]]);

  opened[0]();
  await until(() => changes.length === 2);
  assert.deepEqual(changes[1], ["https://b.trycloudflare.com", true]);
  assert.deepEqual(waits, [50, 100, 150, 150], "doubles, then caps");
  assert.equal(
    logs.filter((m) => m === "Quick Tunnel exited early.").length,
    3,
  );

  opened[4]();
  await until(() => changes.length === 3);
  assert.equal(waits.at(-1), 50, "backoff resets after a success");

  await supervisor.stop();
  opened[5]();
  await new Promise((r) => setImmediate(r));
  assert.equal(opened.length, 6, "no reconnect after stop");
  assert.equal(waits.length, 5);
});
