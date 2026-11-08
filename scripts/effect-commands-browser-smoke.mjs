import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-effect-commands-"));
const engine = process.env.LOOP_BROWSER === "webkit" ? webkit : chromium;
let browser;
let server;
const requests = [];
let outcome = "success";
const providerView = {
  providers: [
    {
      id: "fixture",
      name: "Fixture",
      configured: true,
      removable: true,
      credentialType: "api",
      methods: [{ id: "key", label: "API key", type: "api" }],
    },
  ],
  models: [{ id: "fixture/model", name: "Fixture model" }],
  agents: [],
  billing: "existing",
  enabled: true,
  updatedAt: 100,
};
const run = {
  id: "refresh-run",
  agent_id: "agent",
  conversation_id: null,
  input: "Refresh",
  state: "queued",
  payload: "{}",
  result: null,
  error: null,
  created_at: 100,
  updated_at: 100,
};
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React, {useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {HarnessProviders} from ${JSON.stringify(resolve("src/client/HarnessProviders.tsx"))};
    import {ArtifactViewer} from ${JSON.stringify(resolve("src/client/ArtifactViewer.tsx"))};
    import {SearchWorkspace} from ${JSON.stringify(resolve("src/client/Workspace.tsx"))};
    import {ProfilePhoto} from ${JSON.stringify(resolve("src/client/ProfilePhoto.tsx"))};
    import {Toasts, notify} from ${JSON.stringify(resolve("src/client/toast.tsx"))};
    import {Sheet} from ${JSON.stringify(resolve("src/client/components.tsx"))};
    import {setViewOwner} from ${JSON.stringify(resolve("src/client/viewCache.ts"))};
    import {SourceProvider} from ${JSON.stringify(resolve("src/client/SourceContext.tsx"))};
    import {workspaceCapabilities} from ${JSON.stringify(resolve("src/shared/capabilities.ts"))};
    import ${JSON.stringify(resolve("src/client/style.css"))};
    const h = React.createElement;
    const root = createRoot(document.getElementById('root'));
    const noop = () => {};
    window.fixtureToast = () => notify({text:'Photo action',undo:()=>{window.photoUndo=true;}});
    function Photo() {
      const [photo, show] = useState(false), [sheet, open] = useState(true);
      return h(React.Fragment, null, h(Toasts),
        sheet && h(Sheet, {title: 'Underlying profile', onClose: () => open(false)},
          h('button', {onClick: () => show(true)}, 'Open photo')),
        photo && h(ProfilePhoto, {label: 'Fixture photo', src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>', onClose: () => show(false)}));
    }
    const params = new URLSearchParams(location.search);
    const mode = params.get('mode') || 'providers', owner = params.get('owner') || 'alice', source = params.get('source') || '';
    setViewOwner(owner);
    const item = {id:'artifact',owner_id:owner,agent_id:'agent',conversation_id:null,run_id:null,title:'Fixture result',kind:'text',content:'Saved result',metadata:JSON.stringify({refreshable:true}),folder_id:null,pinned:0,archived:0,version:1,created_at:100,updated_at:100};
    root.render(h(SourceProvider, {sourceId:source,capabilities:workspaceCapabilities()},
      mode === 'search' ? h(SearchWorkspace, {agents:[],folders:[],userName:owner,onOpen:noop,onConversation:noop,onProfile:noop}) : mode === 'photo' ? h(Photo) : mode === 'artifact' ? h(ArtifactViewer, {
        item, connections:[], onProfile:noop,onClose:noop,onFile:noop,onConversation:noop,onChanged:noop,onRun:noop,onReply:noop,
      }) : h(HarnessProviders,{runtime:'pi',projectId:'project',location:'fixture',targets:[],onChange:async()=>{}})));
  `,
  );
  const bundle = await browserFixtureBundle(entry);
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    const reply = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/") {
      res.setHeader("content-type", "text/html");
      res.end(
        '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client.css"><main id="root"></main><script type="module" src="/client.mjs"></script>',
      );
    } else if (path === "/client.mjs") {
      res.setHeader("content-type", "text/javascript");
      res.end(bundle.script);
    } else if (path === "/client.css") {
      res.setHeader("content-type", "text/css");
      res.end(bundle.style);
    } else if (path === "/session") reply({ csrf: "fixture" });
    else if (req.method === "GET" && path === "/api/search")
      reply({
        mode: "keyword",
        detail: null,
        pending: 0,
        next: null,
        items: [],
        semantic: {
          enabled: false,
          state: "disabled",
          total: 0,
          indexed: 0,
          pending: 0,
          detail: null,
        },
      });
    else if (req.method === "GET" && path.endsWith("/providers"))
      reply(providerView);
    else if (
      req.method !== "GET" &&
      (path.includes("/providers") ||
        path.endsWith("/artifacts/artifact/refresh"))
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ path, body });
      if (outcome === "lost") {
        // A truncated reply is uncertain even though the command reached us.
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"');
      } else if (outcome === "transport-refused")
        reply({ error: "Fixture transport refusal" }, 401);
      else if (outcome === "refused")
        reply(
          {
            error: "Fixture refusal before dispatch",
            executionOutcome: "refused",
          },
          422,
        );
      else if (outcome === "unknown")
        reply(
          { error: "Fixture unknown outcome", executionOutcome: "unknown" },
          409,
        );
      else
        reply(
          path.endsWith("/artifacts/artifact/refresh") ? run : providerView,
        );
    } else reply({ error: "Unexpected fixture request: " + path }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await engine.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  if (process.argv.includes("--photo-only")) {
    await page.goto(base + "/?mode=photo");
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Fixture photo", exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole("dialog", { name: "Fixture photo", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Underlying profile", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open photo", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await page.evaluate(() => window.fixtureToast());
    const photo = page.getByRole("dialog", {
      name: "Fixture photo",
      exact: true,
    });
    await photo.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.photoUndo)).toBe(true);
    console.log(
      "Photo Back preserves the underlying profile and its toast remains usable",
    );
  } else {
    async function open(kind, owner = "alice", source = "") {
      await page.goto(
        `${base}/?mode=${kind === "artifact" ? "artifact" : "providers"}&owner=${owner}&source=${encodeURIComponent(source)}`,
      );
      if (kind !== "artifact")
        await expect(
          page.getByRole("button", { name: "Refresh Pi", exact: true }),
        ).toBeVisible();
    }
    async function act(kind, secret = "fixture-private-key") {
      if (kind === "refresh")
        await page
          .getByRole("button", { name: "Refresh Pi", exact: true })
          .click();
      if (kind === "key") {
        await page
          .getByRole("button", {
            name: "Replace credential or reconnect",
            exact: true,
          })
          .click();
        await page.getByLabel("API key", { exact: true }).fill(secret);
        await page
          .getByRole("button", {
            name: "Save key and refresh models",
            exact: true,
          })
          .click();
      }
      if (kind === "remove") {
        await page
          .getByRole("button", { name: "Remove saved credential", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Confirm removal", exact: true })
          .click();
      }
      if (kind === "artifact") {
        await page.getByLabel("Result options", { exact: true }).click();
        await page
          .getByRole("button", { name: "Refresh from source", exact: true })
          .click();
      }
    }
    const identity = (request) =>
      request.body.commandId || request.body.idempotencyKey;
    if (!process.argv.includes("--commands-only")) {
      await page.goto(base + "/?mode=search&owner=alice");
      await page.evaluate(() => localStorage.clear());
      await page
        .getByRole("searchbox", { name: "Search everything" })
        .fill("Alice private search");
      await page
        .getByRole("searchbox", { name: "Search everything" })
        .press("Enter");
      await expect(
        page.getByText("Nothing found yet.", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Alice private search", exact: true }),
      ).toBeVisible();
      await page.goto(base + "/?mode=search&owner=bob");
      await expect(
        page.getByRole("searchbox", { name: "Search everything" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Alice private search", exact: true }),
      ).toHaveCount(0);
      await page.goto(base + "/?mode=search&owner=alice");
      await expect(
        page.getByRole("button", { name: "Alice private search", exact: true }),
      ).toBeVisible();
      console.log("Recent search owner isolation passed");
    }
    for (const kind of ["refresh", "key", "remove", "artifact"]) {
      await open(kind);
      await page.evaluate(() => localStorage.clear());
      for (const firstOutcome of ["lost", "unknown", "refused"]) {
        requests.length = 0;
        outcome = firstOutcome;
        await open(kind);
        await act(kind);
        await expect.poll(() => requests.length).toBe(1);
        await expect(
          page
            .getByText(
              firstOutcome === "refused"
                ? "Fixture refusal before dispatch"
                : firstOutcome === "unknown"
                  ? "Fixture unknown outcome"
                  : /Connection unavailable|change unconfirmed/,
              { exact: false },
            )
            .first(),
        ).toBeVisible();
        const first = identity(requests[0]);
        assert.match(first, /^[0-9a-f-]{36}$/);
        await open(kind);
        outcome = "success";
        await act(kind);
        await expect.poll(() => requests.length).toBe(2);
        if (firstOutcome === "refused")
          assert.notEqual(
            identity(requests[1]),
            first,
            kind + ": refusal starts a new identity",
          );
        else
          assert.equal(
            identity(requests[1]),
            first,
            kind + ": uncertainty survives reload",
          );
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                Object.keys(localStorage).filter((k) =>
                  k.startsWith("loop-effect:"),
                ).length,
            ),
          )
          .toBe(0);
      }
      requests.length = 0;
      outcome = "lost";
      await open(kind);
      await act(kind);
      await expect.poll(() => requests.length).toBe(1);
      const uncertain = identity(requests[0]);
      outcome = "transport-refused";
      await open(kind);
      await act(kind);
      await expect.poll(() => requests.length).toBe(2);
      await expect(
        page.getByText(/Fixture transport refusal/).first(),
      ).toBeVisible();
      outcome = "success";
      await open(kind);
      await act(kind);
      await expect.poll(() => requests.length).toBe(3);
      assert.equal(identity(requests[1]), uncertain);
      assert.equal(
        identity(requests[2]),
        uncertain,
        kind + ": an auth refusal cannot settle an earlier uncertain effect",
      );
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Object.keys(localStorage).filter((k) =>
                k.startsWith("loop-effect:"),
              ).length,
          ),
        )
        .toBe(0);
      outcome = "lost";
      requests.length = 0;
      await open(kind);
      await act(kind);
      await expect.poll(() => requests.length).toBe(1);
      const alice = identity(requests[0]);
      await open(kind, "bob");
      await act(kind);
      await expect.poll(() => requests.length).toBe(2);
      assert.notEqual(identity(requests[1]), alice, kind + ": owner isolation");
      await open(kind, "alice", "other-source");
      await act(kind);
      await expect.poll(() => requests.length).toBe(3);
      assert.notEqual(
        identity(requests[2]),
        alice,
        kind + ": source isolation",
      );
      if (kind === "key") {
        await open(kind);
        await act(kind, "fixture-different-key");
        await expect.poll(() => requests.length).toBe(4);
        assert.notEqual(
          identity(requests[3]),
          alice,
          "A different credential is a distinct explicit request",
        );
      }
      const saved = await page.evaluate(() => JSON.stringify(localStorage));
      assert(
        !saved.includes("fixture-private-key"),
        "Credentials are never persisted by the identity store",
      );
      console.log(
        kind +
          ": lost/unknown/refused outcomes, reload and owner/source isolation passed",
      );
    }
  }
  await context.close();
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
