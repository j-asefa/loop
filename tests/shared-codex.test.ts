import { afterEach, expect, it } from "vitest";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture({ managed = false, fastIdle = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loop-shared-codex-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  cpSync(resolve("runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(resolve("tests/helpers/shared-codex-fixture.mjs"), join(bin, "codex"));
  // cp preserves the executable mode of the checked-in fixture.
  writeFileSync(
    join(dir, "clock.mjs"),
    `
import { Server } from 'node:http';
const listen = Server.prototype.listen;
Server.prototype.listen = function () { this.once('listening', () => process.send({ port: this.address().port })); return listen.call(this, 0, '127.0.0.1'); };
${fastIdle ? "const timeout = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 3600000 ? 800 : ms, ...args);" : ""}
`,
  );
  // Managed transport fixture uses the real worker/session but substitutes only
  // Docker launch so CI can exercise isolated HOME/config without a daemon.
  if (managed)
    writeFileSync(
      join(bin, "docker"),
      `#!/usr/bin/env node
const {spawn}=require('node:child_process');
if(process.argv[2]!=='run')process.exit(0);
const p=spawn(process.execPath,[${JSON.stringify(join(dir, "runtime/codex-worker.mjs"))}],{env:{PATH:process.env.PATH,HOME:${JSON.stringify(dir)}},stdio:'inherit'});
process.on('SIGTERM',()=>p.kill('SIGTERM'));p.on('exit',code=>process.exit(code||0));
`,
      { mode: 0o755 },
    );
  const token = "shared-codex-fixture-token-at-least-32-characters";
  const broker = spawn(
    process.execPath,
    ["--import", join(dir, "clock.mjs"), join(dir, "runtime/broker.mjs")],
    {
      env: {
        ...process.env,
        PATH: bin + ":" + process.env.PATH,
        HOME: dir,
        LOOP_RUNTIME_MODE: managed ? "container" : "host",
        LOOP_RUNTIME_WORKDIR: dir,
        LOOP_RUNTIME_TOKEN: token,
        LOOP_RUNTIME_TOKEN_FILE: "",
        OPENAI_API_KEY: "must-not-inherit",
        CODEX_API_KEY: "must-not-inherit-either",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const [{ port }] = await once(broker, "message");
  const controllers: AbortController[] = [];
  cleanups.push(async () => {
    for (const controller of controllers) controller.abort();
    const closed = once(broker, "close");
    broker.kill("SIGTERM");
    await closed;
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (data: object, signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${port}/runtime`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ key: "a".repeat(64), provider: "codex", ...data }),
      signal,
    });
  const calls = () => {
    try {
      return readFileSync(join(dir, "calls"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const run = async (controlId: string, model = "hold", extra: object = {}) => {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await post(
      {
        action: "turn",
        input: {
          controlId,
          model,
          messages: [{ role: "user", content: controlId }],
          workspaceKey: "a".repeat(64),
        },
        ...extra,
      },
      controller.signal,
    );
    const stream = {
      response,
      output: "",
      controller,
      done: Promise.resolve(),
    };
    stream.done = (async () => {
      for await (const bytes of response.body!)
        stream.output += Buffer.from(bytes).toString();
    })().catch((error) => {
      if (!controller.signal.aborted) throw error;
    });
    return stream;
  };
  return { dir, post, calls, run };
}

it("runs three threads in one process, isolates events and approvals, and interrupts only the disconnected run", async () => {
  const { post, calls, run } = await fixture();
  const a = await run("archer");
  const b = await run("plum");
  const c = await run("elder");
  await expect
    .poll(() =>
      [a, b, c].every((s) => s.output.includes('"steeringReady":true')),
    )
    .toBe(true);
  expect(calls().filter((c) => c.launch)).toHaveLength(1);
  expect(calls().filter((c) => c.rpc?.method === "initialize")).toHaveLength(1);
  const ids = calls()
    .filter((c) => c.rpc?.method === "turn/start")
    .map((c) => c.rpc.params.threadId);
  expect(new Set(ids).size).toBe(3);
  for (const [i, stream] of [a, b, c].entries()) {
    expect(stream.output).toContain("update for " + ids[i]);
    for (const id of ids.filter((id) => id !== ids[i]))
      expect(stream.output).not.toContain("update for " + id);
    expect(stream.output).not.toContain("foreign output");
    expect(stream.output).not.toContain("stale output");
    await expect.poll(() => stream.output.includes('"activity":')).toBe(true);
    const activities = stream.output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).chunk?.activity)
      .filter(Boolean);
    expect(activities).toHaveLength(1);
    expect(activities[0].params.item.id).toBe("command-" + ids[i]);
    expect(stream.output).not.toContain("foreign command");
    expect(stream.output).not.toContain("stale command");
  }
  await expect
    .poll(
      () => calls().filter((c) => c.rpc?.id?.startsWith?.("approval-")).length,
    )
    .toBe(3);
  expect(
    calls()
      .filter((c) => c.rpc?.id?.startsWith?.("approval-"))
      .every((c) => c.rpc.result?.decision === "accept"),
  ).toBe(true);
  expect(
    calls()
      .filter((c) => c.rpc?.id?.startsWith?.("foreign-approval-"))
      .every((c) => c.rpc.error?.code === -32602),
  ).toBe(true);
  const steer = {
    action: "steer",
    controlId: "plum",
    id: "followup",
    text: "Plum finished",
  };
  expect((await post({ ...steer, key: "b".repeat(64) })).status).toBe(409);
  expect((await post({ ...steer, controlId: "unknown" })).status).toBe(409);
  expect(await (await post(steer)).json()).toEqual({ accepted: true });
  expect(await (await post(steer)).json()).toEqual({ accepted: true });
  expect((await post({ ...steer, text: "conflicting retry" })).ok).toBe(false);
  await b.done;
  expect(b.output).toContain('"text":"Plum finished"');
  expect(a.output).not.toContain('"done":true');
  a.controller.abort();
  await a.done;
  await expect
    .poll(() =>
      calls()
        .filter((c) => c.rpc?.method === "turn/interrupt")
        .map((c) => c.rpc.params.threadId),
    )
    .toEqual([ids[0]]);
  const next = await run("next", "quick");
  await next.done;
  expect(next.output).toContain('"done":true');
  expect(calls().filter((c) => c.launch)).toHaveLength(1);
  expect(c.output).not.toContain('"error"');
  expect(c.output).not.toContain('"done":true');
  await post({ action: "cancel" }); // Sign-in cancellation does not stop work.
  expect(
    await (
      await post({
        action: "steer",
        controlId: "elder",
        id: "done",
        text: "Elder finished",
      })
    ).json(),
  ).toEqual({ accepted: true });
  await c.done;
  expect(c.output).toContain('"text":"Elder finished"');
}, 15000);

it("isolates managed workspaces and per-thread credentials without putting them in the process environment or output", async () => {
  const { run, calls } = await fixture({ managed: true });
  const a = await run("a", "credential", { githubToken: "fixture-secret-a" });
  const b = await run("b", "credential", {
    input: { model: "credential", messages: [], workspaceKey: "b".repeat(64) },
  });
  await Promise.all([a.done, b.done]);
  expect(a.output).toContain("[redacted]");
  expect(a.output).not.toContain("fixture-secret-a");
  expect(b.output).toContain("credential none");
  const launch = calls().find((c) => c.launch);
  expect(launch).toMatchObject({ apiKey: null, githubToken: null });
  const threads = calls()
    .filter((c) => c.rpc?.method === "thread/start")
    .map((c) => c.rpc.params);
  expect(threads[0].cwd).not.toBe(threads[1].cwd);
  expect(threads[0].config["shell_environment_policy.set"].GH_TOKEN).toBe(
    "fixture-secret-a",
  );
  expect(threads[1].config["shell_environment_policy.set"]).toEqual({});
  expect(
    calls()
      .filter((c) => c.rpc?.method === "turn/start")
      .every((c) => !JSON.stringify(c).includes("fixture-secret-a")),
  ).toBe(true);
  expect(calls().filter((c) => c.launch)).toHaveLength(1);
});

it("rejects API authentication, recovers after process death without replaying lost turns, and allows new work", async () => {
  const { dir, calls, run } = await fixture();
  writeFileSync(join(dir, "account-type"), "apiKey");
  const denied = await run("denied", "quick");
  await denied.done;
  expect(denied.output).toContain("Subscription sign-in required");
  expect(calls().some((c) => c.rpc?.method === "turn/start")).toBe(false);
  writeFileSync(join(dir, "account-type"), "chatgpt");
  const held = await run("held");
  await expect.poll(() => held.output).toContain('"steeringReady":true');
  const crash = await run("crash", "crash");
  await Promise.all([held.done, crash.done]);
  for (const stream of [held, crash]) {
    const events = stream.output.trim().split("\n").map((line) => JSON.parse(line));
    // The child failure or the worker close can arrive first; both must report
    // a process failure instead of completing the interrupted turn.
    expect(events).toContainEqual(expect.objectContaining({
      code: "runtime_failure",
      diagnostic: expect.objectContaining({ phase: "process" }),
      error: expect.any(String),
    }));
    expect(events.some((event) => event.done)).toBe(false);
  }
  const recovered = await run("recovered", "quick");
  await recovered.done;
  expect(recovered.output).toContain('"done":true');
  expect(calls().filter((c) => c.launch)).toHaveLength(2);
  expect(calls().filter((c) => c.rpc?.method === "turn/start")).toHaveLength(3);
});

it("admits 32 concurrent turns, releases capacity and reuses the process for status/commands", async () => {
  const { run, post, calls } = await fixture();
  const held = await Promise.all(
    Array.from({ length: 32 }, (_, i) => run("run-" + i)),
  );
  await expect
    .poll(() => held.every((s) => s.output.includes('"steeringReady":true')))
    .toBe(true);
  const overflow = await run("overflow");
  expect(overflow.response.status).toBe(409);
  await overflow.done;
  expect(calls().filter((c) => c.rpc?.method === "turn/start")).toHaveLength(32);
  held[0].controller.abort();
  await expect
    .poll(
      () =>
        calls().filter((c) => c.rpc?.method === "thread/unsubscribe").length,
    )
    .toBe(1);
  const replacement = await run("replacement", "quick");
  expect(replacement.response.status).toBe(200);
  await replacement.done;
  expect(replacement.output).toContain('"done":true');
  expect(calls().filter((c) => c.rpc?.method === "turn/start")).toHaveLength(33);
  expect(await (await post({ action: "status" })).json()).toMatchObject({
    authenticated: true,
    authMode: "subscription",
  });
  expect(await (await post({ action: "capabilities" })).json()).toMatchObject({
    available: true,
  });
  expect(calls().filter((c) => c.launch)).toHaveLength(1);
}, 15000);

it("an idle timeout interrupts one thread while a sibling completes", async () => {
  const { run, post, calls } = await fixture({ fastIdle: true });
  const stalled = await run("stalled", "stall");
  const sibling = await run("sibling");
  await expect.poll(() => sibling.output).toContain('"steeringReady":true');
  await post({
    action: "steer",
    controlId: "sibling",
    id: "done",
    text: "Sibling finished",
  });
  await Promise.all([stalled.done, sibling.done]);
  expect(sibling.output).toContain('"done":true');
  expect(stalled.output).toContain('"code":"idle_timeout"');
  expect(
    calls().filter((c) => c.rpc?.method === "turn/interrupt"),
  ).toHaveLength(1);
  const next = await run("next", "quick");
  await next.done;
  expect(next.output).toContain('"done":true');
  expect(calls().filter((c) => c.launch)).toHaveLength(1);
});

it("a disconnect during thread creation never starts a model turn", async () => {
  const { run, calls } = await fixture();
  const starting = await run("starting", "starting");
  await expect
    .poll(() => calls().some((c) => c.rpc?.method === "thread/start"))
    .toBe(true);
  starting.controller.abort();
  await starting.done;
  await expect
    .poll(() => calls().some((c) => c.rpc?.method === "thread/unsubscribe"))
    .toBe(true);
  expect(calls().some((c) => c.rpc?.method === "turn/start")).toBe(false);
});

it("keeps managed sign-in exclusive, supports cancellation/retry, and retires the worker on logout", async () => {
  const { dir, post, calls, run } = await fixture({ managed: true });
  expect(await (await post({ action: "login" })).json()).toMatchObject({
    state: "starting",
  });
  await expect
    .poll(async () => (await (await post({ action: "status" })).json()).state)
    .toBe("waiting");
  const blocked = await run("blocked", "quick");
  await blocked.done;
  expect(blocked.response.status).toBe(409);
  expect(calls().some((c) => c.rpc?.method === "turn/start")).toBe(false);
  await post({ action: "cancel" });
  await expect
    .poll(() => calls().some((c) => c.rpc?.method === "account/login/cancel"))
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await (await post({ action: "status" })).json()).authenticated,
    )
    .toBe(true);
  writeFileSync(join(dir, "complete-login"), "yes");
  await post({ action: "login" });
  await expect
    .poll(
      async () =>
        (await (await post({ action: "status" })).json()).authenticated,
    )
    .toBe(true);
  expect(calls().filter((c) => c.launch)).toHaveLength(1);
  const active = await run("active");
  await expect.poll(() => active.output).toContain('"steeringReady":true');
  expect((await post({ action: "login" })).status).toBe(409);
  expect(await (await post({ action: "logout" })).json()).toEqual({ ok: true });
  await active.done;
  expect(active.output).toContain('"error"');
  expect(
    calls().filter((c) => c.rpc?.method === "account/logout"),
  ).toHaveLength(1);
  const denied = await run("after-logout", "quick");
  await denied.done;
  expect(denied.output).toContain("Subscription sign-in required");
}, 15000);

it("retires a process that fails initialization and preserves native host sign-in when unpairing", async () => {
  const { dir, run, post, calls } = await fixture();
  writeFileSync(join(dir, "fail-start"), "yes");
  const failed = await run("failed", "quick");
  await failed.done;
  expect(failed.output).toContain('"error"');
  rmSync(join(dir, "fail-start"));
  const recovered = await run("recovered", "quick");
  await recovered.done;
  expect(recovered.output).toContain('"done":true');
  expect(calls().filter((c) => c.launch)).toHaveLength(2);
  await post({ action: "logout" });
  expect(calls().some((c) => c.rpc?.method === "account/logout")).toBe(false);
  const after = await run("after-unpair", "quick");
  await after.done;
  expect(after.output).toContain('"done":true');
  expect(calls().filter((c) => c.launch)).toHaveLength(3);
});
