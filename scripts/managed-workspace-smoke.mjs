import "../runtime/environment.mjs";
// Real pinned runtime, production container boundaries, no model inference.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { containerArgs } from "../runtime/container.ts";
const prefix = "loop55-workspace-smoke-" + randomBytes(5).toString("hex");
const key = randomBytes(32).toString("hex");
const image = process.env.LOOP55_RUNTIME_IMAGE || "loop55-runtime:0.2";
const program = `
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {managedWorkspace, githubEnvironment} from '/runtime/workspace.mjs';
import {Rpc} from '/runtime/protocol.mjs';
const cwd=managedWorkspace(process.env.HOME, ${JSON.stringify(key)});
const child=spawn('codex',['app-server','--stdio','-c','shell_environment_policy.inherit="all"','-c','shell_environment_policy.ignore_default_excludes=true'],{
  cwd, env:{PATH:process.env.PATH,HOME:process.env.HOME,...githubEnvironment('fixture-ephemeral-github-token')},stdio:['pipe','pipe','pipe']
});
child.stderr.resume();
const rpc=new Rpc(child);
try {
  await rpc.call('initialize',{clientInfo:{name:'loop55_workspace_smoke',version:'1'}});
  rpc.send({method:'initialized',params:{}});
  const result=await rpc.call('command/exec',{
    cwd,sandboxPolicy:{type:'dangerFullAccess'},timeoutMs:20000,
    command:['node','--input-type=module','-e',${JSON.stringify(`
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
assert.equal(process.env.GH_TOKEN,'fixture-ephemeral-github-token');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']});
if(!existsSync('.git')) git('init');
const previous=existsSync('fixture.txt')?Number(readFileSync('fixture.txt','utf8')):0;
writeFileSync('fixture.txt',String(previous+1));
git('add','fixture.txt');
assert.match(git('diff','--cached','--name-only'),/fixture.txt/);
const credentials=execFileSync('git',['credential','fill'],{input:'protocol=https\\nhost=github.com\\n\\n',encoding:'utf8',stdio:['pipe','pipe','pipe']});
assert.ok(credentials.includes('password=fixture-ephemeral-github-token'));
for(const [bin,args] of [['gh',['--version']],['python3',['--version']],['make',['--version']],['g++',['--version']],['rg',['--version']]]) execFileSync(bin,args,{stdio:'pipe'});
assert.ok(!readFileSync('.git/config','utf8').includes(process.env.GH_TOKEN));
console.log(JSON.stringify({edits:previous+1,git:true,tools:true,ephemeralCredential:true}));
`)}]
  });
  assert.equal(result.exitCode,0,result.stderr);
  console.log(result.stdout.trim());
} finally {rpc.close(); child.kill();}
`;
try {
  for (const edits of [1, 2]) {
    const args = containerArgs(prefix, key, image, prefix + "-" + edits);
    args.splice(-2, 2, "node", "--input-type=module");
    const result = spawnSync("docker", args, {
      input: program,
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      edits,
      git: true,
      tools: true,
      ephemeralCredential: true,
    });
  }
  console.log(
    "PASS: real Codex command execution edits/tests a Git workspace across two production-isolated containers; native tools and per-process GitHub credential helper work, without model inference.",
  );
} finally {
  // Only the uniquely named smoke containers/volume created by this script.
  for (const n of [1, 2])
    spawnSync("docker", ["rm", "-f", prefix + "-" + n], { stdio: "ignore" });
  const removed = spawnSync("docker", ["volume", "rm", prefix + "-" + key], {
    encoding: "utf8",
  });
  assert.equal(removed.status, 0, removed.stderr);
}
