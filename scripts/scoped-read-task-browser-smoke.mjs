import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-scoped-read-task-"));
let server, browser;
const held = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React,{useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {useProjectionRoute} from ${JSON.stringify(resolve("src/client/SourceContext.tsx"))};
    import {RuntimeSignIn} from ${JSON.stringify(resolve("src/client/RuntimeSignIn.tsx"))};
    import {workspaceApi} from ${JSON.stringify(resolve("src/shared/workspace-api.ts"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    window.results=[];window.authStates=[];
    function Tasks({selection}) {
      const read=useProjectionRoute({key:selection});
      window.readTask=(id,external=false)=>{
        const controller=new AbortController();
        window.abortTask=()=>controller.abort();
        void read(workspaceApi.runtimeAuthStatus,{params:{name:id}},
          {signal:external?controller.signal:undefined})
          .then(value=>window.results.push({id,value}),error=>window.results.push({id,error:error.name}));
      };
      return null;
    }
    function App(){
      const [selection,setSelection]=useState('a'),[project,setProject]=useState('project-a'),[mode,setMode]=useState('tasks'),[,render]=useState(0);
      window.select=value=>flushSync(()=>setSelection(value));
      window.project=value=>flushSync(()=>setProject(value));
      window.mode=value=>flushSync(()=>setMode(value));
      window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});
      window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});
      return mode==='tasks'?React.createElement(Tasks,{selection}):mode==='signin'?React.createElement(RuntimeSignIn,{
        runtime:'claude',backend:'direct',location:'fixture',name:'claude',label:'Claude Code',projectId:project,
        signedIn:false,enabled:false,enabling:false,enableAction:null,
        onStateChange:(name,state,id)=>window.authStates.push({name,state,id}),onClose:()=>{}
      }):null;
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let hold = false;
  const reads = [],
    aborted = [];
  const providers = [
    {
      id: "anthropic",
      name: "Anthropic",
      methods: [{ id: "oauth", label: "Sign in", type: "oauth" }],
    },
  ];
  const attempt = {
    id: "attempt-a",
    commandId: "command-a",
    provider: "anthropic",
    method: "oauth",
    state: "waiting",
    expiresAt: Date.now() + 60000,
    prompt: {
      id: "prompt-a",
      type: "text",
      message: "Fixture authorization code",
    },
  };
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (url.pathname === "/client.mjs" || url.pathname === "/client.css") {
      res.writeHead(200, {
        "content-type": url.pathname.endsWith(".mjs")
          ? "text/javascript"
          : "text/css",
      });
      res.end(url.pathname.endsWith(".mjs") ? script : style);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(404);
      res.end();
      return;
    }
    assert.equal(
      req.method,
      "GET",
      "fixture never dispatches a sign-in command",
    );
    reads.push(url.pathname + url.search);
    res.on("close", () => {
      if (!res.writableEnded) aborted.push(url.pathname + url.search);
    });
    const reply = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          url.pathname.includes("/claude/auth")
            ? { providers, attempt }
            : { providers: [{ ...providers[0], name: url.pathname }] },
        ),
      );
    };
    if (hold) held.push(reply);
    else reply();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !!window.readTask);
  hold = true;
  await page.evaluate(() => {
    window.readTask("codex");
    window.readTask("pi");
  });
  await expect.poll(() => held.length).toBe(2);
  held.pop()();
  held.pop()();
  await expect.poll(() => page.evaluate(() => window.results.length)).toBe(2);
  assert.deepEqual(
    await page.evaluate(() =>
      window.results
        .map((r) => ({ id: r.id, target: r.value.providers[0].name }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ),
    [
      { id: "codex", target: "/api/workspace/runtimes/codex/auth/status" },
      { id: "pi", target: "/api/workspace/runtimes/pi/auth/status" },
    ],
  );
  for (const change of [
    "external",
    "selection",
    "source",
    "owner",
    "unmount",
  ]) {
    const before = reads.length,
      closed = aborted.length;
    await page.evaluate(
      (external) => window.readTask("codex", external),
      change === "external",
    );
    await expect.poll(() => reads.length).toBe(before + 1);
    await page.evaluate((change) => {
      if (change === "external") window.abortTask();
      if (change === "selection") window.select("b");
      if (change === "source") window.source("docker:fixture");
      if (change === "owner") window.owner("bob");
      if (change === "unmount") window.mode("empty");
    }, change);
    await expect.poll(() => aborted.length).toBe(closed + 1);
    held.splice(0).forEach((reply) => reply());
    await expect
      .poll(() =>
        page.evaluate(
          () => window.results.filter((r) => r.error === "AbortError").length,
        ),
      )
      .toBe(
        ["external", "selection", "source", "owner", "unmount"].indexOf(
          change,
        ) + 1,
      );
  }
  hold = false;
  await page.evaluate(() => {
    window.source("");
    window.mode("signin");
  });
  const input = page.getByRole("textbox", {
    name: "Provider sign-in response",
  });
  await expect(input).toBeVisible();
  await input.fill("keep-my-response");
  hold = true;
  const beforeProject = reads.length;
  await page.evaluate(() => window.project("project-b"));
  await expect
    .poll(() =>
      reads
        .slice(beforeProject)
        .some((path) => path.includes("projectId=project-b")),
    )
    .toBe(true);
  await expect(input).toHaveValue("keep-my-response");
  held.splice(0).forEach((reply) => reply());
  hold = false;
  await expect(input).toHaveValue("keep-my-response");
  const beforeOwner = reads.length;
  await page.evaluate(() => window.owner("charlie"));
  await expect.poll(() => reads.length).toBeGreaterThan(beforeOwner);
  await expect(input).toHaveValue("");
  await input.fill("old-owner-response");
  hold = true;
  await page.evaluate(() => window.project("project-c"));
  await expect.poll(() => held.length).toBeGreaterThan(0);
  const closed = aborted.length;
  await page.evaluate(() => window.source("docker:next"));
  await expect.poll(() => aborted.length).toBeGreaterThan(closed);
  await expect(input).toHaveCount(0);
  held.splice(0).forEach((reply) => reply());
  hold = false;
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("");
  await expect
    .poll(() => page.evaluate(() => window.authStates.length))
    .toBeGreaterThan(0);
  assert.deepEqual(errors, []);
  console.log(
    `${engine}: independent target results, external/selection/source/owner/unmount HTTP cancellation, runtime sign-in project retention and owner/source reset passed`,
  );
} finally {
  held.splice(0).forEach((reply) => reply());
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
