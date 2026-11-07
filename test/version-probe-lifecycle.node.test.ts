import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { discover } from "../src/host-control.js";
import { RuntimeHarness } from "../src/shared/execution-authority.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert(Date.now() < end, "fixture did not finish");
    await sleep(20);
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("concurrent discovery shares a version process and later probes observe changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "loop-version-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, "grok");
  const calls = join(dir, "calls");
  await writeFile(
    executable,
    `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'probe\\n');
setTimeout(() => console.log('1.0.71'), 300);
`,
    { mode: 0o755 },
  );
  const results = await Promise.all(
    Array.from({ length: 8 }, () => discover("grok", executable)),
  );
  assert(results.every((r) => r.supported && r.version === "1.0.71"));
  assert.equal(readFileSync(calls, "utf8"), "probe\n");
  await writeFile(executable, "#!/usr/bin/env node\nconsole.log('1.0.72');\n", {
    mode: 0o755,
  });
  assert.equal((await discover("grok", executable)).version, "1.0.72");
});

for (const hangs of [false, true]) {
  test(
    `a version launcher ${hangs ? "timeout" : "exit"} stops descendants holding its pipes`,
    { timeout: 20000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "loop-version-child-"));
      const marker = join(dir, "child");
      t.after(async () => {
        if (existsSync(marker)) {
          try {
            process.kill(Number(readFileSync(marker, "utf8")), "SIGKILL");
          } catch {}
        }
        await rm(dir, { recursive: true, force: true });
      });
      const executable = join(dir, "grok");
      const descendant = `
require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;
      await writeFile(
        executable,
        `#!/usr/bin/env node
const {spawn} = require('node:child_process');
const {existsSync} = require('node:fs');
spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'});
const timer=setInterval(() => {
  if (!existsSync(${JSON.stringify(marker)})) return;
  clearInterval(timer);
  ${hangs ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);" : "process.stdout.write('1.0.71\\n',()=>process.exit(0));"}
}, 20);
`,
        { mode: 0o755 },
      );
      const found = await discover("grok", executable);
      assert.equal(found.supported, !hangs);
      assert(existsSync(marker), "the descendant was started");
      await until(() => !alive(Number(readFileSync(marker, "utf8"))));
    },
  );
}

test("the companion sign-in fixture shadows every non-fixture installed harness", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "loop-browser-harnesses-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installed = join(dir, "installed");
  await mkdir(installed);
  const marker = join(dir, "real-harness-called");
  const commands = RuntimeHarness.options.map((name) =>
    name === "antigravity" ? "agy" : name,
  );
  for (const command of commands)
    await writeFile(
      join(installed, command),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'called');process.exit(90);\n`,
      { mode: 0o755 },
    );
  const helper = new URL(
    "../scripts/helpers/native-auth-browser.mjs",
    import.meta.url,
  ).href;
  const { stdout } = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareNativeAuthBrowser} from ${JSON.stringify(helper)};
const exec=promisify(execFile);
const before=process.env.PATH;
const restore=await prepareNativeAuthBrowser(${JSON.stringify(dir)});
try {
  for (const command of ${JSON.stringify(commands.filter((name) => name !== "claude"))}) {
    await assert.rejects(exec(command,['--version']), error => error.code === 127);
  }
  assert.match((await exec('claude',['--version'])).stdout,/2\.1\.284/);
} finally { restore(); }
assert.equal(process.env.PATH,before);
console.log('isolated');
`,
    ],
    {
      env: { ...process.env, PATH: installed + ":" + process.env.PATH },
      timeout: 15000,
    },
  );
  assert.equal(stdout.trim(), "isolated");
  assert.equal(existsSync(marker), false);
});
