// A paired mobile browser across `loop restart`, through the shipped CLI, the
// connection service and a local TLS edge standing in for Cloudflare. The
// tunnel helper is the deterministic fixture; this is not live-network evidence.
import { chromium, webkit, expect } from "@playwright/test";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";
import { testEnvironment } from "./test-runner.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer as createNet, connect } from "node:net";
import { createServer as createTls } from "node:tls";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const base = await mkdtemp(join(tmpdir(), "loop-reconnect-browser-"));
// Rebuild a disposable installation without replacing the developer's dist or
// inheriting the checkout's Git identity. Both builds use the shipped CLI.
const installation = join(base, "installation");
for (const file of [
  "dist", "src", "native", "runtime", "migrations", "deployment", "scripts",
  "public", "index.html", "package.json", "package-lock.json", "tsconfig.json",
  "vite.config.ts",
])
  await cp(resolve(file), join(installation, file), {
    recursive: true,
    filter: (path) => !path.split(sep).includes("node_modules"),
  });
await symlink(resolve("node_modules"), join(installation, "node_modules"), "dir");
const project = join(base, "project");
await mkdir(project);
await exec("git", ["init", "-q", project]);
await exec("git", [
  "-C", project, "-c", "user.name=Loop fixture", "-c", "user.email=fixture@example.test",
  "commit", "--allow-empty", "-qm", "Initial fixture",
]);
const fixture = join(base, "codex");
await copyFile("test/harness.mjs", fixture);
await chmod(fixture, 0o755);
await chmod("test/fixtures/fake-cloudflared.mjs", 0o755);
const env = {
  ...testEnvironment(process.env, "native"),
  LOOP_HOME: join(base, "state"),
  LOOP_TEST_HARNESS: "codex",
  LOOP_TEST_CLOUDFLARED: resolve("test/fixtures/fake-cloudflared.mjs"),
};
const loop = (...args) =>
  exec(process.execPath, ["dist/cli.js", ...args], { cwd: installation, env, timeout: 120000 });
