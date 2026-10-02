import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:net";

// No .env file, real accounts, provider calls, worker execution, or persisted browser auth.
export async function designFixture() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "loop-design-fixture-"));
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fixture-server.ts"],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        LOOP_PROFILE: "server",
        LOOP_AUTH_MODE: "single-user",
        LOOP_DATA_DIR: dir,
        PORT: String(port),
        LOOP_URL: base,
        LOOP_LISTEN_HOST: "127.0.0.1",
        LOOP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        LOOP_SINGLE_USER_EMAIL: "",
        LOOP_GATEWAY_TOKEN: "",
        LOOP_RUNTIME_URL: "",
        // Watched pull requests poll here and fail fast: no real GitHub.
        LOOP_GITHUB_API_URL: "http://127.0.0.1:9",
        LOOP_RUNTIME_TOKEN: "",
      },
    },
  );
  let logs = "",
    db,
    heartbeat;
  server.stdout.on("data", (data) => {
    logs += data;
  });
  server.stderr.on("data", (data) => {
    logs += data;
  });
  const close = async () => {
    clearInterval(heartbeat);
    db?.close();
    if (server.exitCode === null && !server.killed) {
      const stopped = new Promise((resolve) => server.once("exit", resolve));
      server.kill();
      await stopped;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/api/auth/get-session")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Fixture did not start: " + logs);
    const api = async (path, body, method) => {
      const response = await fetch(base + "/api" + path, {
        method: method || (body ? "POST" : "GET"),
        headers: { "content-type": "application/json", origin: base },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(path + ": " + JSON.stringify(data));
      return data;
    };
    const owner = (await api("/auth/get-session")).user.id;
    db = new Database(dir + "/loop.db");
    heartbeat = setInterval(
      () =>
        db
          .prepare("INSERT OR REPLACE INTO worker_health VALUES(?,?)")
          .run("design-fixture", Date.now()),
      1000,
    );
    const codex = await api("/connections", {
      provider: "openai",
      label: "Personal ChatGPT",
      secret: "fixture-only-not-a-real-key",
    });
    const claude = await api("/connections", {
      provider: "anthropic",
      label: "Personal Claude",
      secret: "fixture-only-not-a-real-key",
    });
    db.prepare(
      "UPDATE connections SET provider=?,models=?,metadata=? WHERE id=?",
    ).run(
      "codex",
      JSON.stringify([
        { id: "gpt-6-sol", name: "GPT-6 Sol" },
        { id: "gpt-6-astra", name: "GPT-6 Astra" },
      ]),
      JSON.stringify({ authMode: "subscription", plan: "pro" }),
      codex.id,
    );
    db.prepare("UPDATE connections SET models=?,metadata=? WHERE id=?").run(
      JSON.stringify([
        { id: "sonnet", name: "Claude Sonnet" },
        { id: "opus", name: "Claude Opus" },
      ]),
      JSON.stringify({ authMode: "subscription" }),
      claude.id,
    );
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
    let refs = { base, agents, projects, conversations: [], artifacts: [] };
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
    return { ...refs, nested, api, db, owner, close };
  } catch (error) {
    await close();
    throw error;
  }
}
