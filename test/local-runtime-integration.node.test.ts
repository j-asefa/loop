import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile, symlink } from "node:fs/promises";
import { createRequire } from 'node:module';
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LocalRuntime } from "../src/local-runtime.js";

test("native launcher provisions a real mTLS worker, isolated HAPI identity and provider connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-managed-integration-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "package.json"),
    JSON.stringify({ type: "commonjs" }),
  );
  const project = join(root, "project with spaces");
  await mkdir(project);
  const hapi = join(bin, "hapi");
  await writeFile(
    hapi,
    `#!/usr/bin/env node
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
if(process.argv[2]==='hub') {
 const server=http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify(q.url==='/api/auth'?{token:'fixture-private-token'}:{machines:[{id:'fixture-machine',active:true}]}));});
 server.listen(Number(process.env.HAPI_LISTEN_PORT),'127.0.0.1');
} else {
 const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000)",path.join(process.env.LOOP_PROJECT_ROOT,'session.pid')],{detached:process.env.LOOP_MANAGED!=='1',stdio:'ignore'});
 fs.mkdirSync(process.env.HAPI_HOME,{recursive:true});
 fs.writeFileSync(path.join(process.env.HAPI_HOME,'settings.json'),JSON.stringify({machineId:'fixture-machine'}));
 setInterval(()=>{},1000);
}
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "claude"),
    `#!/usr/bin/env node
if(!process.argv.includes('--version') && (process.env.CLI_API_TOKEN || Object.keys(process.env).some(key => key.startsWith("LOOP_") && key !== "LOOP_SESSION_TOKEN"))) throw new Error('Coordinator credential leaked to provider');
if(process.argv.includes('--version'))console.log('2.1.282');
else if(process.argv.includes('auth')) console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));
else require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.type!=='control_request'||m.request.subtype!=='initialize') process.exit(2);
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'opus',displayName:'Claude Opus fixture',supportedEffortLevels:['high','max']}]}}}));
});
`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  // A fixture shared Codex server keeps its startup version while a fake brew
  // updates the executable's version, exercising the real runner upgrade route.
  const codex = join(root, 'Cellar/codex/0.157.0/bin/codex');
  const codexVersion = join(root,'codex-version');
  const serverVersion = join(root,'server-version');
  await mkdir(join(codex,'..'),{recursive:true});
  await writeFile(codexVersion,'0.157.0');
  await writeFile(codex, `#!/usr/bin/env node
