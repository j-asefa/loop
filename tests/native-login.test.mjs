import { it as test, afterEach } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { nativeLogins } from "../native/login.mjs";

const active = [];
afterEach(() => {
  for (const login of active.splice(0)) login.dispose();
});
function fixture(lifetime) {
  const children = [];
  const login = nativeLogins({
    lifetime,
    binary: (flavor) => flavor,
    env: () => ({}),
    spawn: (binary, args, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.input = [];
      child.stdin = { write: (text) => child.input.push(text) };
      child.kill = () => {
        child.killed = true;
      };
      children.push({ child, binary, args, options });
      return child;
    },
  });
  active.push(login);
  return { login, children };
}

test("lost start response and page reload recover the same provider attempt", () => {
  const { login, children } = fixture();
  const first = login.start("codex");
  children[0].child.stdout.emit(
    "data",
    "Open https://auth.openai.com/codex/device AB12-CD34",
  );
  const retry = login.start("codex");
  assert.equal(retry.id, first.id);
  assert.equal(retry.state, "waiting");
  assert.equal(children.length, 1);
  assert.deepEqual(login.status("codex"), retry);
  assert.deepEqual(login.status("claude"), { state: "idle" });
  assert.deepEqual(children[0].args, ["login", "--device-auth"]);
});

test("provider attempts and submitted codes cannot cross identities", () => {
  const { login, children } = fixture();
  const codex = login.start("codex"),
    claude = login.start("claude");
  children[1].child.stderr.emit(
    "data",
    "Open https://claude.ai/oauth/authorize and paste the code",
  );
  assert.throws(() => login.code("claude", codex.id, "not-for-this-provider"));
  assert.throws(() => login.cancel("codex", claude.id));
  assert.throws(() => login.code("claude", claude.id, "first\nsecond"));
  login.code("claude", claude.id, "synthetic-code");
  assert.deepEqual(children[1].child.input, ["synthetic-code\n"]);
  assert.deepEqual(children[0].child.input, []);
  children[1].child.emit("exit", 0);
  assert.equal(login.status("claude").state, "complete");
  assert.equal(login.status("claude").login, undefined);
  assert.equal(login.status("codex").state, "starting");
});

test("late output and errors from a cancelled process cannot replace a new attempt", () => {
  const { login, children } = fixture();
  const first = login.start("codex");
  login.cancel("codex", first.id);
  const second = login.start("codex");
  children[0].child.stdout.emit(
    "data",
    "https://auth.openai.com/stale AB12-CD34",
  );
  children[0].child.emit("error", new Error("late process error"));
  children[0].child.emit("exit", 1);
  assert.deepEqual(login.status("codex"), second);
  assert.equal(children[0].child.killed, true);
  assert.throws(() => login.cancel("codex", first.id));
});

test("expired attempts erase exchange details and reject code submission", async () => {
  const { login, children } = fixture(15);
  const first = login.start("claude");
  children[0].child.stdout.emit(
    "data",
    "https://claude.ai/oauth/authorize enter the code",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(login.status("claude").state, "expired");
  assert.equal(login.status("claude").login, undefined);
  assert.equal(children[0].child.killed, true);
  assert.throws(() => login.code("claude", first.id, "expired-code"));
  children[0].child.emit("exit", 1);
  assert.equal(login.status("claude").state, "expired");
});
