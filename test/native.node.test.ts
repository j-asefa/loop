process.env.LOOP_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Native } from "../src/native.js";

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
