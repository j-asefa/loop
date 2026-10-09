import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverClaudeModels, claudeAuthStatus } from "../src/native-auth/claude-discovery.js";

test("HAPI Claude discovery preserves native model names and effort without login or a model prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-claude-catalog-"));
  const executable = join(root, "claude");
  await writeFile(
    executable,
    `#!${process.execPath}
if (process.env.HOME !== ${JSON.stringify(root)} || process.env.CLAUDE_CONFIG_DIR !== ${JSON.stringify(join(root, "signed-in"))}) process.exit(2);
if (!process.argv.includes('--no-session-persistence') || process.argv.includes('login')) process.exit(3);
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if(m.type!=='control_request' || m.request.subtype!=='initialize') process.exit(4);
  console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[
    {value:'opus',displayName:'Claude Opus fixture (1M)',resolvedModel:'claude-opus-fixture',supportedEffortLevels:['low','high','max'],defaultEffortLevel:'high'},
    {value:'sonnet',displayName:'Claude Sonnet fixture',supportsEffort:false},
    {value:'long',displayName:'x'.repeat(300)}
  ]}}}));
});`,
    { mode: 0o755 },
  );
  try {
    const models = await discoverClaudeModels({
      executable,
      project: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, "signed-in"),
      },
    });
    assert.deepEqual(models, [
      { id: "default", name: "Use native default" },
      {
        id: "opus",
        name: "Claude Opus fixture (1M)",
        resolvedModel: "claude-opus-fixture",
        effortLevels: [{ value: "low" }, { value: "high" }, { value: "max" }],
        defaultEffort: "high",
      },
      { id: "sonnet", name: "Claude Sonnet fixture", effortLevels: [] },
      { id: "long", name: "x".repeat(200) },
    ]);
    await writeFile(
      executable,
      `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}}));
});`,
      { mode: 0o755 },
    );
    await assert.rejects(
      discoverClaudeModels({
        executable,
        project: root,
        env: { PATH: process.env.PATH },
      }),
      /did not report/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Claude authentication survives catalog failure and timestamps completed evidence", async () => {
  let finished = 0;
  const status = await claudeAuthStatus({ loggedIn: true, authMethod: "oauth", apiProvider: "firstParty" }, async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    finished = Date.now();
    throw new Error("fixture discovery failed");
  });
  assert.equal(status.authenticated, true);
  assert.equal(status.models, undefined);
  assert.match(status.modelsError!, /unavailable/);
  assert(status.checkedAt >= finished);
});
