import Database from "better-sqlite3";
import { trackSmokeCleanup, stopFixtureProcess } from "./smoke-lifecycle.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, randomUUID, randomBytes } from "node:crypto";
import { tsImport } from "tsx/esm/api";

const { installFixtureProjection } = await tsImport(
  "../../test/helpers/projected-writer.ts",
  import.meta.url,
);

// No .env file, real accounts, provider calls, worker execution, or persisted browser auth.
// `githubApi` points server-side GitHub reads at a fake; by default they fail fast.
export async function designFixture({ githubApi } = {}) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "loop-design-fixture-"));
  const key = randomBytes(32).toString("hex");
  // The production companion workspace (scripts/fixture-companion.ts), paired
  // over HTTP like a phone; it reports its loopback origin once listening.
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fixture-companion.ts"],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        LOOP_PROFILE: "companion",
        LOOP_DATA_DIR: dir,
        LOOP_ENCRYPTION_KEY: key,
        // Never discover the developer's own Docker workspaces.
        DOCKER_HOST: "unix:///nonexistent/loop-fixture-docker.sock",
        // Watched pull requests poll here and fail fast: no real GitHub.
        LOOP_GITHUB_API_URL: githubApi || "http://127.0.0.1:9",
      },
    },
  );
  let logs = "",
    startupError,
    db,
    heartbeat;
  server.once("error", (error) => {
    startupError = error;
  });
  server.stdout.on("data", (data) => {
    logs += data;
  });
  server.stderr.on("data", (data) => {
    logs += data;
  });
  const close = trackSmokeCleanup(async () => {
    clearInterval(heartbeat);
    try {
      await stopFixtureProcess(server);
    } finally {
      try {
        if (db?.open) db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  try {
    let started;
    for (let i = 0; i < 300 && !started; i++) {
      if (
        startupError ||
        server.exitCode !== null ||
        server.signalCode !== null
      )
        throw new Error(
          "Fixture did not start: " + (startupError?.message || logs),
        );
      // Only complete lines: the announcement can arrive across chunks.
      const line = logs
        .split("\n")
        .slice(0, -1)
        .find((l) => l.startsWith('{"origin"'));
      if (line) started = JSON.parse(line);
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!started) throw new Error("Fixture did not start: " + logs);
    const base = started.origin;
    const secret = new URL(started.pair).hash.replace(/^#pair=/, "");
    const paired = await fetch(base + "/pair", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ secret, name: "Design fixture" }),
    });
    if (!paired.ok)
      throw new Error("Fixture pairing failed: " + (await paired.text()));
    const cookieHeader = paired.headers.get("set-cookie").split(";")[0];
    const [cookieName, cookieValue] = cookieHeader.split("=");
    const { csrf } = await (
      await fetch(base + "/session", { headers: { cookie: cookieHeader } })
    ).json();
    // Paired-device headers for direct requests (uploads, malformed bodies).
    const headers = { origin: base, cookie: cookieHeader, "x-loop-csrf": csrf };
    const api = async (path, body, method) => {
      const response = await fetch(base + "/api" + path, {
        method: method || (body ? "POST" : "GET"),
        headers: { "content-type": "application/json", ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(path + ": " + JSON.stringify(data));
      return data;
    };
    // Browser contexts sign in with the fixture's paired device.
    const pair = (context) =>
      context.addCookies([
        { name: cookieName, value: cookieValue, url: base, httpOnly: true },
      ]);
    const owner = (await api("/auth/get-session")).user.id;
    db = new Database(dir + "/loop.db");
    installFixtureProjection(db);
    heartbeat = setInterval(
      () =>
        db
          .prepare("INSERT OR REPLACE INTO worker_health VALUES(?,?)")
          .run("design-fixture", Date.now()),
      1000,
    );
    // Native harness connections, shaped like the ones the companion registers
    // when a harness is enabled. The fixture runs no execution process.
    const native = (harness, label, models) => {
      const id = "native-" + harness;
      db.prepare(
        "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,?,?,'','connected',?,?,?)",
      ).run(
        id,
        owner,
        harness === "claude" ? "anthropic" : harness,
        label,
        JSON.stringify(models),
        JSON.stringify({
          loopHarness: harness,
          authMode: "native-existing",
          runtimeKind: "loop-local",
          location: "laptop",
        }),
        Date.now(),
      );
      return { id };
    };
    const codex = native("codex", "Personal ChatGPT", [
      { id: "gpt-6-sol", name: "GPT-6 Sol" },
      { id: "gpt-6-astra", name: "GPT-6 Astra" },
    ]);
    const claude = native("claude", "Personal Claude", [
      { id: "sonnet", name: "Claude Sonnet" },
      { id: "opus", name: "Claude Opus" },
    ]);
    const projects = [];
    for (const name of ["Loop", "Research and product development", "Personal"])
      projects.push(await api("/folders", { name, kind: "project" }));
    const agents = [];
    for (const [i, name] of [
      "scout-11eb",
      "code-reviewer",
      "planner",
      "research-assistant",
      "scout-56f6",
      "platform-engineer",
      "release-manager",
      "docs-editor",
      "quality-engineer",
      "design-reviewer",
      "scout-a881",
    ].entries())
      agents.push(
        await api("/agents", {
          name,
          connectionId: i % 2 ? claude.id : codex.id,
          model: i % 2 ? "sonnet" : "gpt-6-sol",
          instructions:
            i === 1
              ? "Review changes carefully. Prioritize correctness, explain risks, and cite the relevant files."
              : "",
          folderId: projects[i % 3].id,
        }),
      );
    await api("/teams", {
      name: "Product and engineering",
      managerId: agents[2].id,
      members: [agents[0].id, agents[1].id, agents[3].id],
    });
    await api("/teams", {
      name: "Research",
      managerId: agents[7].id,
      members: [agents[8].id, agents[9].id],
    });
    await api("/mcp", {
      name: "GitHub",
      url: "https://fixture.example/mcp",
      auth: { type: "none" },
    }).catch(() => {});
    let refs = {
      base,
      pair,
      headers,
      agents,
      projects,
      conversations: [],
      artifacts: [],
    };
    const now = Date.now();
    const answer =
      '## Review complete\n\nThe change adds project filtering and improves how agents appear in the feed. I found two issues to address before merging.\n\n### 1. Preserve the selected project\n\nWhen you open an agent from a project and return, keep the project filter so you do not lose your place.\n\n- Keep the current project in the route.\n- Restore the selected tab when closing a conversation.\n- Show a clear loading state while results arrive.\n\n### 2. Improve error recovery\n\nThe request can fail while the dialog stays open. Put the error next to the action and keep the draft available.\n\n| Area | Status | Next step |\n| --- | --- | --- |\n| Navigation | Needs work | Preserve the route |\n| Composer | Needs review | Keyboard testing |\n| Saved output | Ready | Verify empty states |\n\n```typescript\nconst projectId = searchParams.get("project");\nreturn loadProject(projectId);\n```\n\nSee [the proposed changes](https://example.com/pull/42) for the full context.\n\n' +
      "Longer tasks need readable progress and a clear final result. The user should be able to see what finished, what needs a decision, and how to continue.\n\n".repeat(
        5,
      );
    function runFixture(state, title, agent, index) {
      const conv = randomUUID(),
        run = randomUUID(),
        message = randomUUID(),
        artifact = randomUUID();
      const t = now - index * 3600000;
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
      ).run(conv, owner, agent.id, title, t);
      db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,result,error,worker_id,heartbeat,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        run,
        owner,
        agent.id,
        conv,
        title,
        state,
        run,
        JSON.stringify({
          agentId: agent.id,
          connectionId: agent.connection_id,
          model: agent.model,
          provider: agent.provider,
          folderId: agent.folder_id,
        }),
        state === "completed" ? answer : null,
        state === "failed"
          ? "The tool could not complete the request. Reconnect GitHub and try again."
          : null,
        state === "running" ? "audit-fixture" : null,
        state === "running" ? now + 99999999 : null,
        t,
        t,
      );
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(randomUUID(), owner, conv, run, "user", title, t);
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        message,
        owner,
        conv,
        run,
        "assistant",
        state === "completed"
          ? answer
          : state === "running"
            ? "I am checking the changes and comparing the test results."
            : "",
        JSON.stringify({ partial: state !== "completed" }),
        t + 1,
      );
      if (["completed", "running"].includes(state)) {
        db.prepare(
          "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,folder_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          artifact,
          owner,
          agent.id,
          conv,
          run,
          title,
          "markdown",
          state === "completed"
            ? answer
            : "Checking **the changes** and reviewing the test results.",
          JSON.stringify({
            messageId: message,
            partial: state !== "completed",
            model: agent.model,
          }),
          agent.folder_id,
          t,
          t,
        );
        db.prepare(
          "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history,output) VALUES(?,?,?,?,?)",
        ).run(
          run,
          message,
          artifact,
          "[]",
          state === "completed" ? answer : "Checking the changes",
        );
        refs.artifacts.push(artifact);
      }
      if (state === "awaiting_approval")
        db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?,?,NULL,?,?)").run(
          randomUUID(),
          owner,
          run,
          run,
          JSON.stringify({
            type: "mcp_tool",
            tool: "pull_request_review_write",
            server: "GitHub",
            arguments: {
              owner: "sample",
              repo: "loop",
              pullNumber: 42,
              event: "COMMENT",
              body: "Two issues need attention before this change is ready.",
            },
            message: "Allow @" + agent.name + " to post a review on GitHub?",
          }),
          "pending",
          now,
          now + 24 * 3600000,
        );
      db.prepare(
        "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        owner,
        run,
        "audit-check",
        "tool",
        "Run command",
        "npm test\n\n35 test files passed.\n189 tests passed.",
        JSON.stringify({ state: "completed", native: true }),
        t,
      );
      refs.conversations.push({ id: conv, state, title, run });
    }
    runFixture(
      "completed",
      "Review the project navigation and agent controls before release",
      agents[1],
      0,
    );
    runFixture(
      "completed",
      "Compare the best options for our next product experiment",
      agents[0],
      1,
    );
    runFixture(
      "running",
      "Review GitHub pull request #42 and report any regressions",
      agents[4],
      2,
    );
    runFixture(
      "awaiting_approval",
      "Post the review comments on the pull request",
      agents[1],
      3,
    );
    runFixture(
      "failed",
      "Check why the GitHub review could not be posted",
      agents[3],
      4,
    );
    runFixture(
      "queued",
      "Summarize the release notes and draft a short update",
      agents[5],
      5,
    );
    runFixture("paused", "Research remote execution options", agents[6], 6);
    const nested = await api("/folders", {
      name: "Nested work",
      kind: "folder",
      parentId: projects[0].id,
    });
    db.prepare("UPDATE artifacts SET folder_id=? WHERE id=?").run(
      nested.id,
      refs.artifacts[1],
    );
    db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(
      nested.id,
      agents[0].id,
    );
    // Connects the official GitHub integration with a fixture token, sealed
    // like the server seals connection secrets.
    const connectGithub = (token = "fixture-github-token") => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
      cipher.setAAD(Buffer.from(owner));
      const data = Buffer.concat([
        cipher.update(JSON.stringify({ type: "bearer", token }), "utf8"),
        cipher.final(),
      ]);
      db.prepare(
        "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,metadata,created_at) VALUES(?,?,'GitHub','https://api.githubcopilot.com/mcp/',?,'connected','{}',?)",
      ).run(
        randomUUID(),
        owner,
        [iv, cipher.getAuthTag(), data]
          .map((x) => x.toString("base64"))
          .join("."),
        Date.now(),
      );
    };
    return { ...refs, nested, api, db, owner, connectGithub, close };
  } catch (error) {
    await close();
    throw error;
  }
}
