import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionLeases } from "../src/connection-leases.js";
import { probeProof } from "../src/connection.js";

type Identity = { generation: number; lease: string };
function fixture() {
  let now = 100;
  const sockets = new Map<string, Identity>();
  const attachments: ({ generation: number; path: string } | undefined)[] = [];
  const logs: string[] = [];
  let probe = async (path: string, nonce: string) => {
    const identity = sockets.get(path)!;
    return probeProof(identity.lease, "instance", identity.generation, nonce);
  };
  const registry = new ConnectionLeases("instance", now, {
    now: () => now,
    timeout: 15000,
    socket: (name) =>
      typeof name === "string" && sockets.has(name) ? name : undefined,
    probe: (path, nonce) => probe(path, nonce),
    setBackend: (backend) => attachments.push(backend),
    log: (message) => logs.push(message),
  });
  return {
    registry,
    attachments,
    logs,
    time: (value: number) => {
      now = value;
    },
    probe: (value: typeof probe) => {
      probe = value;
    },
    lease: () => {
      const identity = registry.lease();
      const socket = `socket-${identity.generation}`;
      sockets.set(socket, identity);
      return { generation: identity.generation, lease: identity.lease, socket };
    },
  };
}

// Moved from the combined socket/stale-generation case. Scenario blocks keep
// its one test case while allowing every decision to use a deterministic clock.
test("only the current verified lease can serve, recover or withdraw", async () => {
  {
    const f = fixture(),
      r = f.registry;
    assert.deepEqual(r.status(), { generation: 0, state: "none", since: 100 });
    const first = f.lease();
    const second = f.lease();
    assert.equal(second.generation, first.generation + 1);
    assert.deepEqual(r.status(), {
      generation: second.generation,
      state: "pending",
      since: 100,
    });
    for (const stale of [
      first,
      { ...second, lease: "wrong" },
      { ...second, lease: "é".repeat(second.lease.length) },
    ]) {
      assert.deepEqual(await r.register(stale), [
        409,
        { error: "Stale or unknown application generation." },
      ]);
      assert.deepEqual(r.heartbeat(stale), [
        409,
        { error: "Stale application generation." },
      ]);
      assert.deepEqual(r.withdraw(stale), [
        409,
        { error: "Stale application generation." },
      ]);
    }
    assert.equal((await r.register({ ...second, socket: "invalid" }))[0], 400);
    assert.deepEqual(r.heartbeat(second), [200, { registered: false }]);
    assert.equal((await r.register(second))[0], 200);
    const attached = f.attachments.length;
    r.unreachable(first.generation);
    assert.equal(f.attachments.length, attached);
    assert.equal(r.status().state, "ready");
    assert.equal(
      (await r.register(second))[0],
      409,
      "an attached lease is not pending or lapsed",
    );
    assert.deepEqual(r.withdraw(second), [200, { withdrawn: true }]);
    assert.equal(f.attachments.at(-1), undefined);
    assert.equal(
      (await r.register(second))[0],
      409,
      "explicit withdrawal is not recoverable",
    );
  }
  {
    const f = fixture(),
      r = f.registry;
    const old = f.lease();
    let complete!: () => void;
    f.probe(
      (_path, nonce) =>
        new Promise<string>((resolve) => {
          complete = () =>
            resolve(probeProof(old.lease, "instance", old.generation, nonce));
        }),
    );
    const registering = r.register(old);
    const next = f.lease();
    complete();
    assert.deepEqual(await registering, [
      409,
      { error: "Application socket failed verification." },
    ]);
    assert.deepEqual(
      f.attachments,
      [],
      "a superseded in-flight probe never attaches",
    );
    assert.equal(r.status().generation, next.generation);
    // A withdrawal during a probe fences the same generation as well.
    let finish!: () => void;
    f.probe(
      (_path, nonce) =>
        new Promise<string>((resolve) => {
          finish = () =>
            resolve(probeProof(next.lease, "instance", next.generation, nonce));
        }),
    );
    const withdrawn = r.register(next);
    assert.equal(r.withdraw(next)[0], 200);
    finish();
    assert.equal((await withdrawn)[0], 409);
    assert.deepEqual(f.attachments, []);
  }
  {
    const f = fixture(),
      r = f.registry;
    const launch = f.lease();
    await r.register(launch);
    f.time(15100);
    r.expire();
    assert.equal(r.status().state, "ready", "exact timeout is still live");
    assert.equal(r.heartbeat(launch)[0], 200);
    f.time(30100);
    r.expire();
    assert.equal(r.status().state, "ready", "heartbeat renewed the deadline");
    f.time(30101);
    r.expire();
    assert.deepEqual(r.status(), {
      generation: launch.generation,
      state: "none",
      since: 30101,
    });
    assert.equal(f.attachments.at(-1), undefined);
    assert.deepEqual(r.heartbeat(launch), [200, { registered: false }]);
    assert.equal(
      (await r.register(launch))[0],
      200,
      "silence leaves the latest launch recoverable",
    );
    r.unreachable(launch.generation);
    f.probe(async () => "invalid");
    assert.equal((await r.register(launch))[0], 409);
    assert.equal(r.status().state, "none");
    f.probe(async () => {
      throw new Error("refused");
    });
    assert.equal((await r.register(launch))[0], 409);
    assert.equal(r.status().state, "none");
    f.probe(async (_path, nonce) =>
      probeProof(launch.lease, "instance", launch.generation, nonce),
    );
    assert.equal(
      (await r.register(launch))[0],
      200,
      "a refused socket can prove itself again",
    );
    r.unreachable(launch.generation);
    const next = f.lease();
    assert.equal(
      (await r.register(launch))[0],
      409,
      "new lease revokes lapsed recovery",
    );
    assert.equal(r.heartbeat(launch)[0], 409);
    assert.equal(r.withdraw(launch)[0], 409);
    assert.equal(r.withdraw(next)[0], 200);
    assert.equal(r.status().state, "none");
    assert.match(f.logs.join("\n"), /stopped sending heartbeats/);
    assert.match(f.logs.join("\n"), /stopped accepting connections/);
  }
  {
    const f = fixture(),
      r = f.registry;
    const launch = f.lease();
    await r.register(launch);
    r.unreachable(launch.generation);
    assert.equal(r.withdraw(launch)[0], 200);
    assert.equal(
      (await r.register(launch))[0],
      409,
      "withdrawing lapsed authority also revokes recovery",
    );
    const pending = f.lease();
    f.time(1000000);
    r.expire();
    assert.equal(r.status().state, "pending", "pending leases do not expire");
    assert.equal(r.heartbeat(pending)[0], 200);
  }
});