const fs=require('node:fs');
const version=fs.readFileSync(${JSON.stringify(codexVersion)},'utf8');
if(process.argv.includes('--version')) console.log(version);
else {
 fs.writeFileSync(${JSON.stringify(serverVersion)},version);
 const {WebSocketServer}=require(${JSON.stringify(createRequire(import.meta.url).resolve('ws'))});
 const port=Number(new URL(process.argv[process.argv.indexOf('--listen')+1]).port);
 const server=new WebSocketServer({port,host:'127.0.0.1'});
 server.on('connection',socket=>socket.on('message',raw=>{
   const m=JSON.parse(raw); if(!m.id)return;
   const result=m.method==='account/read'?{account:{type:'chatgpt'}}:m.method==='config/read'?{config:{forced_login_method:'chatgpt',model_provider:'openai'}}:m.method==='model/list'?{data:[{id:'fixture',model:'fixture'}]}:{};
   socket.send(JSON.stringify({id:m.id,result}));
 }));
}
`,{mode:0o755});
  await symlink(codex,join(bin,'codex'));
  await writeFile(join(bin,'brew'),`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(codexVersion)},'0.160.0');\n`,{mode:0o755});
  process.env.PATH = bin + ":" + oldPath;
  process.env.LOOP_PROFILE = "companion";
  process.env.LOOP_DATA_DIR = join(root, "data");
  process.env.LOOP_MEMORY_ENABLED = "0";
  const runtime = new LocalRuntime(
    root,
    { providers: ["codex", "claude", "opencode"], execution: "native", project },
    async () => hapi,
    async () => {
      throw new Error("fixture guarded build failed");
    },
  );
  try {
    await runtime.prepare();
    const { readdir } = await import("node:fs/promises");
    const nativeDir = (await readdir(join(root, "managed"))).find((name) =>
      name.startsWith("native-"),
    )!;
    const settings = JSON.parse(
      await readFile(join(root, "managed", nativeDir, "worker.json"), "utf8"),
    );
    assert.deepEqual(settings.providers, ["codex", "claude"]);
    const result = await runtime.start();
    assert.match(result.billing.description, /native execution/);
    assert.match(result.billing.description, /^codex \+ claude · native execution/);
    assert.doesNotMatch(result.billing.description, /opencode/);
    assert.ok(Number(await readFile(join(project, "session.pid"), "utf8")) > 0);
    const { db } = await import("../src/server/db.js");
    const environment = db
      .prepare(
        "SELECT e.*,h.url FROM execution_environments e JOIN runtime_hosts h ON h.id=e.host_id",
      )
      .get() as any;
    assert.equal(environment.state, "online");
    assert.equal(environment.capacity, 32);
    assert.match(environment.instance_id, /^local-/);
    assert.match(environment.url, /^https:\/\/127.0.0.1:/);
    const connection = db
      .prepare("SELECT * FROM connections WHERE provider='anthropic'")
      .get() as any;
    assert.equal(
      JSON.parse(connection.metadata).environmentId,
      environment.host_id,
    );
    assert.equal(connection.status, "connected");
    assert.equal(
      (
        db
          .prepare("SELECT canonical_path FROM environment_projects")
          .get() as any
      ).canonical_path,
      project,
    );
    const { workerRequest, environment: resolveEnvironment } = await import("../src/server/hapi/environments.js");
    const controlledEnvironment = resolveEnvironment(environment.owner_id, environment.host_id);
    const upgradeStatus = await workerRequest(controlledEnvironment, "/runtime/upgrade/status", {
      flavor: "claude", generation: environment.generation,
    });
    assert.equal(upgradeStatus.upgrade, null);
    assert.equal(upgradeStatus.canUpgrade, false, "custom fixture installation must not be replaced");
    await assert.rejects(workerRequest(controlledEnvironment, "/runtime/upgrade", {
      flavor: "claude", generation: environment.generation + 1, commandId: randomUUID(),
    }), /could not be verified/);
    const commandId = randomUUID();
    await workerRequest(controlledEnvironment,'/runtime/upgrade',{
      flavor:'codex',generation:environment.generation,commandId,
    });
    let codexUpgrade: any;
    const deadline = Date.now()+5000;
    do {
      codexUpgrade = await workerRequest(controlledEnvironment,'/runtime/upgrade/status',{
        flavor:'codex',generation:environment.generation,
      });
      if(codexUpgrade.upgrade.state === 'running') await new Promise(r=>setTimeout(r,20));
    } while(codexUpgrade.upgrade.state === 'running' && Date.now()<deadline);
    assert.equal(codexUpgrade.upgrade.state,'restart-required');
    assert.equal(await readFile(serverVersion,'utf8'),'0.157.0','running shared server is still the old version');
    assert.equal(await readFile(codexVersion,'utf8'),'0.160.0');
    assert.deepEqual(await workerRequest(controlledEnvironment,'/prepare',{
      flavor:'codex',generation:environment.generation,launchId:randomUUID(),
    }),{deferred:'runtime-maintenance'});
    const status = await workerRequest(controlledEnvironment,'/status');
    assert.deepEqual(status.maintenance,['codex']);
    assert.equal((await workerRequest(controlledEnvironment,'/runtime/upgrade',{
      flavor:'codex',generation:environment.generation,commandId,
    })).upgrade.state,'restart-required','reconnect does not re-run the installer');
    await assert.rejects(workerRequest(controlledEnvironment, "/runtime/upgrade", {
      flavor: "claude", generation: environment.generation, commandId: randomUUID(),
    }), /could not be verified/);
    // A client lacking this workspace's TLS identity cannot reach control APIs.
    await assert.rejects(fetch(environment.url + "/status"));
  } finally {
    const pid = Number(
      await readFile(join(project, "session.pid"), "utf8").catch(() => "0"),
    );
    await runtime.close();
    // A TERM-resistant session must not outlive the supervisor's exit.
    const deadline = Date.now() + 3000;
    let alive = pid > 0;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        if (process.platform === "linux") {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8");
          alive = !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
        }
      } catch {
        alive = false;
      }
      if (alive) await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(alive, false, "managed HAPI session survived shutdown");
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed sole native runtime rejects preparation before starting HAPI", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-unavailable-runtime-"));
  let hapiBuilds = 0;
  const runtime = new LocalRuntime(
    root,
    { providers: ["opencode"], execution: "native", project: root },
    async () => { hapiBuilds++; throw new Error("must not build HAPI"); },
    async () => { throw new Error("fixture guarded build failed"); },
  );
  try {
    await assert.rejects(runtime.prepare(), /No supported harness is installed/);
    assert.equal(hapiBuilds, 0);
    const { readdir } = await import("node:fs/promises");
    assert.equal((await readdir(join(root, "managed"))).some((name) => name.startsWith("native-")), false);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable native runtime retains Docker execution without an empty native worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-docker-runtime-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ":" + oldPath;
  const runtime = new LocalRuntime(
    root,
    { providers: ["opencode"], execution: "both", project: root },
    async () => "/fixture/hapi",
    async () => { throw new Error("fixture guarded build failed"); },
  );
  try {
    await runtime.prepare();
    const { readdir } = await import("node:fs/promises");
    const directories = await readdir(join(root, "managed"));
    assert.equal(directories.some((name) => name.startsWith("native-")), false);
    const docker = directories.find((name) => name.startsWith("docker-"))!;
    const settings = JSON.parse(await readFile(join(root, "managed", docker, "worker.json"), "utf8"));
    assert.deepEqual(settings.providers, ["opencode"]);
  } finally {
    await runtime.close();
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

 for (const bakedArtifact of [true, false]) test(`uses guarded OpenCode with ${bakedArtifact ? "a baked artifact and no PATH installation" : "an outdated PATH installation"}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-baked-opencode-"));
  const oldBaked = process.env.LOOP_BAKED_OPENCODE;
  const oldPath = process.env.PATH;
  if (bakedArtifact) process.env.LOOP_BAKED_OPENCODE = "/fixture/baked";
  else {
    delete process.env.LOOP_BAKED_OPENCODE;
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "opencode"), "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
    process.env.PATH = bin + ":" + oldPath;
  }
  let builds = 0;
  const runtime = new LocalRuntime(root, { providers: ["opencode"], execution: "native", project: root },
    async () => "/fixture/hapi", async (_root: string, _unused: unknown, baked: string | undefined) => {
      builds++;
      assert.equal(baked, bakedArtifact ? "/fixture/baked" : undefined);
      return "/fixture/guarded-opencode";
    });
  try {
    await runtime.prepare();
    assert.equal(builds, 1);
    const { readdir } = await import("node:fs/promises");
    const native = (await readdir(join(root, "managed"))).find(name => name.startsWith("native-"))!;
    const settings = JSON.parse(await readFile(join(root, "managed", native, "worker.json"), "utf8"));
    assert.deepEqual(settings.providers, ["opencode"]);
  } finally {
    await runtime.close();
    process.env.PATH = oldPath;
    if (oldBaked === undefined) delete process.env.LOOP_BAKED_OPENCODE;
    else process.env.LOOP_BAKED_OPENCODE = oldBaked;
    await rm(root, { recursive: true, force: true });
  }
});
