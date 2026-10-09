import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

test("paired runtime upgrade HTTP boundary fixes the executable, persists status and deduplicates reconnects", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "loop-upgrade-http-")));
  process.env.LOOP_DATA_DIR = join(dir, "data");
  const oldPath = process.env.PATH;
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "calls");
  const version = join(dir, "version");
  writeFileSync(version, "1.18.33");
  writeFileSync(
    join(bin, "opencode"),
    `#!/usr/bin/env node\nconst fs=require('node:fs');\nif(process.argv[2]==='--version') console.log(fs.readFileSync(${JSON.stringify(version)}, 'utf8'));\nelse if(process.argv[2]==='upgrade') { fs.appendFileSync(${JSON.stringify(calls)}, 'upgrade\\n'); fs.writeFileSync(${JSON.stringify(version)}, '1.18.40'); }\nelse process.exit(91);\n`,
    { mode: 0o755 },
  );
  // Any package-manager call would be recorded here and fail; npm cannot
  // reach a registry from this test.
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\necho npm >> ${JSON.stringify(calls)}\nexit 92\n`,
    { mode: 0o755 },
  );
  process.env.npm_config_offline = "true";
  process.env.npm_config_registry = "http://127.0.0.1:9/";
  process.env.PATH = bin + ":" + oldPath;
  const interruptedId = randomUUID();
  mkdirSync(process.env.LOOP_DATA_DIR!, { recursive:true });
  writeFileSync(join(process.env.LOOP_DATA_DIR!, 'harness-upgrades.json'), JSON.stringify({
    [interruptedId]: {commandId:interruptedId,name:'opencode',state:'unconfirmed',message:'Interrupted'},
  }));
  const { companion } = await import("../src/server/companion-routes.js");
  const { db } = await import("../src/server/db.js");
  const { harnessUpgrades } = await import("../src/server/harness-upgrades.js");
  const app = express();
  app.use(express.json(), companion);
  app.use(
    (
      e: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(e.status || (e.name === "ZodError" ? 400 : 500))
        .json({ error: e.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/workspace/runtimes/opencode/upgrade`;
  const post = (body: unknown, path = base) =>
    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const commandId = randomUUID();
  assert.equal((await fetch(base).then(r=>r.json())).upgrade.state,'unconfirmed');
  assert.equal((await post({confirmedStopped:false},base+'/recover')).status,400);
  assert.equal((await post({},base+'/recover')).status,400);
  assert.equal(harnessUpgrades.busy('opencode'),true);
  assert.equal((await post({confirmedStopped:true,commandId:randomUUID()},base+'/recover')).status,409);
  assert.equal((await post({confirmedStopped:true,commandId:interruptedId},base+'/recover')).status,200);
  assert.equal(harnessUpgrades.busy('opencode'),false);
  assert.equal(harnessUpgrades.operation('opencode',interruptedId)?.state,'failed');
  assert.equal(
    (await post({ commandId, executable: "/client/override" })).status,
    400,
  );
  assert.equal(
    (await post({ commandId }, base.replace("opencode", "acp"))).status,
    400,
  );
  assert.equal((await fetch(base).then((r) => r.json())).canUpgrade, true);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('busy','local-workspace','busy',1)",
  ).run();
  db.prepare(
    "INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES('busy','local-workspace','busy','prompt','running','busy',1,1)",
  ).run();
  const refused = await post({ commandId });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /active runs/);
  assert.equal(harnessUpgrades.busy("opencode"), false, "a refused request releases its hold");
  db.prepare("UPDATE runs SET state='completed' WHERE id='busy'").run();
  assert.equal((await post({ commandId })).status, 200);
  assert.equal((await post({ commandId })).status, 200);
  let state;
  const deadline = Date.now() + 5000;
  do {
    state = await fetch(base).then((r) => r.json());
    if (state.upgrade.state === "running")
      await new Promise((r) => setTimeout(r, 20));
  } while (state.upgrade.state === "running" && Date.now() < deadline);
  assert.equal(state.upgrade.state, "complete");
  assert.equal(state.upgrade.version, "1.18.40");
  assert.equal(state.upgrade.previous, "1.18.33");
  assert.match(state.upgrade.message, /Upgraded from 1\.18\.33 to 1\.18\.40/);
  assert(!JSON.stringify(state).includes(bin));
  // Clearing the outcome keeps its identity: a reconnecting client's retry
  // returns it instead of upgrading again.
  assert.equal((await fetch(base, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(base).then((r) => r.json())).upgrade, null);
  assert.equal((await post({ commandId }).then((r) => r.json())).upgrade.state, "complete");
  assert.equal(readFileSync(calls, "utf8"), "upgrade\n");
});
