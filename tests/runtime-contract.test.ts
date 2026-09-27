import { it, expect, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
const root = mkdtempSync(join(tmpdir(), "loop-runtime-contract-"));
const bin = join(root, "bin");
mkdirSync(bin);
// Explicit native-protocol fixtures. Never installed into a production image.
const fake = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');
const provider=path.basename(process.argv[1]), home=process.env.HOME, args=process.argv.slice(2);
const auth=path.join(home,'fixture-auth'), log=path.join(home,'calls');
fs.appendFileSync(log,JSON.stringify({provider,args,native:process.env.LOOP_RUNTIME_MODE==='host',cwd:process.cwd(),toolToken:process.env.FIXTURE_MCP_TOKEN||null,githubToken:process.env.GH_TOKEN||null,apiKey:process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY||process.env.CLAUDE_CODE_OAUTH_TOKEN||null})+'\\n');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const state=()=>fs.existsSync(auth)?fs.readFileSync(auth,'utf8'):'none';
const answer=(model)=>{
 let text='Subscription fixture answer';
 if(model==='credential')text=process.env.GH_TOKEN;
 if(model==='workspace') {const file=path.join(process.cwd(),'checkout.txt');const n=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8'))+1:1;fs.writeFileSync(file,String(n));text='Workspace edit '+n;}
 return {kind:model==='tool'?'tool':'answer',text:model==='tool'?'':text,tool:model==='tool'?'lookup':null,arguments:model==='tool'?'{"query":"fixture"}':'{}'};
};
const formatted=(model)=>{
 send({type:'assistant',message:{id:'format-message',content:[{type:'tool_use',id:'format',name:'StructuredOutput',input:answer(model)}]}});
 send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'format',content:'Structured output provided successfully'}]}});
};
const credentialTrace=()=>{
 if(provider==='codex')send({method:'item/completed',params:{item:{id:'credential-trace',type:'commandExecution',aggregatedOutput:'x'.repeat(11990)+process.env.GH_TOKEN}}});
 else send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'credential-trace',content:'x'.repeat(11990)+process.env.GH_TOKEN}]}});
};
if(provider==='codex') {
 rl.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({rpc:m})+'\\n');if(m.id==null)return;
  let result={};
  if(m.method==='account/read')result={account:state()==='none'?null:{type:state()==='api'?'apiKey':'chatgpt',planType:'plus'}};
  if(m.method==='account/login/start'){result={verificationUrl:'https://auth.openai.com/codex/device',userCode:'FIXTURE-123'};fs.writeFileSync(auth,'subscription');setTimeout(()=>send({method:'account/login/completed',params:{success:true}}),20);}
  if(m.method==='skills/list')result={data:[{skills:[{name:'fixture-skill',path:'/fixture/SKILL.md',description:'Fixture skill',enabled:true}]}]};
  if(m.method==='account/logout')fs.writeFileSync(auth,'none');
  if(m.method==='model/list')result={data:[{id:'fixture',model:'fixture',displayName:'Fixture subscription model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'xhigh',description:'Deep work'}],defaultReasoningEffort:'low'}],nextCursor:null};
  if(m.method==='thread/start'){global.model=m.params.model;result={thread:{id:'thread-fixture'}};}
  if(m.method==='review/start'){result={turn:{id:'review-fixture'}};setTimeout(()=>{send({method:'item/completed',params:{threadId:'thread-fixture',turnId:'review-fixture',item:{type:'exitedReviewMode',review:'Native review result'}}});send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'review-fixture',status:'completed'}}});},20);}
  if(m.method==='turn/start'){
   if(!m.params.outputSchema)throw Error('Missing structured output');
   if(global.model==='steering'){send({id:m.id,result:{turn:{id:'active-fixture'}}});return;}
   if(global.model==='credential')credentialTrace();
   setTimeout(()=>{send({method:'item/agentMessage/delta',params:{delta:JSON.stringify(answer(global.model))}});send({method:'turn/completed',params:{turn:{status:global.model==='quota'?'failed':'completed',error:global.model==='quota'?{message:'Usage limit reached; '+(process.env.GH_TOKEN||''),codexErrorInfo:'usage_limit'}:undefined}}});},global.model==='slow'?100:20);
  }
  if(m.method==='turn/steer') {
   if(m.params.expectedTurnId!=='active-fixture')throw Error('Wrong active turn');
   result={turnId:'active-fixture'};
   setTimeout(()=>{send({method:'item/agentMessage/delta',params:{delta:JSON.stringify({...answer(global.model),text:m.params.input[0].text})}});send({method:'turn/completed',params:{turn:{id:'active-fixture',status:'completed'}}});},20);
  }
  send({id:m.id,result});
 });
} else if(args[0]==='auth') {
 if(args[1]==='status'){send({loggedIn:state()!=='none',authMethod:state()==='api'?'api_key':'claude.ai',subscriptionType:'max'});process.exit(state()==='none'?1:0);}
 if(args[1]==='logout'){fs.writeFileSync(auth,'none');process.exit(0);}
 if(args[1]==='login'){
  process.stdout.write('Open https://claude.com/cai/oauth/authorize?state=fi');
  setTimeout(()=>process.stdout.write('xture&code_challenge=fixture-challenge\\nPaste code here if prompted > '),100);
  rl.createInterface({input:process.stdin}).on('line',code=>{if(code!=='fixture-code')process.exit(1);fs.writeFileSync(auth,'subscription');process.exit(0);});
 }
} else if(args.includes('--input-format')) {
 const modeFile=path.join(home,'fixture-catalog-mode');
 const mode=fs.existsSync(modeFile)?fs.readFileSync(modeFile,'utf8'):'';
 if(mode==='exit')process.exit(1);
 rl.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({control:m})+'\\n');
  if(m.type==='user'){const model=args[args.indexOf('--model')+1];fs.appendFileSync(log,JSON.stringify({prompt:m.message.content})+'\\n');if(model==='steering'&&!global.followed){global.followed=true;return;}send({type:'result',subtype:'success',structured_output:model==='steering'?{...answer(model),text:m.message.content}:answer(model),session_id:'claude-fixture'});return}
  if(m.request?.subtype==='interrupt')send({type:'result',subtype:'interrupted',is_error:true});
  if(mode==='timeout')return;
  const catalog={models:[{value:'fixture',displayName:'Fixture Claude',resolvedModel:'claude-opus-5-5',supportedEffortLevels:['low','max']}],commands:[{name:'fixture-command',description:'Fixture command',argumentHint:'task'},{name:'compact',description:'Compact history'}]};
  if(mode==='missing-models')delete catalog.models;
  if(mode==='empty-models')catalog.models=[];
  if(mode==='missing-commands')delete catalog.commands;
  send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:catalog}});
 });
} else {
 const model=args[args.indexOf('--model')+1];let prompt='';
 if(args.includes('--tools')||args.includes('--strict-mcp-config')||!args.includes('bypassPermissions'))throw Error('Native tools are restricted');
 process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{fs.appendFileSync(log,JSON.stringify({prompt})+'\\n');if(!prompt.includes('CONVERSATION')&&!args.includes('--append-system-prompt'))throw Error('Missing history');if(model==='credential')credentialTrace();setTimeout(()=>{if(model!=='workspace')formatted(model);send({type:'result',subtype:model==='quota'?'error_max_turns':'success',is_error:model==='quota',errors:model==='quota'?['Maximum turns reached; '+(process.env.GH_TOKEN||'')]:undefined,structured_output:answer(model),session_id:'claude-fixture'});},model==='slow'?100:0);});
}
`;
for (const name of ["codex", "claude"])
  writeFileSync(join(bin, name), fake, { mode: 0o755 });
function invoke(
  provider: string,
  action: string,
  auth = "subscription",
  model = "fixture",
  native = false,
  prompt = "Use my subscription",
  history: { role: string; content: string }[] = [],
  workspace: {
    home?: string;
    key?: string;
    githubToken?: string;
    fastClock?: boolean;
    effort?: string;
    catalogMode?: string;
    steering?: string;
  } = {},
) {
  const home = workspace.home || mkdtempSync(join(root, "account-"));
  writeFileSync(join(home, "fixture-auth"), auth);
  writeFileSync(join(home, "calls"), "");
  if (workspace.catalogMode)
    writeFileSync(join(home, "fixture-catalog-mode"), workspace.catalogMode);
  const p = spawn(
    process.execPath,
    [
      ...(workspace.fastClock
        ? ["--import", resolve("tests/helpers/fast-runtime-clock.mjs")]
        : []),
      "runtime/entry.mjs",
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: bin + ":" + process.env.PATH,
        HOME: home,
        LOOP_RUNTIME_MODE: native ? "host" : "container",
        FIXTURE_MCP_TOKEN: "host-tool-credential",
        LOOP_RUNTIME_WORKDIR: home,
        OPENAI_API_KEY: "must-not-inherit",
        ANTHROPIC_API_KEY: "must-not-inherit",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-inherit",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const events: any[] = [];
  let buffer = "";
  p.stderr.resume();
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const event = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      events.push(event);
      if (event.login?.acceptsCode)
        p.stdin.write(JSON.stringify({ code: "fixture-code" }) + "\n");
      if (event.steeringReady && workspace.steering)
        p.stdin.write(
          JSON.stringify({
            action: "steer",
            id: "followup-fixture",
            text: workspace.steering,
          }) + "\n",
        );
    }
  });
  p.stdin.write(
    JSON.stringify({
      provider,
      action,
      githubToken: workspace.githubToken,
      input: {
        workspaceKey: workspace.key,
        model,
        effort: workspace.effort,
        controlId: workspace.steering ? "steering-fixture" : undefined,
        instructions: "Be clear",
        messages: [...history, { role: "user", content: prompt }],
        tools: [
          {
            name: "lookup",
            description: "Fixture",
            inputSchema: { type: "object" },
          },
        ],
      },
    }) + "\n",
  );
  if (action !== "login" && !workspace.steering) p.stdin.end();
  return new Promise<{
    code: number | null;
    events: any[];
    calls: any[];
    home: string;
  }>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        p.kill();
        reject(new Error("Runtime contract timeout"));
      },
      workspace.catalogMode === "timeout" ? 25000 : 5000,
    );
    p.once("error", reject);
    p.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        events,
        home,
        calls: readFileSync(join(home, "calls"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse as any),
      });
    });
  });
}
afterAll(() => rmSync(root, { recursive: true, force: true }));
it.each(["codex", "claude"])(
  "%s delivers live input before the initial turn finishes",
  async (provider) => {
    const result = await invoke(
      provider,
      "turn",
      "subscription",
      "steering",
      false,
      "Keep working until I send a follow-up",
      [],
      { steering: "Focus on the local tests" },
    );
    expect(result.code).toBe(0);
    expect(result.events).toContainEqual({
      steeringResult: { id: "followup-fixture", accepted: true },
    });
    expect(result.events).toContainEqual({
      chunk: { text: "Focus on the local tests" },
    });
    expect(result.events.filter((event) => event.done)).toHaveLength(1);
    if (provider === "codex") {
      expect(
        result.calls.filter((call) => call.rpc?.method === "turn/start"),
      ).toHaveLength(1);
      expect(
        result.calls.find((call) => call.rpc?.method === "turn/steer").rpc
          .params.expectedTurnId,
      ).toBe("active-fixture");
    } else {
      expect(
        result.calls.filter(
          (call) => call.control?.request?.subtype === "interrupt",
        ),
      ).toHaveLength(1);
      expect(result.calls.filter((call) => call.prompt)).toHaveLength(2);
    }
  },
);
it.each([
  "exit",
  "timeout",
  "missing-models",
  "empty-models",
  "missing-commands",
])(
  "Claude status remains connected when catalog discovery has %s",
  async (catalogMode) => {
    const result = await invoke(
      "claude",
      "status",
      "subscription",
      "fixture",
      false,
      "",
      [],
      { catalogMode },
    );
    expect(result.code).toBe(0);
    const status = result.events.at(-1).result;
    expect(status).toMatchObject({
      authenticated: true,
      authMode: "subscription",
    });
    if (catalogMode === "missing-commands") {
      expect(status.models[0]).toMatchObject({
        id: "fixture",
        resolvedModel: "claude-opus-5-5",
        effortLevels: [{ value: "low" }, { value: "max" }],
      });
    } else {
      expect(status.models.map((model: any) => model.id)).toEqual([
        "sonnet",
        "opus",
        "haiku",
      ]);
      expect(
        status.models.every((model: any) => model.effortLevels === undefined),
      ).toBe(true);
    }
    expect(result.calls.some((call) => call.prompt)).toBe(false);
  },
  30000,
);
it("Claude login succeeds despite discovery failure, while command discovery still reports unavailable", async () => {
  const login = await invoke(
    "claude",
    "login",
    "none",
    "fixture",
    false,
    "",
    [],
    { catalogMode: "exit" },
  );
  expect(login.code).toBe(0);
  expect(login.events.at(-1).result).toMatchObject({
    authenticated: true,
    models: expect.arrayContaining([expect.objectContaining({ id: "sonnet" })]),
  });
  const commands = await invoke(
    "claude",
    "capabilities",
    "subscription",
    "fixture",
    false,
    "",
    [],
    { catalogMode: "missing-commands" },
  );
  expect(commands.code).toBe(1);
  expect(commands.events.at(-1).error).toBeTruthy();
  const unauthenticated = await invoke(
    "claude",
    "status",
    "none",
    "fixture",
    false,
    "",
    [],
    { catalogMode: "exit" },
  );
  expect(unauthenticated.events.at(-1).result).toMatchObject({
    authenticated: false,
    models: [],
  });
  expect(
    unauthenticated.calls.some((call) => call.args?.includes("--input-format")),
  ).toBe(false);
});
for (const provider of ["codex", "claude"]) {
  it(`${provider}: survives the former runtime kill deadline`, async () => {
    const result = await invoke(
      provider,
      "turn",
      "subscription",
      "slow",
      false,
      "Wait for long-running work",
      [],
      { fastClock: true },
    );
    expect(result.code).toBe(0);
    expect(result.events).toContainEqual({ done: true });
    expect(result.events).toContainEqual({
      chunk: { text: "Subscription fixture answer" },
    });
  });
  it(`${provider}: native login handshake, subscription identity and model discovery`, async () => {
    const r = await invoke(provider, "login", "none");
    expect(r.code).toBe(0);
    expect(r.events.find((x) => x.login)?.login.url).toMatch(/^https:/);
    if (provider === "claude")
      expect(r.events.find((x) => x.login)?.login.url).toBe(
        "https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=fixture-challenge",
      );
    expect(r.events.at(-1).result).toMatchObject({
      authenticated: true,
      authMode: "subscription",
    });
    expect(r.events.at(-1).result.models[0].effortLevels).toEqual(
      provider === "codex"
        ? [{ value: "low" }, { value: "xhigh", description: "Deep work" }]
        : [{ value: "low" }, { value: "max" }],
    );
    expect(r.calls.filter((x) => x.args).every((x) => x.apiKey === null)).toBe(
      true,
    );
  });
  it(`${provider}: forwards selected effort unchanged to the official runtime`, async () => {
    const r = await invoke(
      provider,
      "turn",
      "subscription",
      "fixture",
      true,
      "Check the work",
      [],
      { effort: "xhigh" },
    );
    expect(r.code).toBe(0);
    if (provider === "codex")
      expect(
        r.calls.find((c) => c.rpc?.method === "turn/start").rpc.params
          .reasoningEffort,
      ).toBe("xhigh");
    else {
      const args = r.calls.find((c) => c.args?.includes("--model")).args;
      expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
    }
  });
  it(`${provider}: answers and typed tool requests pass through the official protocol`, async () => {
    const r = await invoke(provider, "turn");
    expect(r.code).toBe(0);
    expect(
      r.events.some((x) => x.chunk?.text === "Subscription fixture answer"),
    ).toBe(true);
    expect(r.events.at(-1)).toEqual({ done: true });
    expect(r.events.filter((x) => x.chunk?.trace)).toEqual([]);
    const t = await invoke(provider, "turn", "subscription", "tool");
    expect(
      t.events.find((x) => x.chunk?.toolCall)?.chunk.toolCall,
    ).toMatchObject({ name: "lookup", arguments: { query: "fixture" } });
    expect(t.events.filter((x) => x.chunk?.trace)).toEqual([]);
  });
  it(`${provider}: refuses API-authenticated state and preserves quota failures without fallback`, async () => {
    const api = await invoke(provider, "turn", "api");
    expect(api.code).not.toBe(0);
    expect(api.events.some((x) => x.done)).toBe(false);
    const quota = await invoke(provider, "turn", "subscription", "quota");
    expect(quota.code).not.toBe(0);
    expect(quota.events.some((x) => x.done)).toBe(false);
    expect(quota.events.find((x) => x.error)).toMatchObject({
      code: "runtime_failure",
      error: expect.stringContaining(
        provider === "codex" ? "Usage limit reached" : "Maximum turns reached",
      ),
    });
    expect(
      quota.calls
        .filter((x) => x.args)
        .every((x) => x.provider === provider && x.apiKey === null),
    ).toBe(true);
  });
}
for (const provider of ["codex", "claude"]) {
  it(`${provider}: redacts native credentials before clipping traces and returning answers`, async () => {
    const secret = "smokesecret-native-github";
    const run = await invoke(
      provider,
      "turn",
      "subscription",
      "credential",
      false,
      "Check repository",
      [],
      { githubToken: secret },
    );
    expect(run.code).toBe(0);
    expect(run.events).toContainEqual({ chunk: { text: "[redacted]" } });
    expect(run.events.some((e) => e.chunk?.trace)).toBe(true);
    expect(JSON.stringify(run.events)).not.toContain(secret.slice(0, 6));
  });
  it(`${provider}: managed native tools edit a persistent per-agent workspace`, async () => {
    const key = "a".repeat(64);
    const first = await invoke(
      provider,
      "turn",
      "subscription",
      "workspace",
      false,
      "Edit a file",
      [],
      { key, githubToken: "fixture-github-token" },
    );
    expect(first.code).toBe(0);
    expect(first.events).toContainEqual({
      chunk: { text: "Workspace edit 1" },
    });
    const cwd = realpathSync(join(first.home, "workspaces", key));
    expect(
      first.calls
        .filter((c) => c.args)
        .every(
          (c) =>
            c.cwd === cwd &&
            c.apiKey === null &&
            c.toolToken === null &&
            c.githubToken === "fixture-github-token",
        ),
    ).toBe(true);
    const args = first.calls.filter((c) => c.args).at(-1).args;
    expect(args.join(" ")).not.toMatch(
      /features\..*=false|web_search="disabled"|--tools|--strict-mcp-config|--max-turns/,
    );
    if (provider === "codex") {
      expect(
        first.calls.find((c) => c.rpc?.method === "thread/start").rpc.params,
      ).toMatchObject({
        cwd: join(first.home, "workspaces", key),
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      });
      expect(args).toContain(
        "shell_environment_policy.ignore_default_excludes=true",
      );
    } else expect(args).toContain("bypassPermissions");
    expect(
      JSON.stringify(
        first.calls.filter((c) => c.prompt || c.rpc?.method === "turn/start"),
      ),
    ).not.toContain("fixture-github-token");
    const again = await invoke(
      provider,
      "turn",
      "subscription",
      "workspace",
      false,
      "Edit again",
      [],
      { home: first.home, key },
    );
    expect(again.code).toBe(0);
    expect(again.events).toContainEqual({
      chunk: { text: "Workspace edit 2" },
    });
    expect(
      again.calls.filter((c) => c.args).every((c) => c.githubToken === null),
    ).toBe(true);
    const other = await invoke(
      provider,
      "turn",
      "subscription",
      "workspace",
      false,
      "Another agent",
      [],
      { home: first.home, key: "b".repeat(64) },
    );
    expect(other.events).toContainEqual({
      chunk: { text: "Workspace edit 1" },
    });
    expect(readFileSync(join(cwd, "checkout.txt"), "utf8")).toBe("2");
    const invalid = await invoke(
      provider,
      "turn",
      "subscription",
      "fixture",
      false,
      "Bad workspace",
      [],
      { key: "../../escape" },
    );
    expect(invalid.code).not.toBe(0);
    expect(invalid.calls).toEqual([]);
  });
  it(`${provider}: native host preserves tools, cwd and MCP environment without API fallback`, async () => {
    const r = await invoke(
      provider,
      "turn",
      "subscription",
      "fixture",
      true,
      "Use the host",
      [],
      { key: "a".repeat(64), githubToken: "must-not-replace-host-credentials" },
    );
    expect(r.code).toBe(0);
    expect(r.events.at(-1)).toEqual({ done: true });
    const launches = r.calls.filter((c) => c.args);
    expect(
      launches.every(
        (c) =>
          c.cwd === realpathSync(r.home) &&
          c.toolToken === "host-tool-credential" &&
          c.githubToken === null &&
          c.apiKey === null,
      ),
    ).toBe(true);
    const args = launches.at(-1).args;
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--max-turns");
    expect(args.join(" ")).not.toMatch(
      /features\..*=false|web_search="disabled"/,
    );
    if (provider === "claude") expect(args).toContain("bypassPermissions");
    else
      expect(
        r.calls.find((c) => c.rpc?.method === "thread/start").rpc.params
          .sandbox,
      ).toBe("danger-full-access");
  });
}
it("rejects off-provider sign-in URLs and unauthorized tool names", async () => {
  const path = resolve("runtime/protocol.mjs");
  const { authorizationUrl, resultChunks } = await import(path);
  expect(
    authorizationUrl("https://auth.openai.com.evil.test/device", "codex"),
  ).toBeUndefined();
  expect(
    authorizationUrl("https://evil@claude.ai/authorize", "claude"),
  ).toBeUndefined();
  expect(
    authorizationUrl(
      "https://claude.com.evil.test/cai/oauth/authorize",
      "claude",
    ),
  ).toBeUndefined();
  expect(
    authorizationUrl(
      "https://claude.com@evil.test/cai/oauth/authorize",
      "claude",
    ),
  ).toBeUndefined();
  expect(
    authorizationUrl("https://claude.com:444/cai/oauth/authorize", "claude"),
  ).toBeUndefined();
  expect(
    authorizationUrl(
      "https://claude.ai/oauth/authorize?state=legacy",
      "claude",
    ),
  ).toBe("https://claude.ai/oauth/authorize?state=legacy");
  expect(() =>
    resultChunks(
      { kind: "tool", text: "", tool: "ungranted", arguments: "{}" },
      { tools: [] },
    ),
  ).toThrow();
});
it("creates isolated containers without host credentials, sockets or privileged execution", async () => {
  const path = resolve("runtime/container.mjs");
  const { containerArgs } = await import(path);
  const args = containerArgs(
    "loop-test",
    "a".repeat(64),
    "loop-runtime:0.2",
    "test-operation",
  );
  expect(args).toContain("--read-only");
  expect(args).toContain("--cap-drop=ALL");
  expect(args).toContain("--user=1000:1000");
  expect(args.join(" ")).not.toContain("--tmpfs=/work");
  expect(args).toContain(
    `type=volume,source=loop-test-${"a".repeat(64)},target=/home/node`,
  );
  expect(args.join(" ")).not.toMatch(
    /docker.sock|--privileged|type=bind|API_KEY/,
  );
  expect(() =>
    containerArgs("loop-test", "../../escape", "image", "operation"),
  ).toThrow();
});

it("discovers native commands without a model turn and dispatches Claude slash prompts unwrapped", async () => {
  for (const native of [false, true]) {
    for (const provider of ["codex", "claude"]) {
      const catalog = await invoke(
        provider,
        "capabilities",
        "subscription",
        "fixture",
        native,
      );
      expect(catalog.code).toBe(0);
      expect(catalog.events[0].result).toMatchObject({
        available: true,
        commands: expect.arrayContaining([
          expect.objectContaining({
            token: provider === "codex" ? "$fixture-skill" : "/fixture-command",
          }),
        ]),
      });
      expect(
        catalog.calls.some((c) => c.rpc?.method === "turn/start" || c.prompt),
      ).toBe(false);
    }
  }
  const run = await invoke(
    "claude",
    "turn",
    "subscription",
    "fixture",
    true,
    "/fixture-command verify the project",
  );
  expect(run.code).toBe(0);
  expect(run.calls.find((c) => c.prompt)?.prompt).toBe(
    "/fixture-command verify the project",
  );
  const initialization = run.calls.find(
    (c) => c.control?.request_id === "loop-command",
  ).control;
  expect(initialization.request.appendSystemPrompt).toContain("Be clear");
  expect(
    run.calls.find((c) => c.control?.type === "user").control,
  ).toMatchObject({ session_id: "", parent_tool_use_id: null });
  expect(
    run.calls.some((c) => c.args?.includes("--append-system-prompt")),
  ).toBe(false);
  expect(
    run.events.some((e) => e.chunk?.text === "Subscription fixture answer"),
  ).toBe(true);
  const blocked = await invoke(
    "claude",
    "turn",
    "subscription",
    "fixture",
    true,
    "/compact",
  );
  expect(blocked.events.some((e) => e.code === "harness_command")).toBe(true);
  expect(blocked.calls.some((c) => c.prompt)).toBe(false);
});
it("sends known Codex skills as native input items and preserves dollar-prefixed prompt text", async () => {
  const run = await invoke(
    "codex",
    "turn",
    "subscription",
    "fixture",
    true,
    "$fixture-skill inspect $HOME and $PATH for this change",
  );
  expect(run.code).toBe(0);
  expect(
    run.calls.find((c) => c.rpc?.method === "turn/start").rpc.params.input,
  ).toContainEqual({
    type: "skill",
    name: "fixture-skill",
    path: "/fixture/SKILL.md",
  });
  const currency = await invoke(
    "codex",
    "turn",
    "subscription",
    "fixture",
    true,
    "Compare $100 and $200 budgets",
  );
  expect(currency.code).toBe(0);
  expect(currency.calls.some((c) => c.rpc?.method === "skills/list")).toBe(
    false,
  );
  const missing = await invoke(
    "codex",
    "turn",
    "subscription",
    "fixture",
    true,
    "$missing-skill inspect $HOME, $PATH and ${VARIABLE} for this change",
  );
  expect(missing.code).toBe(0);
  const items = missing.calls.find((c) => c.rpc?.method === "turn/start").rpc
    .params.input;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ type: "text" });
  expect(items[0].text).toContain(
    "$missing-skill inspect $HOME, $PATH and ${VARIABLE} for this change",
  );
});

it("returns native Codex review results over the host transport", async () => {
  const result = await invoke(
    "codex",
    "turn",
    "subscription",
    "fixture",
    true,
    "/review check tests",
  );
  expect(result.code).toBe(0);
  expect(
    result.events.some((e) => e.chunk?.text === "Native review result"),
  ).toBe(true);
  expect(
    result.calls.find((c) => c.rpc?.method === "review/start").rpc.params
      .target,
  ).toEqual({ type: "custom", instructions: "check tests" });
});

it("streams long command history through stdin instead of an oversized process argument", async () => {
  const history = "Prior context: " + "x".repeat(180000);
  const result = await invoke(
    "claude",
    "turn",
    "subscription",
    "fixture",
    true,
    "/fixture-command continue",
    [
      { role: "user", content: history },
      { role: "assistant", content: "Previous answer" },
    ],
  );
  expect(result.code).toBe(0);
  expect(
    result.calls.find((c) => c.control?.request_id === "loop-command").control
      .request.appendSystemPrompt,
  ).toContain(history);
  expect(result.calls.find((c) => c.prompt)?.prompt).toBe(
    "/fixture-command continue",
  );
  expect(
    result.calls
      .filter((c) => c.args)
      .every((c) => c.args.every((a: string) => a.length < 10000)),
  ).toBe(true);
});

for (const provider of ["codex", "claude"])
  it(`${provider}: failure diagnostics survive without exposing native credentials`, async () => {
    const secret = "private-failure-credential";
    const failed = await invoke(
      provider,
      "turn",
      "subscription",
      "quota",
      false,
      "Inspect",
      [],
      { githubToken: secret },
    );
    const event = failed.events.find((e) => e.code === "runtime_failure");
    expect(event.error).toContain("[redacted]");
    expect(event.diagnostic).toMatchObject({ phase: "turn" });
    expect(JSON.stringify(failed.events)).not.toContain(secret);
  });
