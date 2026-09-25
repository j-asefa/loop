import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const root = mkdtempSync(join(tmpdir(), "loop-native-host-"));
const home = join(root, "home"),
  workdir = join(root, "project"),
  bin = join(root, "bin");
for (const dir of [home, workdir, bin]) mkdirSync(dir);
const token = "native-host-fixture-token-at-least-32-characters";
const tokenFile = join(root, "token");
writeFileSync(tokenFile, token, { mode: 0o600 });
writeFileSync(join(home, "signed-in"), "subscription");
mkdirSync(join(home, ".claude"));
writeFileSync(
  join(home, ".claude", "settings.json"),
  JSON.stringify({ fixture: "host-settings" }),
);
writeFileSync(
  join(bin, "docker"),
  `#!/bin/sh\necho forbidden > '${join(root, "docker-was-used")}'\nexit 1\n`,
  { mode: 0o755 },
);
// A native CLI fixture performs real file IO in the chosen host project. No
// provider account, model inference, or machine credentials are used.
writeFileSync(
  join(bin, "claude"),
  `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const home=process.env.HOME,args=process.argv.slice(2),auth=path.join(home,'signed-in');
fs.appendFileSync(path.join(home,'calls'),JSON.stringify(args)+'\n');
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
if(args[0]==='auth') {
 if(args[1]!=='status') { fs.writeFileSync(path.join(home,'auth-mutated'),'yes');process.exit(2); }
 send({loggedIn:fs.readFileSync(auth,'utf8')==='subscription',authMethod:'claude.ai',subscriptionType:'fixture'});
} else {
 if(args.includes('--tools')||args.includes('--strict-mcp-config')||args.includes('--max-turns')||args[args.indexOf('--permission-mode')+1]!=='bypassPermissions')process.exit(3);
 let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
 if(!prompt.includes('all native tools')||process.env.FIXTURE_MCP_TOKEN!=='host-token'||process.env.ANTHROPIC_API_KEY||process.env.LOOP_RUNTIME_TOKEN_FILE)process.exit(4);
 if(process.env.CLAUDE_CONFIG_DIR||process.env.CODEX_HOME)process.exit(5);
 if(JSON.parse(fs.readFileSync(path.join(home,'.claude','settings.json'),'utf8')).fixture!=='host-settings')process.exit(5);
 if(args[args.indexOf('--model')+1]==='wait') {fs.writeFileSync(path.join(process.cwd(),'running.pid'),String(process.pid));setInterval(()=>{},1000);return;}
 fs.writeFileSync(path.join(process.cwd(),'native-tool-result.txt'),'Native host file tool executed');
 send({type:'result',subtype:'success',is_error:false,structured_output:{kind:'answer',text:fs.readFileSync('native-tool-result.txt','utf8'),tool:null,arguments:'{}'},session_id:'fixture-native-session'});
 });
}
`.replaceAll("+'\n'", "+'\\n'"),
  { mode: 0o755 },
);
let service: ChildProcess, origin: string;
let diagnostics = "";
beforeAll(async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await new Promise<void>((r) => reservation.once("listening", r));
  const port = (reservation.address() as any).port;
  await new Promise<void>((r) => reservation.close(() => r()));
  origin = `http://127.0.0.1:${port}`;
  service = spawn(process.execPath, [resolve("runtime/host.mjs")], {
    cwd: workdir,
    env: {
      PATH: bin + ":" + process.env.PATH,
      HOME: home,
      PORT: String(port),
      LOOP_RUNTIME_TOKEN_FILE: tokenFile,
      FIXTURE_MCP_TOKEN: "host-token",
      ANTHROPIC_API_KEY: "must-not-use-api-billing",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  service.stderr!.on("data", (b) => (diagnostics += b));
  await vi.waitFor(
    async () => {
      expect(
        (
          await fetch(origin + "/health", {
            headers: { authorization: "Bearer " + token },
          })
        ).ok,
        diagnostics,
      ).toBe(true);
    },
    { timeout: 10000 },
  );
});
afterAll(async () => {
  service?.kill();
  if (service?.exitCode === null)
    await new Promise<void>((r) => service.once("exit", () => r()));
  rmSync(root, { recursive: true, force: true });
});
function request(action: string, extra: object = {}, signal?: AbortSignal) {
  return fetch(origin + "/runtime", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      key: "a".repeat(64),
      provider: "claude",
      action,
      ...extra,
    }),
    signal,
  });
}
const input = (model = "fixture") => ({
  model,
  messages: [{ role: "user", content: "Use the project's tools" }],
});
it("pairs a native host, runs tools in its project with its configuration, and unpairs without touching its login", async () => {
  expect((await fetch(origin + "/health")).status).toBe(401);
  expect(
    await (
      await fetch(origin + "/health", {
        headers: { authorization: "Bearer " + token },
      })
    ).json(),
  ).toMatchObject({ kind: "native-host", nativeTools: true });
  const login = await (await request("login")).json();
  expect(login).toMatchObject({
    authenticated: true,
    authMode: "subscription",
  });
  expect(login.models.map((m: any) => m.id)).toContain("sonnet");
  const response = await request("turn", { input: input() });
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events, diagnostics).toContainEqual({ done: true });
  expect(events).toContainEqual({
    chunk: { text: "Native host file tool executed" },
  });
  expect(
    readFileSync(join(workdir, "native-tool-result.txt"), "utf8"),
  ).toContain("executed");
  expect((await request("logout")).ok).toBe(true);
  expect(readFileSync(join(home, "signed-in"), "utf8")).toBe("subscription");
  expect(existsSync(join(home, "auth-mutated"))).toBe(false);
  expect(existsSync(join(root, "docker-was-used"))).toBe(false);
  expect((await request("code", { code: "do-not-forward" })).status).toBe(400);
});
it("cancels the native process tree when the caller disconnects", async () => {
  const controller = new AbortController();
  const running = request("turn", { input: input("wait") }, controller.signal)
    .then((r) => r.text())
    .catch(() => "cancelled");
  await expect.poll(() => existsSync(join(workdir, "running.pid"))).toBe(true);
  const pid = Number(readFileSync(join(workdir, "running.pid"), "utf8"));
  controller.abort();
  await running;
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  expect(readFileSync(join(home, "signed-in"), "utf8")).toBe("subscription");
});
