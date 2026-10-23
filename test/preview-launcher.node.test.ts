import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { request } from "node:http";
import {
  chmod,
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import Database from "better-sqlite3";
import { gitProject } from "./git-project.js";

const exec = promisify(execFile);
const root = resolve(".");
const cli = join(root, "dist", "cli.js");
const fake = join(root, "test", "fixtures", "fake-cloudflared.mjs");

function browser(
  relay: string,
  origin: string,
  cookies = new Map<string, string>(),
) {
  let csrf = "";
  const send = (method: string, path: string, data?: unknown) =>
    new Promise<{ status: number; data: any }>((yes, no) => {
      const destination = new URL(relay);
      const req = request(
        {
          hostname: destination.hostname,
          port: destination.port,
          path,
          method,
          headers: {
            host: new URL(origin).host,
            origin,
            ...(cookies.size
              ? { cookie: [...cookies.values()].join("; ") }
              : {}),
            ...(csrf ? { "x-loop-csrf": csrf } : {}),
            ...(data ? { "content-type": "application/json" } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => {
            for (const header of res.headers["set-cookie"] || []) {
              const cookie = header.split(";")[0];
              cookies.set(cookie.slice(0, cookie.indexOf("=")), cookie);
            }
            let data: any;
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
            yes({ status: res.statusCode!, data });
          });
        },
      );
      req.on("error", no);
      req.end(data ? JSON.stringify(data) : undefined);
    });
  return {
    send,
    async pair(code: string) {
      assert.equal(
        (await send("POST", "/pair", { secret: code, name: "Preview phone" }))
          .status,
        200,
      );
      csrf = (await send("GET", "/session")).data.csrf;
    },
  };
}

async function fixture() {
  assert(
    existsSync(cli),
    "Run npm run build before the preview launcher contract tests",
  );
  await mkdir(".tmp", { recursive: true });
  const base = await mkdtemp(join(root, ".tmp", "preview-contract-"));
  const source = join(base, "source"),
    registry = join(base, "previews"),
    live = join(base, "everyday");
  await mkdir(source);
  await mkdir(live);
  await writeFile(join(live, "sentinel"), "everyday Loop is untouched");
  const git = gitProject(source);
  await mkdir(join(source, "src"));
  await cp(
    join(root, "src", "preview-context.ts"),
    join(source, "src", "preview-context.ts"),
  );
  for (const path of ["migrations", "runtime", "native"])
    await cp(join(root, path), join(source, path), { recursive: true });
  await writeFile(
    join(source, ".gitignore"),
    "node_modules\ndist\n.tmp\n.fail-build\n.hold-build\n.building\n",
  );
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "loop",
      version: "0.1.0",
      type: "module",
      scripts: { build: "node build.mjs" },
    }),
  );
  await writeFile(join(source, "package-lock.json"), "{}");
  await writeFile(
    join(source, "build.mjs"),
    `import {cp,writeFile} from 'node:fs/promises';import {existsSync} from 'node:fs';
if(existsSync('.fail-build'))process.exit(27);
if(existsSync('.hold-build')){await writeFile('.building','ready');while(existsSync('.hold-build'))await new Promise(r=>setTimeout(r,50));}
await cp(${JSON.stringify(join(root, "dist"))},'dist',{recursive:true});
await writeFile('dist/web/experiment.txt',String(Date.now()));\n`,
  );
  await symlink(
    join(root, "node_modules"),
    join(source, "node_modules"),
    "dir",
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "preview fixture",
  );
  await chmod(fake, 0o755);
  const bin = join(base, "bin");
  await mkdir(bin);
  await cp(join(root, "test", "harness.mjs"), join(bin, "codex"));
  await chmod(join(bin, "codex"), 0o755);
  // Fixture installs are offline; builds still use npm's actual script runner.
  await writeFile(
    join(bin, "npm"),
    `#!/usr/bin/env node
import {symlinkSync} from 'node:fs';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
if(process.argv[2]==='ci'){symlinkSync(${JSON.stringify(join(root, "node_modules"))},join(process.cwd(),'node_modules'),'dir');}
else {const child=spawnSync('npm',process.argv.slice(2),{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(process.env.PATH)}}});process.exit(child.status??1);}\n`,
  );
  await chmod(join(bin, "npm"), 0o755);
  const env = {
    ...process.env,
    NODE_ENV: "test",
    LOOP_PREVIEWS_DIR: registry,
    PATH: bin + ":" + process.env.PATH,
    LOOP_TEST_HARNESS: "codex",
    LOOP_TEST_AUDIT: join(base, "prompts.log"),
    LOOP_HOME: live,
    LOOP_DATA_DIR: live,
    LOOP_ENCRYPTION_KEY: "invalid-inherited-key",
    LOOP_CONNECTION_DIR: join(live, "connection"),
    LOOP_CONNECTION_MANAGED: "external",
    LOOP_SERVICE: "systemd",
    LOOP_TEST_CLOUDFLARED: fake,
    LOOP_TEST_TUNNEL_LOG: join(base, "tunnels.log"),
  };
  const loop = (...args: string[]) =>
    exec(process.execPath, [cli, "preview", ...args], {
      env,
      cwd: source,
      timeout: 90000,
      maxBuffer: 2 * 1024 * 1024,
    });
  const status = async (name: string) =>
    JSON.parse((await loop("status", name, "--json")).stdout);
  const cleanup = async () => {
    for (const name of ["posts", "other", "branch", "working"])
      await loop("stop", name).catch(() => {});
    await rm(base, { recursive: true, force: true });
  };
  return { base, source, registry, live, env, loop, status, cleanup, git };
}

