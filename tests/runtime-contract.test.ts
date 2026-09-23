import { it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
const root = mkdtempSync(join(tmpdir(), "loop-runtime-contract-"));
const bin = join(root, "bin"); mkdirSync(bin);
// Explicit native-protocol fixtures. Never installed into a production image.
const fake = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');
const provider=path.basename(process.argv[1]), home=process.env.HOME, args=process.argv.slice(2);
const auth=path.join(home,'fixture-auth'), log=path.join(home,'calls');
fs.appendFileSync(log,JSON.stringify({provider,args,apiKey:process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY||process.env.CLAUDE_CODE_OAUTH_TOKEN||null})+'\\n');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const state=()=>fs.existsSync(auth)?fs.readFileSync(auth,'utf8'):'none';
const answer=(model)=>({kind:model==='tool'?'tool':'answer',text:model==='tool'?'':'Subscription fixture answer',tool:model==='tool'?'lookup':null,arguments:model==='tool'?'{"query":"fixture"}':'{}'});
if(provider==='codex') {
 rl.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.id==null)return;
  let result={};
  if(m.method==='account/read')result={account:state()==='none'?null:{type:state()==='api'?'apiKey':'chatgpt',planType:'plus'}};
  if(m.method==='account/login/start'){result={verificationUrl:'https://auth.openai.com/codex/device',userCode:'FIXTURE-123'};fs.writeFileSync(auth,'subscription');setTimeout(()=>send({method:'account/login/completed',params:{success:true}}),20);}
  if(m.method==='account/logout')fs.writeFileSync(auth,'none');
  if(m.method==='model/list')result={data:[{id:'fixture',model:'fixture',displayName:'Fixture subscription model'}],nextCursor:null};
  if(m.method==='thread/start'){global.model=m.params.model;result={thread:{id:'thread-fixture'}};}
  if(m.method==='turn/start'){
   if(!m.params.outputSchema)throw Error('Missing structured output');
   setTimeout(()=>{send({method:'item/agentMessage/delta',params:{delta:JSON.stringify(answer(global.model))}});send({method:'turn/completed',params:{turn:{status:global.model==='quota'?'failed':'completed'}}});},20);
  }
  send({id:m.id,result});
 });
} else if(args[0]==='auth') {
 if(args[1]==='status'){send({loggedIn:state()!=='none',authMethod:state()==='api'?'api_key':'claude.ai',subscriptionType:'max'});process.exit(state()==='none'?1:0);}
 if(args[1]==='logout'){fs.writeFileSync(auth,'none');process.exit(0);}
 if(args[1]==='login'){
  console.log('Open https://claude.ai/oauth/authorize?state=fixture');
  rl.createInterface({input:process.stdin}).on('line',code=>{if(code!=='fixture-code')process.exit(1);fs.writeFileSync(auth,'subscription');process.exit(0);});
 }
} else {
 const model=args[args.indexOf('--model')+1];let prompt='';
 if(args[args.indexOf('--tools')+1]!==''||!args.includes('--strict-mcp-config'))throw Error('Unsafe tools');
 process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{if(!prompt.includes('CONVERSATION'))throw Error('Missing history');send({type:'result',subtype:model==='quota'?'error_max_turns':'success',is_error:model==='quota',structured_output:answer(model),session_id:'claude-fixture'});});
}
`;
for (const name of ["codex", "claude"]) writeFileSync(join(bin,name),fake,{mode:0o755});
function invoke(provider:string, action:string, auth = "subscription", model = "fixture") {
  const home=mkdtempSync(join(root,"account-")); writeFileSync(join(home,"fixture-auth"),auth);
  const p=spawn(process.execPath,["runtime/entry.mjs"],{cwd:process.cwd(),env:{PATH:bin+":"+process.env.PATH,HOME:home,LOOP_RUNTIME_WORKDIR:home,OPENAI_API_KEY:"must-not-inherit",ANTHROPIC_API_KEY:"must-not-inherit",CLAUDE_CODE_OAUTH_TOKEN:"must-not-inherit"},stdio:["pipe","pipe","pipe"]});
  const events:any[]=[];let buffer="";p.stderr.resume();
  p.stdout.setEncoding("utf8");p.stdout.on("data",chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf("\n"))>=0){const event=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);events.push(event);if(event.login?.acceptsCode)p.stdin.write(JSON.stringify({code:"fixture-code"})+"\n");}});
  p.stdin.write(JSON.stringify({provider,action,input:{model,instructions:"Be clear",messages:[{role:"user",content:"Use my subscription"}],tools:[{name:"lookup",description:"Fixture",inputSchema:{type:"object"}}]}})+"\n");
  if(action!=="login")p.stdin.end();
  return new Promise<{code:number|null;events:any[];calls:any[]} >((resolve,reject)=>{
    const timer=setTimeout(()=>{p.kill();reject(new Error("Runtime contract timeout"));},5000);
    p.once("error",reject);p.once("close",code=>{clearTimeout(timer);resolve({code,events,calls:readFileSync(join(home,"calls"),"utf8").trim().split("\n").map(JSON.parse as any)});});
  });
}
afterAll(()=>rmSync(root,{recursive:true,force:true}));
for(const provider of ["codex","claude"]) {
  it(`${provider}: native login handshake, subscription identity and model discovery`,async()=>{
    const r=await invoke(provider,"login","none"); expect(r.code).toBe(0);
    expect(r.events.find(x=>x.login)?.login.url).toMatch(/^https:/);
    expect(r.events.at(-1).result).toMatchObject({authenticated:true,authMode:"subscription"});
    expect(r.events.at(-1).result.models.length).toBeGreaterThan(0);
    expect(r.calls.every(x=>x.apiKey===null)).toBe(true);
  });
  it(`${provider}: answers and typed tool requests pass through the official protocol`,async()=>{
    const r=await invoke(provider,"turn");expect(r.code).toBe(0);
    expect(r.events.some(x=>x.chunk?.text==="Subscription fixture answer")).toBe(true);
    expect(r.events.at(-1)).toEqual({done:true});
    const t=await invoke(provider,"turn","subscription","tool");
    expect(t.events.find(x=>x.chunk?.toolCall)?.chunk.toolCall).toMatchObject({name:"lookup",arguments:{query:"fixture"}});
  });
  it(`${provider}: refuses API-authenticated state and preserves quota failures without fallback`,async()=>{
    const api=await invoke(provider,"turn","api");expect(api.code).not.toBe(0);expect(api.events.some(x=>x.done)).toBe(false);
    const quota=await invoke(provider,"turn","subscription","quota");expect(quota.code).not.toBe(0);expect(quota.events.some(x=>x.done)).toBe(false);
    expect(quota.calls.every(x=>x.provider===provider&&x.apiKey===null)).toBe(true);
  });
}
it("rejects off-provider sign-in URLs and unauthorized tool names", async()=>{
  const path=resolve("runtime/protocol.mjs");const {authorizationUrl,resultChunks}=await import(path);
  expect(authorizationUrl("https://auth.openai.com.evil.test/device","codex")).toBeUndefined();
  expect(authorizationUrl("https://evil@claude.ai/authorize","claude")).toBeUndefined();
  expect(()=>resultChunks({kind:"tool",text:"",tool:"ungranted",arguments:"{}"},{tools:[]})).toThrow();
});
it("creates isolated containers without host credentials, sockets or privileged execution",async()=>{
  const path=resolve("runtime/container.mjs");const {containerArgs}=await import(path);
  const args=containerArgs("loop-test","a".repeat(64),"loop-runtime:0.2","test-operation");
  expect(args).toContain("--read-only");expect(args).toContain("--cap-drop=ALL");expect(args).toContain("--user=1000:1000");
  expect(args.join(" ")).not.toMatch(/docker.sock|--privileged|type=bind|API_KEY/);
  expect(()=>containerArgs("loop-test","../../escape","image","operation")).toThrow();
});
