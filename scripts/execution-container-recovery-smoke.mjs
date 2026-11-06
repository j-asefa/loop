// Isolated compiled-worker namespace recovery. No provider or tunnel is used.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const image = process.argv[2];
if (!image)
  throw new Error(
    "Usage: node scripts/execution-container-recovery-smoke.mjs IMAGE [COMPILED_DIST]",
  );
const suffix = randomUUID().slice(0, 8),
  name = `loop-execution-recovery-${suffix}`,
  volume = `${name}-data`;
const docker = (args) => {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `docker ${args[0]} failed: ${result.error?.message || result.stderr}`,
    );
  return (result.stdout + (args[0] === "logs" ? result.stderr : "")).trim();
};
const mounted = [
  "--mount",
  `type=volume,src=${volume},dst=/data`,
  ...(process.argv[3]
    ? [
        "--mount",
        `type=bind,src=${resolve(process.argv[3])},dst=/app/dist,readonly`,
      ]
    : []),
];
const parent = `
  import {fork} from 'node:child_process';
  import {randomUUID} from 'node:crypto';
  import Database from 'better-sqlite3';
  import {readlinkSync,existsSync,mkdirSync} from 'node:fs';
  import {recordOwnedProcesses,own} from '/app/dist/processes.js';
  console.log('NAMESPACE '+readlinkSync('/proc/self/ns/pid'));
  mkdirSync('/data/workspace',{recursive:true,mode:0o700});
  recordOwnedProcesses('/data/workspace/children.json');
  const child=fork('/app/dist/server/execution-worker.js',[],{execArgv:[],detached:true,stdio:['ignore','inherit','inherit','ipc']});
  own(child);
  let db;
  child.on('message', m=>{
    if(m.type==='ready') {
      db=new Database('/data/workspace/loop.db');
      const prior=db.prepare("SELECT state FROM runs WHERE id='retained'").get();
      if(!prior) {
        db.prepare("INSERT INTO runs(id,owner_id,kind,input,state,idempotency_key,created_at,updated_at) VALUES('retained','local-workspace','agent','fixture','running','retained',1,1)").run();
        db.prepare("INSERT INTO native_dispatch(run_id,generation,digest,state,created_at) VALUES('retained',?,'digest','running',1)").run(m.ready.generation);
      }
      console.log('READY '+JSON.stringify({generation:m.ready.generation}));
      if(prior) child.send({type:'lifecycle',action:'schedule',generation:m.ready.generation,requestId:randomUUID()});
    }
    if(m.type==='ack') console.log('RECOVERED '+db.prepare("SELECT state FROM runs WHERE id='retained'").get().state);
  });
  child.on('exit', code=>{
    if(existsSync('/data/hold-parent')) setInterval(()=>{},1000);
    else process.exit(code ?? 1);
  });
  process.on('SIGTERM',()=>child.disconnect());
`;
const until = async (predicate) => {
  const deadline = Date.now() + 25_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(
        "Container recovery timed out: " + docker(["logs", name]),
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const ready = () =>
  docker(["logs", name])
    .split("\n")
    .filter((line) => line.startsWith("READY "))
    .map((line) => JSON.parse(line.slice(6)));
try {
  docker(["volume", "create", volume]);
  docker([
    "create",
    "--name",
    name,
    "--init",
    "--network",
    "none",
    ...mounted,
    "--env",
    "LOOP_DATA_DIR=/data/workspace",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    parent,
  ]);
  docker(["start", name]);
  await until(() => ready().length === 1);
  const generation = ready()[0].generation;
  docker(["kill", name]);
  assert.equal(
    docker(["inspect", "--format", "{{.State.Running}}", name]),
    "false",
    "operator confirms the old container has stopped",
  );
  docker(["start", name]);
  assert.equal(
    docker(["wait", name]),
    "1",
    "unclean namespace replacement refuses automatic takeover",
  );
  assert.match(docker(["logs", name]), /another PID namespace/);
  const cli = (args) =>
    docker([
      "run",
      "--rm",
      "--network",
      "none",
      ...mounted,
      "--env",
      "LOOP_HOME=/data",
      "--entrypoint",
      "node",
      image,
      "/app/dist/cli.js",
      "recover-execution",
      ...args,
    ]);
  assert.match(cli([]), new RegExp(generation));
  assert.match(cli(["--stopped-generation", generation]), /archived/);
  docker(["start", name]);
  await until(
    () =>
      ready().length === 2 &&
      docker(["logs", name]).includes("RECOVERED interrupted"),
  );
  assert.notEqual(ready()[1].generation, generation);
  docker([
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    "import{writeFileSync,readFileSync}from'node:fs';writeFileSync('/data/hold-parent','1');process.kill(JSON.parse(readFileSync('/data/workspace/execution/owner.json')).pid,'SIGSTOP')",
  ]);
  assert.equal(
    JSON.parse(
      docker([
        "exec",
        "--env",
        "LOOP_HOME=/data",
        "--env",
        "LOOP_TEST_STOP_GRACE_MS=200",
        name,
        "node",
        "/app/dist/cli.js",
        "stop",
        "--json",
      ]),
    ).stopped,
    true,
  );
  docker([
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    "import{existsSync,unlinkSync}from'node:fs';if(existsSync('/data/workspace/execution/owner.json'))throw Error('Owner was not retired');unlinkSync('/data/hold-parent')",
  ]);
  docker(["kill", name]);
  docker(["start", name]);
  await until(() => ready().length === 3);
  assert.notEqual(ready()[2].generation, ready()[1].generation);
  console.log(
    "PASS: actual Docker SIGKILL/restart retains foreign-namespace refusal; confirmed stopped-generation recovery interrupts retained work without replay; verified forced stop retires ownership and the next container starts without manual recovery.",
  );
} catch (error) {
  try {
    console.error(docker(["logs", name]));
  } catch {
    /* no fixture container */
  }
  throw error;
} finally {
  try {
    docker(["rm", "-f", name]);
  } catch {
    /* fixture may not have been created */
  }
  docker(["volume", "rm", volume]);
}
