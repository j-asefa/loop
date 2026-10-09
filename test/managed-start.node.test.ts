import test from "node:test";
import assert from "node:assert/strict";
import { runtimeSetupState } from "../src/runtime-setup.js";
import { prepareManagedRuntime } from "../src/managed-start.js";

test("runner failure cleans up without offering direct execution", async () => {
  const events: string[] = [];
  const result = await prepareManagedRuntime(
    {
      async prepare() {
        assert.equal(runtimeSetupState(), "preparing");
        events.push("prepare");
      },
      async start() {
        assert.equal(runtimeSetupState(), "starting");
        events.push("start");
        throw new Error("secret");
      },
      async close() {
        events.push("close");
      },
    },
    () => false,
    (message) => events.push(message),
  );
  assert.equal(result, undefined);
  assert.equal(runtimeSetupState(), "failed");
  assert.deepEqual(events.slice(1, 4), ["prepare", "start", "close"]);
  assert.match(events[4], /runner startup failed/);
  assert(!events.join(" ").includes("secret"));
});

test("cleanup failure prevents claiming a safe fallback", async () => {
  await assert.rejects(
    prepareManagedRuntime(
      {
        async prepare() {
          throw new Error("prepare");
        },
        async start() {},
        async close() {
          throw new Error("cleanup");
        },
      },
      () => false,
      () => {},
    ),
    /cleanup/,
  );
  assert.equal(runtimeSetupState(), "failed");
});

test("shutdown during preparation prevents runner startup", async () => {
  let stopping = false;
  const result = await prepareManagedRuntime(
    {
      async prepare() {
        stopping = true;
      },
      async start() {
        assert.fail("runner must not start");
      },
      async close() {},
    },
    () => stopping,
    () => {},
  );
  assert.equal(result, undefined);
  assert.equal(runtimeSetupState(), "stopped");
});

test("startup status reports ready only after a runner returns an account", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const account = { id: "fixture" };
  const pending = prepareManagedRuntime(
    {
      async prepare() {},
      async start() {
        await waiting;
        return account;
      },
      async close() {},
    },
    () => false,
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeSetupState(), "starting");
  release();
  assert.equal(await pending, account);
  assert.equal(runtimeSetupState(), "ready");
  await prepareManagedRuntime(
    { async prepare() {}, async start() {}, async close() {} },
    () => false,
    () => {},
  );
  assert.equal(runtimeSetupState(), "failed");
});

test("missing runner account cleans up before reporting failure", async () => {
  const events: string[] = [];
  const result = await prepareManagedRuntime(
    {
      async prepare() {},
      async start() {
        events.push("start");
      },
      async close() {
        assert.equal(runtimeSetupState(), "failed");
        events.push("close");
      },
    },
    () => false,
    (message) => {
      if (message.includes("failed")) events.push("notice");
    },
  );
  assert.equal(result, undefined);
  assert.equal(runtimeSetupState(), "failed");
  assert.deepEqual(events, ["start", "close", "notice"]);
});

test("missing account with failed cleanup cannot advertise fallback", async () => {
  await assert.rejects(
    prepareManagedRuntime(
      {
        async prepare() {},
        async start() {},
        async close() {
          throw new Error("cleanup refused");
        },
      },
      () => false,
      () => {},
    ),
    /cleanup refused/,
  );
  assert.equal(runtimeSetupState(), "failed");
});
