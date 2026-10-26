process.env.LOOP_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Native } from "../src/native.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a host resource launcher preserves native RPC, metadata, PID, arguments and environment", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "loop-native-launcher-"));
  const launcher = join(directory, "launcher.sh");
  writeFileSync(launcher, '#!/bin/sh\nexport LOOP_TEST_LAUNCHED=yes\nexec "$@"\n', { mode: 0o700 });
  const previous = process.env.LOOP_NATIVE_LAUNCHER;
  process.env.LOOP_NATIVE_LAUNCHER = launcher;
  let native: Native | undefined;
  try {
    native = new Native(process.execPath, ["-e", `
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        require('node:fs').writeSync(3, JSON.stringify({kind:'fixture-metadata'})+'\\n');
        process.stdout.write(JSON.stringify({id:request.id,result:{pid:process.pid,
          argument:process.argv[1],launched:process.env.LOOP_TEST_LAUNCHED,
          setting:process.env.LOOP_TEST_SETTING,launcher:process.env.LOOP_NATIVE_LAUNCHER??null,
          supervisor:process.env.LOOP_SERVICE??null}})+'\\n');
      });
    `, "spaces; $literal argument"], directory, {
      ...process.env, LOOP_NATIVE_LAUNCHER: "/ignored-child-setting",
      LOOP_SERVICE: "systemd", LOOP_TEST_SETTING: "preserved",
    });
    const metadata = once(native, "metadata");
    assert.deepEqual(await native.request("inspect"), {
      pid: native.child.pid, argument: "spaces; $literal argument", launched: "yes",
      setting: "preserved", launcher: null, supervisor: null,
    });
    assert.deepEqual((await metadata)[0], { kind: "fixture-metadata" });
  } finally {
    await native?.dispose();
    if (previous === undefined) delete process.env.LOOP_NATIVE_LAUNCHER;
    else process.env.LOOP_NATIVE_LAUNCHER = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a refused resource placement never falls back to executing the harness", { skip: process.platform === "win32" }, async () => {
  const previous = process.env.LOOP_NATIVE_LAUNCHER;
  process.env.LOOP_NATIVE_LAUNCHER = "/bin/false";
  const native = new Native(process.execPath, ["-e", "process.stdout.write('should not execute')"], process.cwd());
  try {
    await assert.rejects(native.request("inspect"), /Native process exited/);
  } finally {
    await native.dispose();
    if (previous === undefined) delete process.env.LOOP_NATIVE_LAUNCHER;
    else process.env.LOOP_NATIVE_LAUNCHER = previous;
  }
});

test("native framing preserves split UTF-8 and Unicode separators; correlates interleaved replies", async () => {
  const native = new Native(
    process.execPath,
    [
      "-e",
      `
    const readline = require('node:readline');
    const requests=[];
    readline.createInterface({input:process.stdin}).on('line',line=>{
      requests.push(JSON.parse(line)); if(requests.length!==2)return;
      process.stderr.write('private-native-diagnostic');
      const bytes=Buffer.from(JSON.stringify({method:'delta',params:{text:'café 漢字\\u2028still one record'}})+'\\n');
      const cut=bytes.indexOf(Buffer.from('é'))+1;
      process.stdout.write(bytes.subarray(0,cut));
      setTimeout(()=>{process.stdout.write(bytes.subarray(cut));
        for(const r of requests.reverse())process.stdout.write(JSON.stringify({id:r.id,result:{method:r.method}})+'\\n');
      },10);
    });
  `,
    ],
    process.cwd(),
  );
  const messages: any[] = [];
  native.on("message", (m) => messages.push(m));
  try {
    const results = await Promise.all([
      native.request("first"),
      native.request("second"),
    ]);
    assert.deepEqual(results, [{ method: "first" }, { method: "second" }]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].params.text, "café 漢字\u2028still one record");
    assert(!JSON.stringify(messages).includes("private-native-diagnostic"));
  } finally {
    await native.dispose();
  }
});

test("ordinary native transports still reject oversized frames", async () => {
  const native = new Native(process.execPath, ["-e", `
    process.stdin.once('data', () => process.stdout.write('x'.repeat(9 * 1024 * 1024)));
  `], process.cwd());
  const failure = once(native, "failure");
  try {
    await assert.rejects(native.request("read"), /Native frame exceeds 8 MiB/);
    assert.match((await failure)[0].message, /Native frame exceeds 8 MiB/);
    assert.equal(native.pending.size, 0);
  } finally {
    await native.dispose();
  }
});

for (const output of ["null\n", "not-json\n", '{"id":1']) {
  test(`malformed/truncated native frames fail without accepting a command: ${JSON.stringify(output)}`, async () => {
    const native = new Native(
      process.execPath,
      [
        "-e",
        `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(output)});setTimeout(()=>process.exit(1),10)})`,
      ],
      process.cwd(),
    );
    const failure = once(native, "failure");
    try {
      await assert.rejects(native.request("mutation"));
      assert((await failure)[0] instanceof Error);
      assert.equal(native.pending.size, 0);
    } finally {
      await native.dispose();
    }
  });
}
for (const explicit of [false, true]) {
  test(`native children do not inherit service ownership (${explicit ? "explicit" : "default"} environment)`, async () => {
    const previous = process.env.LOOP_SERVICE;
    process.env.LOOP_SERVICE = "systemd";
    const env: NodeJS.ProcessEnv = { ...process.env, LOOP_TEST_NATIVE_SETTING: "fixture-setting" };
    let native: Native;
    try {
      native = new Native(process.execPath, ["-e", `
        require('node:readline').createInterface({input:process.stdin}).on('line', line => {
          const request = JSON.parse(line);
          process.stdout.write(JSON.stringify({id:request.id,result:{
            supervisor:process.env.LOOP_SERVICE ?? null,
            setting:process.env.LOOP_TEST_NATIVE_SETTING ?? null,
            path:process.env.PATH,
          }}) + '\\n');
        });
      `], process.cwd(), explicit ? env : undefined);
    } finally {
      if (previous === undefined) delete process.env.LOOP_SERVICE;
      else process.env.LOOP_SERVICE = previous;
    }
    try {
      assert.deepEqual(await native.request("environment"), {
        supervisor: null,
        setting: explicit ? "fixture-setting" : (process.env.LOOP_TEST_NATIVE_SETTING ?? null),
        path: process.env.PATH,
      });
      assert.equal(env.LOOP_SERVICE, "systemd", "the caller's environment remains unchanged");
    } finally {
      await native.dispose();
    }
  });
}