const status = async () => JSON.parse((await loop("status", "--json")).stdout);
// Self-signed certificate for the fixture's trycloudflare.com host.
await exec("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-subj", "/CN=*.trycloudflare.com",
  "-addext", "subjectAltName=DNS:*.trycloudflare.com",
  "-keyout", join(base, "key.pem"), "-out", join(base, "cert.pem"),
]);
let relayPort = 0;
// TLS terminates here and plaintext continues to the relay, as with cloudflared.
const edge = createTls(
  { key: await readFile(join(base, "key.pem")), cert: await readFile(join(base, "cert.pem")) },
  (socket) => {
    const upstream = connect(relayPort, "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  },
);
await new Promise((r) => edge.listen(0, "127.0.0.1", r));
// The browser's HTTP proxy sends every trycloudflare.com CONNECT to the edge.
const proxy = createNet((client) => {
  client.once("data", (head) => {
    const line = head.toString().split("\r\n")[0];
    if (!/^CONNECT [a-z0-9-]+\.trycloudflare\.com:443 /.test(line)) return client.destroy();
    const upstream = connect(edge.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
let browser;
try {
  const started = await loop("codex", "--executable", fixture, "--project", project, "--billing", "existing");
  const pairUrl = started.stdout.match(/https:\/\/[\w-]+\.trycloudflare\.com\/#pair=[\w-]+/)[0];
  const before = await status();
  relayPort = Number(new URL(before.connection.service.relay).port);
  const engine = process.env.LOOP_BROWSER === "webkit" ? webkit : chromium;
  browser = await engine.launch({
    headless: true,
    proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
    ...(engine === chromium ? { args: ["--no-sandbox"] } : {}),
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    isMobile: engine === chromium,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    // The fixture deliberately restarts the server and reloads the document.
    // WebKit reports interrupted same-origin API reads as access-control errors;
    // retain all other diagnostics, just as the other browser journeys do.
    if (!isWebKitNavigationFetchError(engine.name(), error, new URL(pairUrl).origin))
      errors.push(error.message);
  });
  await page.goto(pairUrl);
  await page.getByRole("button", { name: "Pair and open Loop" }).click();
  const authenticated = (path) =>
    page.evaluate(async (p) => (await fetch(p, { cache: "no-store" })).status, path);
  await expect.poll(() => authenticated("/api/bootstrap")).toBe(200);
  // A thread with history, then an unsent reply and a scrolled position.
  const csrf = await page.evaluate(async () => (await (await fetch("/session")).json()).csrf);
  const post = (path, body) =>
    page.evaluate(
      async ([p, b, token]) =>
        (await fetch(p, { method: "POST", headers: { "content-type": "application/json", "x-loop-csrf": token }, body: JSON.stringify(b) })).json(),
      [path, body, csrf],
    );
  const agent = await post("/api/agents", { name: "reconnect-agent", connectionId: "native-codex", model: "native-default" });
  const run = await post("/api/runs", { agentId: agent.id, input: "hello from the phone", idempotencyKey: crypto.randomUUID() });
  await page.goto(new URL("/?conversation=" + run.conversation_id, pairUrl).href);
  const reply = page.getByLabel("Reply to agent");
  await expect(reply).toBeVisible({ timeout: 30000 });
  try {
    await expect(page.getByText("Fixture done").first()).toBeVisible({ timeout: 30000 });
  } catch (cause) {
    const failure = await page.evaluate(async (runId) => {
      const run = (await (await fetch("/api/runs")).json()).find((item) => item.id === runId);
      return { state: run?.state, error: run?.error };
    }, run.id);
    throw new Error(`Fixture run did not finish: ${JSON.stringify(failure)}`, { cause });
  }
  await reply.fill("draft typed before the restart");
  await expect(page.getByText(/Connected to workspace/)).toBeVisible({ timeout: 30000 });
  const devices = await page.evaluate(async () => (await (await fetch("/api/workspace/devices")).json()).length);
  const location = page.url();

  // Restart the application under the open page.
  const restart = loop("restart");
  // The thread is a modal sheet: the notice must show inside it, not behind it.
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText(/Loop is reconnecting/)).toBeVisible({ timeout: 30000 });
  const restarted = await restart;
  assert.match(restarted.stdout, /Same address/);
  await expect(page.getByText(/Connected to workspace/)).toBeVisible({ timeout: 30000 });
  const after = await status();
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.url, before.url);
  assert.equal(after.connection.service.tunnel.pid, before.connection.service.tunnel.pid);
  // The same page, thread and draft; no pairing screen, no reload.
  assert.equal(page.url(), location);
  await expect(reply).toHaveValue("draft typed before the restart");
  await expect(page.getByRole("button", { name: "Pair and open Loop" })).toHaveCount(0);
  await expect(page.getByText("Fixture done").first()).toBeVisible();
  assert.equal(await authenticated("/api/bootstrap"), 200);
  assert.equal(
    await page.evaluate(async () => (await (await fetch("/api/workspace/devices")).json()).length),
    devices,
  );
  // A checkout rebuilt while Loop runs (git pull && bash install), then
  // `loop restart`: the open page offers the new assets but never reloads itself.
  const indexPath = join(installation, "dist/web/index.html");
  const original = await readFile(indexPath, "utf8");
  const servingBuild = () => page.evaluate(async () =>
    (await (await fetch("/api/build", { cache: "no-store" })).json()).serving.id,
  );
  const originalBuild = await servingBuild();
  await exec(process.execPath, ["scripts/build.mjs"], {
    cwd: installation, env, timeout: 120000, maxBuffer: 2 * 1024 * 1024,
  });
  const replacement = await readFile(indexPath, "utf8");
  assert.notEqual(replacement, original);
  await loop("restart");
  assert.notEqual(await servingBuild(), originalBuild);
  const update = sheet.getByRole("button", { name: "Reload to update" });
  await expect(update).toBeVisible({ timeout: 30000 });
  await expect(reply).toHaveValue("draft typed before the restart");
  await Promise.all([page.waitForEvent("load"), update.click()]);
  await expect(page.getByLabel("Reply to agent")).toHaveValue("draft typed before the restart", { timeout: 30000 });
  await expect(page.getByText(/Connected to workspace/)).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("button", { name: "Reload to update" })).toHaveCount(0);
  assert.equal(
    await page.evaluate(async () => (await fetch("/", { cache: "no-store" })).text()),
    replacement,
  );
  const rebuilt = await status();
  assert.equal(rebuilt.url, before.url);
  assert.equal(rebuilt.connection.service.tunnel.pid, before.connection.service.tunnel.pid);

  // Finish checking the paired-page journey before the separate hard-down case.
  // WebKit can report rejected in-flight requests as page errors when its server
  // is deliberately killed; those are not failures of the completed restart.
  assert.deepEqual(errors, []);
  await page.close();
  // A page opened while the application is down gets the generic reconnect page.
  process.kill(rebuilt.pid, "SIGKILL");
  const fresh = await context.newPage();
  fresh.on("pageerror", (e) => errors.push(e.message));
  const down = await fresh.goto(new URL("/", pairUrl).href);
  assert.equal(down.status(), 503);
  await expect(fresh.getByRole("heading", { name: "Loop is reconnecting…" })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    `PASS (${process.env.LOOP_BROWSER || "chromium"}): paired page kept its thread, draft and session across loop restart; a rebuilt checkout offered Reload to update and kept the draft; same address and tunnel process; reconnect page while down. Fixture tunnel and local TLS edge.`,
  );
} finally {
  await browser?.close();
  await loop("stop").catch(() => {});
  edge.close();
  proxy.close();
  await rm(base, { recursive: true, force: true });
}
