import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { testDirectory } from "./helpers/test-workspace.js";
import { BeadsStore } from "../src/beads-runtime.js";

const data = testDirectory();
const realBeads = process.env.LOOP_TEST_BEADS_ROOT;
if (realBeads) process.env.LOOP_BAKED_BEADS = realBeads;
const { db, id, now } = await import("../src/server/db.js");
const { app } = await import("../src/server/index.js");
const owner = "local-workspace";
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) =>
  server.once("listening", resolve).once("error", reject),
);
const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(origin + "/api" + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function createProject(name: string) {
  const project = await request("/folders", "POST", { name, kind: "project" });
  expect(project.status, JSON.stringify(project.body)).toBe(201);
  return project.body.id as string;
}

it("requires a project owned by the requesting workspace", async () => {
  const project = await createProject("Work boundary");
  expect(await request("/projects/" + project + "/work")).toEqual({
    status: 200,
    body: { enabled: false },
  });

  const foreign = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES(?,?,?,'project',?)",
  ).run(foreign, "another-owner", "Foreign", now());
  const foreignWork = "/projects/" + foreign + "/work";
  expect((await request(foreignWork)).status).toBe(404);
  expect((await request(foreignWork, "PUT", {})).status).toBe(404);
  expect(
    (
      await request(foreignWork, "POST", {
        storeId: "a".repeat(64),
        requestId: randomUUID(),
        title: "Foreign",
      })
    ).status,
  ).toBe(404);
});

