import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-workspace-reader-"));
let browser, server;
const held = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React,{useRef,useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {useWorkspaceData,useWorkspaceEvents} from ${JSON.stringify(resolve("src/client/app/WorkspaceData.ts"))};
    import {useProjectionRoute} from ${JSON.stringify(resolve("src/client/SourceContext.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    import {watchWorkspaceEvents} from ${JSON.stringify(resolve("src/client/workspace-events.ts"))};
    import {WorkspaceChangeQueue} from ${JSON.stringify(resolve("src/client/workspace-changes.ts"))};
    import {readRoute} from ${JSON.stringify(resolve("src/client/api.ts"))};
    import {workspaceApi} from ${JSON.stringify(resolve("src/shared/workspace-api.ts"))};
    ownerSession.change('alice');setShellSource('');
    function Probe(){
      const ownerRef=useRef('alice'),initialAgentId=useRef(null),resultsVisible=useRef(false);
      const [data,setData]=useState({agents:[],connections:[],folders:[]}),[runs,setRuns]=useState([]),[errors,setErrors]=useState({}),[reports,setReports]=useState([]);
      const [owner,setOwner]=useState('alice'),[,render]=useState(0),[,setRevision]=useState(0),[,setCollectionRevisions]=useState({});
      const [profile,setProfile]=useState(null),[,setTeamSelection]=useState([]);
      const loadResults=async()=>{};
      const readContract=useProjectionRoute();
      const readers=useWorkspaceData({readContract,ownerRef,setData,setBootstrapOwner:()=>{},initialAgentId,initialCompose:false,setProfile,setTeamSelection,setRuns,loadResults,setWorkspaceLoadErrors:setErrors,openAgentChat:()=>{}});
      useWorkspaceEvents({workspaceLoadError:errors.bootstrap||errors.runs||'',session:{user:{id:owner}},...readers,setError:()=>{},profile,view:'feed',teamKey:'',projectFilter:'',setRevision,setCollectionRevisions,resultsVisible,loadResults});
      window.boot=name=>{void readers.bootstrap().then(value=>setReports(old=>[...old,{name,value:value.map(c=>c.label)}])).catch(error=>setReports(old=>[...old,{name,error:error.name}]));};
      window.runs=()=>{void readers.loadRuns().catch(()=>{});};
      window.refresh=()=>{void readers.refresh();};
      window.accept=()=>{++readers.runsGeneration.current;setRuns([{id:'accepted'}]);};
      window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});
      window.owner=value=>flushSync(()=>{ownerRef.current=value;ownerSession.change(value);setOwner(value);});
      window.startRecovery=()=>{
        const pending=new WorkspaceChangeQueue();
        const stop=watchWorkspaceEvents({url:new URL('ws://fixture.invalid/ws'),source:'',socket:()=>({readyState:0,close(){this.readyState=3;}}),read:(after,signal)=>readRoute(workspaceApi.events,{query:{after}},'',signal),changed:events=>{pending.add('',events);pending.schedule(detail=>window.dispatchEvent(new CustomEvent('loop-workspace-change',{detail})));}});
        window.stopRecovery=()=>{stop();pending.clear();};
      };
      return React.createElement('section',null,
        React.createElement('output',{id:'data'},data.environmentName??'empty'),
        React.createElement('output',{id:'runs'},runs.map(r=>r.id).join(',')),
        React.createElement('output',{id:'errors'},JSON.stringify(errors)),
        React.createElement('output',{id:'reports'},JSON.stringify(reports)));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let label = "initial",
    failBootstrap = false,
    failRuns = false,
    eventReads = 0;
  const holds = { bootstrap: false, runs: false },
    requests = [];
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (path === "/client.mjs" || path === "/client.css") {
      res.writeHead(200, {
        "content-type": path.endsWith(".mjs") ? "text/javascript" : "text/css",
      });
      res.end(path.endsWith(".mjs") ? script : style);
      return;
    }
    if (path === "/api/events") {
      eventReads++;
      send(200, []);
      return;
    }
    const kind = path.endsWith("/bootstrap")
      ? "bootstrap"
      : path.endsWith("/runs")
        ? "runs"
        : undefined;
    if (!kind) {
      send(404, { error: "No fixture route" });
      return;
    }
    requests.push({ kind, path, label });
    const failure = kind === "bootstrap" ? failBootstrap : failRuns;
    const body = failure
      ? { error: "Fixture unavailable" }
      : kind === "runs"
        ? []
        : {
            agents: [],
            folders: [],
            teams: [],
            environmentName: label,
            connections: [
              {
                id: "fixture",
                provider: "openai",
                label,
                status: "connected",
                models: "[]",
                metadata: "{}",
              },
            ],
          };
    const reply = () => {
      if (failure === "html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>Proxy unavailable</html>");
      } else if (failure === "snapshot") send(200, { invalid: true });
      else send(failure ? 503 : 200, body);
    };
    if (holds[kind]) {
      holds[kind] = false;
      held.push({ kind, reply });
    } else reply();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const scenarios = ["coalescing", "receipt", "scope", "recovery", "malformed"],
    selected = process.argv[2];
  assert(!selected || scenarios.includes(selected));
  const count = (kind) => requests.filter((r) => r.kind === kind).length;
  for (const scenario of selected ? [selected] : scenarios) {
    label = "initial";
    failBootstrap = failRuns = false;
    held.length = 0;
    holds.bootstrap = holds.runs = false;
    requests.length = 0;
    const page = await browser.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator("#data")).toHaveText("initial");
    await expect.poll(() => count("runs")).toBe(1);
    if (scenario === "coalescing") {
      label = "first";
      holds.bootstrap = true;
      await page.evaluate(() => window.boot("first"));
      await expect.poll(() => held.length).toBe(1);
      label = "trailing";
      await page.evaluate(() => {
        for (let i = 0; i < 5; i++) window.boot("queued" + i);
      });
      assert.equal(
        count("bootstrap"),
        2,
        "bursts wait for the healthy active read",
      );
      held.shift().reply();
      await expect
        .poll(
          async () =>
            JSON.parse(await page.locator("#reports").textContent()).length,
        )
        .toBe(6);
      const reports = JSON.parse(await page.locator("#reports").textContent());
      assert.deepEqual(reports.find((r) => r.name === "first").value, [
        "first",
      ]);
      assert(
        reports
          .filter((r) => r.name.startsWith("queued"))
          .every((r) => JSON.stringify(r.value) === '["trailing"]'),
      );
      assert.equal(
        count("bootstrap"),
        3,
        "one trailing read settles every queued bootstrap caller",
      );
      await expect(page.locator("#data")).toHaveText("trailing");
    } else if (scenario === "receipt") {
      holds.runs = true;
      await page.evaluate(() => window.runs());
      await expect.poll(() => held.length).toBe(1);
      await page.evaluate(() => {
        window.accept();
        window.runs();
      });
      holds.runs = true;
      held.shift().reply();
      await expect.poll(() => held.length).toBe(1);
      await expect(page.locator("#runs")).toHaveText("accepted");
      held.shift().reply();
      await expect(page.locator("#runs")).toHaveText("");
      assert.equal(
        count("runs"),
        3,
        "the trailing read starts after the accepted receipt",
      );
    } else if (scenario === "scope") {
      holds.bootstrap = true;
      label = "old-local";
      await page.evaluate(() => {
        window.boot("old");
        window.boot("queued-old");
      });
      await expect.poll(() => held.length).toBe(1);
      const aborted = page.waitForEvent("requestfailed", {
        predicate: (r) => r.url().endsWith("/bootstrap"),
      });
      label = "new-source";
      await page.evaluate(() => window.source("docker:fixture"));
      await aborted;
      await expect(page.locator("#data")).toHaveText("new-source");
      held.shift().reply();
      await expect
        .poll(
          async () =>
            JSON.parse(await page.locator("#reports").textContent()).length,
        )
        .toBe(2);
      assert(
        JSON.parse(await page.locator("#reports").textContent()).every(
          (r) => r.error === "AbortError",
        ),
      );
      holds.bootstrap = true;
      label = "old-alice";
      await page.evaluate(() => window.boot("alice"));
      await expect.poll(() => held.length).toBe(1);
      label = "bob";
      await page.evaluate(() => window.owner("bob"));
      await expect(page.locator("#data")).toHaveText("bob");
      label = "new-alice";
      await page.evaluate(() => window.owner("alice"));
      await expect(page.locator("#data")).toHaveText("new-alice");
      held.shift().reply();
      await expect(page.locator("#data")).toHaveText("new-alice");
      await expect
        .poll(
          async () =>
            JSON.parse(await page.locator("#reports").textContent()).length,
        )
        .toBe(3);
      assert.equal(
        JSON.parse(await page.locator("#reports").textContent())[2].error,
        "AbortError",
      );
    } else if (scenario === "malformed") {
      for (const kind of ["bootstrap", "runs"])
        for (const malformed of ["html", "snapshot"]) {
          if (kind === "bootstrap") failBootstrap = malformed;
          else failRuns = malformed;
          await page.evaluate(
            (kind) =>
              kind === "bootstrap" ? window.boot("malformed") : window.runs(),
            kind,
          );
          await expect
            .poll(async () =>
              Boolean(
                JSON.parse(await page.locator("#errors").textContent())[kind],
              ),
            )
            .toBe(true);
          const before = count(kind);
          failBootstrap = failRuns = false;
          label = "recovered-" + malformed;
          await page.evaluate(() => window.startRecovery());
          await expect
            .poll(
              async () =>
                JSON.parse(await page.locator("#errors").textContent())[kind],
              { timeout: 10000 },
            )
            .toBe("");
          assert(
            count(kind) > before,
            "quiet watcher recovery rereads malformed " + kind,
          );
          await page.evaluate(() => window.stopRecovery());
        }
    } else {
      failRuns = true;
      await page.evaluate(() => window.runs());
      await expect(page.locator("#errors")).toContainText(
        "Couldn’t refresh task status.",
        { timeout: 12000 },
      );
      const bootBefore = count("bootstrap"),
        runsBefore = count("runs");
      await page.waitForTimeout(5300);
      assert.equal(
        count("bootstrap"),
        bootBefore,
        "exhausted task reads do not poll metadata every five seconds",
      );
      assert.equal(
        count("runs"),
        runsBefore,
        "exhausted reads do not stack a feature retry interval",
      );
      failBootstrap = true;
      await page.evaluate(() => window.boot("failed"));
      await expect(page.locator("#errors")).toContainText(
        "Couldn’t refresh your agents and projects.",
        { timeout: 12000 },
      );
      failRuns = false;
      await page.evaluate(() => window.runs());
      await expect
        .poll(
          async () =>
            JSON.parse(await page.locator("#errors").textContent()).runs,
        )
        .toBe("");
      await expect(page.locator("#errors")).toContainText(
        "Couldn’t refresh your agents and projects.",
      );
      failBootstrap = false;
      label = "recovered";
      eventReads = 0;
      await page.evaluate(() => window.startRecovery());
      await expect(page.locator("#data")).toHaveText("recovered", {
        timeout: 10000,
      });
      assert(eventReads > 0, "the production watcher read the quiet event log");
      await expect
        .poll(
          async () =>
            JSON.parse(await page.locator("#errors").textContent()).bootstrap,
        )
        .toBe("");
      await page.evaluate(() => window.stopRecovery());
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${engine} workspace-reader ${scenario}: passed`);
  }
} finally {
  for (const entry of held) entry.reply();
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