test(
  "design preview lifecycle isolates state, simulates sends, preserves pairing across staged rebuilds and fails closed",
  { timeout: 180000 },
  async () => {
    const f = await fixture();
    try {
      const branches = f.git("branch", "--list");
      for (const url of [
        "http://preview.example.com",
        "https://preview.example.com/path",
        "https://preview.example.com/?query=1",
        "https://preview.example.com/#fragment",
        "https://user:pass@preview.example.com",
        "not-a-url",
      ]) {
        await assert.rejects(
          f.loop("create", "posts", "--project", f.source, "--public-url", url),
          /bare HTTPS origin|Invalid URL/,
        );
        assert(!existsSync(join(f.registry, "previews", "posts")));
        assert.equal(f.git("branch", "--list"), branches);
      }
      for (const providers of ["codez", "codex,unknown", ""]) {
        await assert.rejects(
          f.loop(
            "create",
            "posts",
            "--project",
            f.source,
            "--mode",
            "working",
            "--providers",
            providers,
            "--local-only",
          ),
          /Choose installed/,
        );
        assert(!existsSync(join(f.registry, "previews", "posts")));
        assert.equal(f.git("branch", "--list"), branches);
      }
      await mkdir(f.registry, { recursive: true, mode: 0o700 });
      await chmod(f.registry, 0o770);
      try {
        await assert.rejects(
          f.loop("start", "posts", "--project", f.source),
          /accessible only to this user/,
        );
        assert(!existsSync(join(f.registry, "previews", "posts")));
      } finally {
        await chmod(f.registry, 0o700);
      }
      await mkdir(join(f.source, ".tmp"), { mode: 0o755 });
      const started = await f.loop("start", "posts", "--project", f.source);
      const before = await f.status("posts");
      const registered = join(f.registry, "previews", "posts");
      await chmod(registered, 0o702);
      try {
        await assert.rejects(f.status("posts"), /accessible only to this user/);
        assert.deepEqual(JSON.parse((await f.loop("list", "--json")).stdout), [
          { name: "posts", state: "unavailable" },
        ]);
      } finally {
        await chmod(registered, 0o700);
      }
      assert.equal(before.state, "ready");
      assert.equal(before.preview.mode, "design");
      assert.equal(before.harnesses.length, 0);
      assert.equal(before.preview.build.commit, f.git("rev-parse", "HEAD"));
      const phone = browser(before.connection.service.relay, before.url);
      await phone.pair(started.stdout.match(/#pair=([\w-]+)/)![1]);
      const bootstrap = (await phone.send("GET", "/api/bootstrap")).data;
      assert.equal(bootstrap.preview.build.id, before.preview.build.id);
      assert.equal(bootstrap.agents.length, 5);
      assert.equal((await phone.send("GET", "/api/capabilities")).data.cardTokens, false);
      assert(!JSON.stringify(bootstrap.preview).includes(f.base));
      const buildStatus = await phone.send("GET", "/api/build");
      assert.equal(buildStatus.status, 200);
      assert.equal(buildStatus.data.serving.id, before.buildIdentity.id);
      assert.deepEqual(
        buildStatus.data.processes.map((p: any) => p.role),
        ["api"],
      );
      assert(!JSON.stringify(buildStatus.data).includes(f.base));
      const catalog = await phone.send(
        "GET",
        "/api/connections/" + bootstrap.connections[0].id + "/models",
      );
      assert.equal(catalog.status, 200);
      assert.equal(catalog.data.models[0].id, "preview-simulator");
      assert.equal(
        (await phone.send("GET", "/api/health")).data.worker,
        "simulated",
      );
      assert.deepEqual(
        (await phone.send("GET", "/api/agent-sources")).data,
        [],
      );
      assert.deepEqual(
        (await phone.send("GET", "/api/workspace/runtimes?fresh=1")).data,
        {
          computer: "Design preview",
          online: true,
          runtimes: [],
        },
      );
      for (const [method, path, body] of [
        ["GET", "/api/workspace/runtimes/codex/auth?projectId=anything"],
        ["GET", "/api/agent-sources/docker:anything/bootstrap"],
        ["GET", "/api/agents/anything/pi-packages"],
        [
          "POST",
          "/api/connections",
          { provider: "openai", label: "Live", secret: "not-a-key" },
        ],
        ["POST", "/api/mcp", { name: "External", url: "https://example.com" }],
        ["POST", "/api/preferences", { embeddingEnabled: true }],
      ] as [string, string, unknown?][])
        assert.equal((await phone.send(method, path, body)).status, 403, path);
      const agent = bootstrap.agents.find((a: any) => a.name === "willow");
      const send = {
        agentId: agent.id,
        input: "Try the new conversation design",
        idempotencyKey: randomUUID(),
      };
      const first = await phone.send("POST", "/api/runs", send);
      assert.equal(first.status, 202);
      let result: any;
      for (let i = 0; i < 60; i++) {
        result = (await phone.send("GET", "/api/runs")).data.find(
          (r: any) => r.id === first.data.id,
        );
        if (result?.state === "completed") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(result.state, "completed");
      assert.match(result.result, /Simulated reply/);
      assert.equal(
        (await phone.send("POST", "/api/runs", send)).data.id,
        first.data.id,
      );
      const samples = (await phone.send("GET", "/api/runs")).data;
      for (const state of ["running", "awaiting_approval"]) {
        const sample = samples.find(
          (r: any) =>
            r.state === (state === "running" ? "waiting_children" : state),
        );
        const input = {
          agentId: sample.agent_id,
          conversationId: sample.conversation_id,
          input: "Steer the sample " + state,
          idempotencyKey: randomUUID(),
        };
        const sent = await phone.send("POST", "/api/runs", input);
        assert.equal(sent.status, 202);
        assert(sent.data.steeringId);
        let thread: any, receipt: any;
        for (let i = 0; i < 60; i++) {
          thread = (
            await phone.send(
              "GET",
              "/api/conversations/" + sample.conversation_id,
            )
          ).data;
          receipt = thread.messages.find((m: any) => m.content === input.input);
          if (receipt && JSON.parse(receipt.metadata).delivery === "delivered")
            break;
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(JSON.parse(receipt.metadata).delivery, "delivered");
        assert(
          thread.messages.some((m: any) =>
            m.content.includes("**Simulated reply**"),
          ),
        );
        const replay = await phone.send("POST", "/api/runs", input);
        assert.equal(replay.data.steeringId, sent.data.steeringId);
        const current = (await phone.send("GET", "/api/runs")).data.find(
          (r: any) => r.id === sample.id,
        );
        assert.equal(
          current.state,
          state === "running" ? "completed" : "awaiting_approval",
        );
      }
      const failed = samples.find((r: any) => r.state === "failed");
      assert.equal(
        (await phone.send("POST", "/api/runs/" + failed.id + "/dismiss", {}))
          .status,
        200,
      );
      assert(
        !(await phone.send("GET", "/api/runs?active=1")).data.some(
          (r: any) => r.id === failed.id,
        ),
      );
      const approval = (await phone.send("GET", "/api/approvals")).data[0];
      const awaiting = samples.find((r: any) => r.id === approval.run_id);
      const queued = await phone.send("POST", "/api/runs", {
        agentId: awaiting.agent_id,
        conversationId: awaiting.conversation_id,
        input: "Continue only after the approval",
        queue: true,
        idempotencyKey: randomUUID(),
      });
      assert.equal(queued.status, 202);
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(
        (await phone.send("GET", "/api/runs")).data.find(
          (r: any) => r.id === queued.data.id,
        ).state,
        "queued",
      );
      assert.equal(
        (
          await phone.send("POST", "/api/approvals/" + approval.id, {
            decision: "approve",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await phone.send("POST", "/api/approvals/" + approval.id, {
            decision: "approve",
          })
        ).status,
        409,
      );
      let continued: any;
      for (let i = 0; i < 60; i++) {
        continued = (await phone.send("GET", "/api/runs")).data.find(
          (r: any) => r.id === queued.data.id,
        );
        if (continued.state === "completed") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(continued.state, "completed");
      const devices = (await phone.send("GET", "/api/workspace/devices")).data;
      await writeFile(
        join(f.source, "tracked.txt"),
        "uncommitted experiment\n",
      );
      const follower = spawn(
        process.execPath,
        [cli, "preview", "logs", "posts", "--follow"],
        {
          env: f.env,
          cwd: f.source,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let followError = "";
      follower.stderr.on("data", (chunk) => {
        followError += String(chunk);
      });
      let followTimeout: NodeJS.Timeout | undefined;
      try {
        const followed = new Promise<void>((yes, no) => {
          let output = "";
          follower.stdout.on("data", (chunk) => {
            output += String(chunk);
            if (output.includes("preview-follow-ready")) yes();
          });
          follower.once("error", no);
          follower.once("exit", () =>
            no(new Error("Log follower exited: " + followError)),
          );
          followTimeout = setTimeout(
            () => no(new Error("Log follower did not read its marker")),
            10000,
          );
        });
        await appendFile(
          join(
            f.registry,
            "previews",
            "posts",
            "runtime",
            "workspace",
            "daemon.log",
          ),
          "preview-follow-ready\n",
        );
        await followed;
        await f.loop("rebuild", "posts");
        assert.equal(
          follower.exitCode,
          null,
          "rebuild works while logs are followed",
        );
      } finally {
        clearTimeout(followTimeout);
        if (follower.exitCode === null && follower.signalCode === null) {
          const stopped = once(follower, "exit");
          follower.kill("SIGTERM");
          await stopped;
        }
      }
      const after = await f.status("posts");
      assert.notEqual(after.pid, before.pid);
      assert.notEqual(after.preview.build.id, before.preview.build.id);
      assert.equal(after.preview.build.dirty, true);
      assert.equal(after.url, before.url);
      assert.equal(after.connection.service.pid, before.connection.service.pid);
      assert.equal(
        after.connection.service.tunnel.pid,
        before.connection.service.tunnel.pid,
      );
      assert.deepEqual(
        (await phone.send("GET", "/api/workspace/devices")).data,
        devices,
      );
      assert.equal(
        (await phone.send("GET", "/api/bootstrap")).data.agents.length,
        5,
        "seed runs once",
      );
      await writeFile(join(f.source, ".fail-build"), "fail");
      await assert.rejects(f.loop("rebuild", "posts"), /failed/);
      assert.equal((await f.status("posts")).pid, after.pid);
      assert.equal(
        (await f.status("posts")).preview.build.id,
        after.preview.build.id,
      );
      await rm(join(f.source, ".fail-build"));
      const stagingEdit = join(f.base, "edit-during-staging.mjs");
      await writeFile(
        stagingEdit,
        `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const copy=fs.promises.cp;
fs.promises.cp=async function(path,...args){const result=await copy(path,...args);if(path===${JSON.stringify(join(f.source, "dist"))})fs.appendFileSync(${JSON.stringify(join(f.source, "tracked.txt"))},'changed during staging\\n');return result;};
syncBuiltinESMExports();`,
      );
      await assert.rejects(
        exec(
          process.execPath,
          ["--import", stagingEdit, cli, "preview", "rebuild", "posts"],
          {
            env: f.env,
            cwd: f.source,
            timeout: 90000,
          },
        ),
        /checkout changed while staging/,
      );
      assert.equal((await f.status("posts")).pid, after.pid);
      assert.equal(
        (await f.status("posts")).preview.build.id,
        after.preview.build.id,
      );
      await writeFile(
        join(f.source, "tracked.txt"),
        "uncommitted experiment\n",
      );
      await f.loop("start", "other", "--project", f.source, "--local-only");
      assert.notEqual(
        (await f.status("other")).preview.build.id,
        after.preview.build.id,
      );
      assert.equal((await f.status("other")).agents, 5);
      await writeFile(join(f.source, ".hold-build"), "wait");
      const rebuilding = f.loop("rebuild", "other");
      // Observe the build in progress before trying the other preview name.
      try {
        for (
          let i = 0;
          i < 100 && !existsSync(join(f.source, ".building"));
          i++
        )
          await new Promise((r) => setTimeout(r, 50));
        assert(existsSync(join(f.source, ".building")));
        await assert.rejects(
          f.loop("rebuild", "posts"),
          /Another preview is building this checkout/,
        );
      } finally {
        await rm(join(f.source, ".hold-build"), { force: true });
        await rebuilding;
      }
      assert(
        !existsSync(join(f.base, "prompts.log")),
        "design previews never invoke a harness",
      );
      const localCookies = new Map<string, string>();
      const other = await f.status("other");
      const samplePhone = browser(other.url, other.url, localCookies);
      await samplePhone.pair(
        (await f.loop("open", "other")).stdout.match(/#pair=([\w-]+)/)![1],
      );
      const localStarted = await f.loop(
        "start",
        "branch",
        "--project",
        f.source,
        "--local-only",
      );
      const local = await f.status("branch");
      const localPhone = browser(local.url, local.url, localCookies);
      await localPhone.pair(localStarted.stdout.match(/#pair=([\w-]+)/)![1]);
      assert.equal(
        localCookies.size,
        2,
        "local preview cookies have distinct names",
      );
      assert.equal((await samplePhone.send("GET", "/session")).status, 200);
      assert.equal((await localPhone.send("GET", "/session")).status, 200);
      if (process.env.LOOP_TEST_PREVIEW_BROWSER === "1") {
        const link = (await f.loop("open", "other")).stdout.match(
          /http:\/\/[^\s]+#pair=[\w-]+/,
        )![0];
        const browser = await chromium.launch({
          ...(process.env.CHROMIUM_PATH
            ? { executablePath: process.env.CHROMIUM_PATH }
            : {}),
          args: ["--no-sandbox"],
        });
        try {
          const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
          });
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.goto(link);
          await page
            .getByRole("button", { name: "Pair and open Loop" })
            .click();
          await page.getByText("Preview · other", { exact: true }).waitFor();
          await page
            .getByText("Sample data · Simulated replies", { exact: true })
            .waitFor();
          const second = await context.newPage();
          await second.goto(
            (await f.loop("open", "branch")).stdout.match(
              /http:\/\/[^\s]+#pair=[\w-]+/,
            )![0],
          );
          await second
            .getByRole("button", { name: "Pair and open Loop" })
            .click();
          await second.getByText("Preview · branch", { exact: true }).waitFor();
          await page.reload();
          await page.getByText("Preview · other", { exact: true }).waitFor();
          await second.reload();
          await second.getByText("Preview · branch", { exact: true }).waitFor();
          await second.close();
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
            true,
          );
          await page.getByText("Build details", { exact: true }).click();
          await page.getByText(/Includes local edits/).waitFor();
          await page.screenshot({
            path: join(root, ".tmp", "preview-phone.png"),
            fullPage: true,
          });
          await page
            .getByRole("button", { name: "New agent", exact: true })
            .click();
          const create = page.getByRole("dialog", {
            name: "Meet your next agent",
          });
          await create
            .getByText("Runtimes and execution environments", { exact: true })
            .click();
          await create
            .getByRole("heading", { name: "Design preview", exact: true })
            .waitFor();
          await create
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Open thread", exact: true })
            .click();
          const composer = page.getByRole("textbox", {
            name: "Reply to agent",
          });
          await composer.fill("Try a reply from this phone preview");
          await page
            .getByRole("button", { name: "Send reply", exact: true })
            .click();
          await page
            .getByRole("dialog", { name: /^Explore posts and comments/ })
            .getByText("Your message was received in this design preview.", {
              exact: false,
            })
            .waitFor();
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
        }
      }
      await f.loop("discard", "branch");
      const otherSamples = (await samplePhone.send("GET", "/api/runs")).data;
      const reject = (await samplePhone.send("GET", "/api/approvals")).data[0];
      assert.equal(
        (
          await samplePhone.send("POST", "/api/approvals/" + reject.id, {
            decision: "reject",
          })
        ).status,
        200,
      );
      const rejected = (await samplePhone.send("GET", "/api/runs")).data.find(
        (r: any) => r.id === reject.run_id,
      );
      assert.equal(rejected.state, "failed");
      assert.match(rejected.error, /rejected/i);
      assert(!rejected.result);
      assert(
        !(await samplePhone.send("GET", "/api/artifacts")).data.items.some(
          (a: any) => a.run_id === rejected.id,
        ),
        "rejection does not produce a successful result artifact",
      );
      assert.equal(
        (
          await samplePhone.send("POST", "/api/approvals/" + reject.id, {
            decision: "approve",
          })
        ).status,
        409,
      );
      const active = otherSamples.find(
        (r: any) => r.state === "waiting_children",
      );
      assert.equal(
        (
          await samplePhone.send(
            "POST",
            "/api/runs/" + active.id + "/pause",
            {},
          )
        ).status,
        200,
      );
      const behindPause = await samplePhone.send("POST", "/api/runs", {
        agentId: active.agent_id,
        conversationId: active.conversation_id,
        input: "Continue after the paused task",
        queue: true,
        idempotencyKey: randomUUID(),
      });
      assert.equal(behindPause.status, 202);
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(
        (await samplePhone.send("GET", "/api/runs")).data.find(
          (r: any) => r.id === behindPause.data.id,
        ).state,
        "queued",
      );
      assert.equal(
        (
          await samplePhone.send(
            "POST",
            "/api/runs/" + active.id + "/resume",
            {},
          )
        ).status,
        200,
      );
      let resumed: any;
      for (let i = 0; i < 60; i++) {
        resumed = (await samplePhone.send("GET", "/api/runs")).data.find(
          (r: any) => r.id === active.id,
        );
        if (resumed.state === "completed") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(resumed.state, "completed");
      assert.match(resumed.result, /Simulated reply/);
      // The complete change log includes projection invalidations from seeding.
      // Follow the production endpoint's 200-event pages to the completions.
      const completions: any[] = [];
      let eventCursor = 0;
      for (let page = 0; ; page++) {
        assert(page < 100, "preview replay must reach its current tip");
        const events = (
          await samplePhone.send("GET", "/api/events?after=" + eventCursor)
        ).data;
        completions.push(...events.filter((e: any) => e.type === "completed"));
        if (events.length < 200) break;
        assert(events.at(-1).id > eventCursor, "event replay must advance");
        eventCursor = events.at(-1).id;
      }
      const resumedIndex = completions.findIndex(
        (e: any) => e.run_id === active.id,
      );
      const followUpIndex = completions.findIndex(
        (e: any) => e.run_id === behindPause.data.id,
      );
      assert(resumedIndex >= 0 && followUpIndex > resumedIndex);
      const parked = otherSamples.find((r: any) => r.state === "queued");
      assert.equal(
        (await samplePhone.send("GET", "/api/runs")).data.find(
          (r: any) => r.id === parked.id,
        ).state,
        "queued",
      );
      process.kill(other.pid, "SIGKILL");
      let crashed: any;
      for (let i = 0; i < 60; i++) {
        crashed = await f.status("other");
        if (crashed.state === "crashed") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(crashed.state, "crashed");
      await f.loop("rebuild", "other");
      const recovered = await f.status("other");
      assert.equal(recovered.state, "ready");
      assert.notEqual(recovered.preview.build.id, other.preview.build.id);
      assert.equal(recovered.agents, 5);
      assert.equal(
        (
          await browser(recovered.url, recovered.url, localCookies).send(
            "GET",
            "/session",
          )
        ).status,
        200,
        "local pairing survives a rebuild onto a new port",
      );
      await assert.rejects(
        f.loop("start", "posts", "--mode", "working"),
        /already saved/,
      );
      await assert.rejects(f.loop("start", "../escape"), /lowercase letters/);
      const listed = JSON.parse((await f.loop("list", "--json")).stdout);
      assert.equal(listed.length, 2);
      assert.match((await f.loop("open", "posts")).stdout, /#pair=/);
      await f.loop("stop", "other");
      assert.equal((await f.status("posts")).pid, after.pid);
      const previewData = join(
        f.registry,
        "previews",
        "posts",
        "runtime",
        "workspace",
      );
      await assert.rejects(
        exec(process.execPath, [cli, "server"], {
          env: {
            ...process.env,
            LOOP_DATA_DIR: previewData,
            LOOP_PREVIEW_MANIFEST: "",
          },
          timeout: 10000,
        }),
        /Preview state requires/,
      );
      // Hold list immediately after it reads the registry, then discard its captured entry.
      const gate = join(f.base, "list-hold"),
        ready = join(f.base, "list-ready"),
        preload = join(f.base, "list-race.mjs");
      await writeFile(gate, "hold");
      await writeFile(
        preload,
        `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const read=fs.promises.readdir;
fs.promises.readdir=async function(path,...args){const entries=await read(path,...args);if(path===${JSON.stringify(join(f.registry, "previews"))}){fs.writeFileSync(${JSON.stringify(ready)},'ready');while(fs.existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,20));}return entries;};
syncBuiltinESMExports();`,
      );
      const listing = exec(
        process.execPath,
        ["--import", preload, cli, "preview", "list", "--json"],
        { env: f.env, timeout: 30000 },
      );
      let listedAfter: any;
      try {
        for (let i = 0; i < 100 && !existsSync(ready); i++)
          await new Promise((r) => setTimeout(r, 50));
        assert(existsSync(ready), "list reached registry enumeration");
        await f.loop("discard", "posts");
      } finally {
        await rm(gate, { force: true });
        listedAfter = JSON.parse((await listing).stdout);
      }
      assert(!listedAfter.some((r: any) => r.name === "posts"));
      assert(!existsSync(join(f.registry, "previews", "posts")));
      assert.equal(
        await readFile(join(f.source, "tracked.txt"), "utf8"),
        "uncommitted experiment\n",
      );
      assert.equal(
        await readFile(join(f.live, "sentinel"), "utf8"),
        "everyday Loop is untouched",
      );
      assert(!existsSync(join(f.live, "workspace")));
      assert(!existsSync(join(f.live, "connection")));
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "create owns an experiment branch without changing its parent checkout; discard preserves source",
  { timeout: 180000 },
  async () => {
    const f = await fixture();
    try {
      const head = f.git("rev-parse", "HEAD"),
        branch = f.git("symbolic-ref", "--short", "HEAD");
      await assert.rejects(
        f.loop("create", "branch", "--from", "does-not-exist", "--local-only"),
      );
      await f.loop("create", "branch", "--local-only");
      const status = await f.status("branch");
      assert.notEqual(status.source, f.source);
      assert.match(status.preview.build.branch, /^preview\/branch-/);
      assert.equal(status.preview.build.commit, head);
      assert.equal(f.git("symbolic-ref", "--short", "HEAD"), branch);
      assert.equal(f.git("status", "--porcelain"), "");
      assert.equal(f.git("rev-parse", "HEAD"), head);
      await writeFile(
        join(status.source, "tracked.txt"),
        "keep my experiment edits\n",
      );
      await f.loop("discard", "branch");
      assert.equal(
        await readFile(join(status.source, "tracked.txt"), "utf8"),
        "keep my experiment edits\n",
      );
      assert.equal(f.git("rev-parse", status.preview.build.branch), head);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "working previews use their own native workspace without seeding design data",
  { timeout: 180000 },
  async () => {
    const f = await fixture();
    try {
      await f.loop(
        "start",
        "working",
        "--project",
        f.source,
        "--mode",
        "working",
        "--providers",
        "codex",
        "--local-only",
      );
      let status: any;
      for (let i = 0; i < 80; i++) {
        status = await f.status("working");
        if (status.harnesses.length) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(status.preview.mode, "working");
      assert.equal(status.harnesses[0]?.name, "codex");
      assert.equal(status.agents, 0);
      assert(!existsSync(join(f.live, "workspace")));
      const previewDir = join(f.registry, "previews", "working");
      const db = new Database(
        join(previewDir, "runtime", "workspace", "loop.db"),
      );
      const pending = randomUUID();
      try {
        const owner = (
          db.prepare("SELECT owner_id FROM connections LIMIT 1").get() as {
            owner_id: string;
          }
        ).owner_id;
        // Hold the production worker-owned pause state without invoking a provider.
        db.prepare(
          "INSERT INTO runs(id,owner_id,input,state,idempotency_key,worker_id,heartbeat,created_at,updated_at) VALUES(?,?,?,'pausing',?,'fixture-pausing',?,?,?)",
        ).run(
          pending,
          owner,
          "Pause still settling",
          pending,
          Date.now(),
          Date.now(),
          Date.now(),
        );
        assert.equal((await f.status("working")).activeRuns.n, 1);
        await assert.rejects(
          f.loop("rebuild", "working"),
          /1 run\(s\) are active.*--force/s,
        );
        assert.equal((await f.status("working")).pid, status.pid);
        assert.equal(
          (
            db.prepare("SELECT state FROM runs WHERE id=?").get(pending) as {
              state: string;
            }
          ).state,
          "pausing",
        );
      } finally {
        db.prepare("DELETE FROM runs WHERE id=?").run(pending);
        db.close();
      }
      await f.loop("rebuild", "working");
      assert.equal((await f.status("working")).preview.mode, "working");
      const unresolved = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          stdio: "ignore",
        },
      );
      try {
        await once(unresolved, "spawn");
        const records = join(
          previewDir,
          "runtime",
          "workspace",
          "stop-records.json",
        );
        const unknownChild = [{ pid: unresolved.pid, identity: "" }];
        await writeFile(records, JSON.stringify(unknownChild));
        await assert.rejects(
          f.loop("stop", "working"),
          /could not be confirmed/,
        );
        assert.equal((await f.status("working")).state, "stopped");
        await assert.rejects(
          f.loop("discard", "working"),
          /could not be confirmed/,
        );
        assert.deepEqual(
          JSON.parse(await readFile(records, "utf8")),
          unknownChild,
        );
        assert(existsSync(join(previewDir, "preview.json")));
        process.kill(unresolved.pid!, 0);
        const exited = once(unresolved, "exit");
        unresolved.kill("SIGKILL");
        await exited;
        await f.loop("discard", "working");
        assert(!existsSync(previewDir));
      } finally {
        unresolved.kill("SIGKILL");
      }
    } finally {
      await f.cleanup();
    }
  },
);