it.skipIf(!realBeads)(
  "keeps a native quoted comment recoverable by request after the receipt is lost",
  async () => {
    const project = await createProject("Real Beads");
    const route = "/projects/" + project + "/work";
    const enabled = await request(route, "PUT", {});
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    const { storeId } = enabled.body;
    const create = {
      storeId,
      requestId: randomUUID(),
      title: "Use canonical answers",
      description: "Published answers retain their durable identity.",
    };
    const created = await request(route, "POST", create);
    expect(created).toEqual({
      status: 200,
      body: { status: "committed", beadId: expect.stringMatching(/^loop-/) },
    });
    const bead = created.body.beadId;
    expect(await request(route, "POST", create)).toEqual(created);

    const commentRoute = route + "/" + bead + "/comments";
    const comment = {
      storeId,
      requestId: randomUUID(),
      text: "Add a fixture.",
      excerpt: "durable identity",
    };
    expect(
      (
        await request(commentRoute, "POST", {
          ...comment,
          storeId: "a".repeat(64),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(commentRoute, "POST", {
          ...comment,
          excerpt: "wrong passage",
        })
      ).status,
    ).toBe(409);
    const posted = await request(commentRoute, "POST", comment);
    expect(posted).toEqual({
      status: 200,
      body: { status: "committed", beadId: bead },
    });

    // Simulate losing the Loop-side completion commit after Beads committed.
    db.prepare(
      "UPDATE bead_write_receipts SET completed_at=NULL WHERE owner_id=? AND request_id=?",
    ).run(owner, comment.requestId);
    expect(await request(commentRoute, "POST", comment)).toEqual(posted);
    expect(
      (await request(commentRoute, "POST", { ...comment, text: "Other text" }))
        .status,
    ).toBe(409);
    const detail = await request(route + "/" + bead);
    expect(detail.status).toBe(200);
    expect(detail.body.comments).toEqual([
      {
        id: expect.any(String),
        createdAt: expect.any(String),
        author: "Loop user",
        text: "> durable identity\n\nAdd a fixture.",
      },
    ]);
    const store = new BeadsStore(data, {
      ownerId: owner,
      profile: "companion",
      projectId: project,
    });
    const native = await store.read(["comments", bead]);
    expect(native).toEqual([
      expect.objectContaining({
        author: "Loop user",
        text: expect.stringContaining("> durable identity\n\nAdd a fixture."),
      }),
    ]);

    const renamed = await request("/folders/" + project, "PATCH", {
      name: "Renamed",
    });
    expect(renamed.status).toBe(200);
    expect((await request(route + "/" + bead)).body).toEqual(detail.body);
  },
  25_000,
);

it.skipIf(!realBeads)(
  "starts one run for a contested bead and unlocks its dependent only after explicit close",
  async () => {
    const { seal } = await import("../src/server/secrets.js");
    const { createAgent } = await import("../src/server/domain.js");
    const { seedConnection, seedMessage } = await import("./helpers/seed.js");
    const { claim, transition } = await import("../src/server/queue.js");
    const project = await createProject("Assignment");
    const route = "/projects/" + project + "/work";
    const enabled = await request(route, "PUT", {});
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    const { storeId } = enabled.body;
    const connection = id();
    seedConnection(db, {
      id: connection,
      owner_id: owner,
      secret: seal("fixture", owner),
      models: JSON.stringify([{ id: "fixture", name: "Fixture" }]),
      created_at: now(),
    });
    const agents = ["First", "Second"].map((name) =>
      createAgent(owner, {
        name,
        connectionId: connection,
        model: "fixture",
        folderId: project,
      }),
    );
    expect((await request(route + "/agents")).body).toHaveLength(2);
    const create = async (title: string) => {
      const result = await request(route, "POST", {
        storeId,
        requestId: randomUUID(),
        title,
      });
      expect(result.body.status).toBe("committed");
      return result.body.beadId as string;
    };
    const blocker = await create("Blocker");
    const target = await create("Target");
    expect(
      (
        await request(route + "/" + target + "/dependencies", "POST", {
          storeId,
          requestId: randomUUID(),
          blocker,
        })
      ).body.status,
    ).toBe("committed");
    expect((await request(route + "/" + target)).body).toMatchObject({
      status: "blocked",
      blockedBy: [blocker],
    });
    const start = (bead: string, agentId: string, requestId: string) =>
      request(route + "/" + bead + "/start", "POST", {
        storeId,
        requestId,
        agentId,
      });
    expect((await start(target, agents[0].id, randomUUID())).body.state).toBe(
      "refused",
    );

    const requestIds = [randomUUID(), randomUUID()];
    const competing = await Promise.all(
      agents.map((agent, index) => start(blocker, agent.id, requestIds[index])),
    );
    const won = competing.findIndex((reply) => reply.body.state === "started");
    expect(won).toBeGreaterThanOrEqual(0);
    expect(competing[1 - won].status).toBe(409);
    const winner = competing[won].body;
    expect(await start(blocker, agents[won].id, requestIds[won])).toEqual(
      competing[won],
    );
    expect(winner.canRelease).toBe(false);
    const assignment = route + "/" + blocker + "/assignment";
    expect(
      (
        await request(assignment, "POST", {
          storeId,
          generation: winner.generation,
          action: "release",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(assignment, "POST", {
          storeId,
          generation: randomUUID(),
          action: "resume",
        })
      ).status,
    ).toBe(409);

    const run = claim("beads-fixture")!;
    expect(run.conversation_id).toBe(winner.conversationId);
    const answer = "Work finished. https://github.com/example/repo/pull/42";
    const messageId = id();
    seedMessage(db, {
      id: messageId,
      owner_id: owner,
      run_id: run.id,
      conversation_id: run.conversation_id!,
      role: "assistant",
      content: answer,
      created_at: now(),
    });
    db.prepare("UPDATE runs SET result=? WHERE id=?").run(answer, run.id);
    expect(transition(run, "completed")).toBe(true);
    expect(claim("beads-fixture")).toBeUndefined();

    const link = (await request(route + "/" + blocker)).body;
    expect(link).toMatchObject({
      status: "in_progress",
      assignment: {
        canRelease: true,
        result: {
          id: "run:" + run.id,
          conversationId: run.conversation_id,
          messageId,
        },
        pulls: ["https://github.com/example/repo/pull/42"],
      },
    });
    expect((await request("/result-work/" + messageId)).body).toEqual({
      projectId: project,
      beadId: blocker,
    });
    const reopened = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'import { beadAssignmentStatus } from "./src/server/bead-assignments.ts"; console.log(JSON.stringify(await beadAssignmentStatus(...process.argv.slice(1))));',
        owner,
        project,
        blocker,
      ],
      { env: { ...process.env, LOOP_DATA_DIR: data } },
    );
    expect(JSON.parse(reopened.stdout).linkedRuns).toEqual(link.linkedRuns);
    expect((await request(route + "/" + target)).body.status).toBe("blocked");
    const close = await request(route + "/" + blocker + "/close", "POST", {
      storeId,
      requestId: randomUUID(),
      reason: "Verified acceptance criteria.",
      generation: winner.generation,
    });
    expect(close.body.status).toBe("committed");
    expect((await request(route + "/" + target)).body.status).toBe("ready");

    const source = await request(route, "POST", {
      storeId,
      requestId: randomUUID(),
      sourceResultId: "run:" + run.id,
      title: "Follow-up",
    });
    const linked = await request(route + "/" + source.body.beadId);
    expect(linked.body.sourceResult).toMatchObject({
      id: "run:" + run.id,
      messageId,
    });

    const recovery = await create("Recover committed claim");
    const requestId = randomUUID();
    const generation = randomUUID();
    const { prepare, transition: move } =
      await import("../src/server/sql/bead-assignments.js");
    const { byRequest } = await import("../src/server/sql/bead-assignments.js");
    prepare(db, {
      owner_id: owner,
      store_id: storeId,
      bead_id: recovery,
      request_id: requestId,
      generation,
      agent_id: agents[0].id,
      created_at: now(),
    });
    const receipt = byRequest(db, owner, requestId)!;
    const resume = route + "/" + recovery + "/assignment";
    expect(
      (await request(route + "/" + recovery)).body.assignment,
    ).toMatchObject({
      state: "prepared",
      canResume: true,
      conversationId: null,
    });
    expect(move(db, receipt, "claiming")).toBe(true);
    const store = new BeadsStore(data, {
      ownerId: owner,
      profile: "companion",
      projectId: project,
    });
    await store.write([
      "--actor",
      "loop-start-" + generation,
      "update",
      recovery,
      "--claim",
    ]);
    expect((await start(recovery, agents[0].id, requestId)).body).toMatchObject(
      {
        state: "claimed",
        canResume: true,
        conversationId: null,
      },
    );
    expect(claim("beads-fixture")).toBeUndefined();
    const resumed = await request(resume, "POST", {
      storeId,
      generation,
      action: "resume",
    });
    expect(resumed.body.state).toBe("started");
    expect(
      (await request(resume, "POST", { storeId, generation, action: "resume" }))
        .body,
    ).toEqual(resumed.body);
    const resumedRun = claim("beads-fixture")!;
    expect(resumedRun.conversation_id).toBe(resumed.body.conversationId);
    expect(transition(resumedRun, "cancelled")).toBe(true);
    expect(
      (
        await request(resume, "POST", {
          storeId,
          generation,
          action: "release",
        })
      ).body.state,
    ).toBe("released");
    expect((await request(route + "/" + recovery)).body.status).toBe("ready");
  },
  100_000,
);
