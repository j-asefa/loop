import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cardsFixture } from "./helpers/cards-fixture";
import { integrationTokenRequest } from "../src/shared/card-access";
import { workspaceRoutes } from "../src/shared/workspace-api";
import { isTokenMutation, type TokenScope } from "../src/shared/token-scopes";

type Fixture = Awaited<ReturnType<typeof cardsFixture>>;
async function token(f: Fixture, scopes: TokenScope[]) {
  const response = await f.request("/api/card-tokens", {
    headers: f.browser,
    body: integrationTokenRequest(scopes.join(","), scopes),
  });
  expect(response.status).toBe(201);
  const { token, secret } = await response.json();
  return {
    id: token.id as string,
    headers: { authorization: "Bearer " + secret },
  };
}
function receipt(f: Fixture, tokenId: string, identity: string) {
  return f.db
    .prepare(
      "SELECT * FROM token_requests WHERE owner_id=? AND token_id=? AND identity=?",
    )
    .get(f.owner, tokenId, identity) as Record<string, unknown> | undefined;
}
async function json(response: Response, status: number) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(JSON.stringify(body)).not.toContain("private-storage-field");
  expect(JSON.stringify(body)).not.toContain("integration-fixture-credential");
  return body;
}
function eventCount(f: Fixture) {
  return f.db
    .prepare(
      "SELECT count(*) n FROM events WHERE type IN ('queued','running','completed','cancelled','approval.decided','queue.reordered','attention.dismissed','steering.pending')",
    )
    .get();
}

it("companion commits and replays every local token write with owner isolation", async () => {
  const f = await cardsFixture(false, { projectedWrites: true });
  const records = await f.integrationRecords();
  const foreign = await f.integrationRecords("foreign-token-owner");
  const writer = await token(f, ["write"]),
    reader = await token(f, ["read"]),
    decider = await token(f, ["approvals:decide"]);
  const post = (path: string, body: unknown, credential = writer) =>
    f.request("/api" + path, { body, headers: credential.headers });
  const sendBody = (input: string) => ({
    agentId: records.agent,
    input,
    queue: true,
    idempotencyKey: randomUUID(),
  });
  for (const key of ["short", "🔁".repeat(151)]) {
    expect(
      await json(
        await post("/runs", {
          ...sendBody("Invalid key"),
          idempotencyKey: key,
        }),
        400,
      ),
    ).toMatchObject({ error: expect.any(String) });
    expect(receipt(f, writer.id, key)).toBeUndefined();
  }
  // The contract's character limits count Unicode code points, not UTF-16
  // units. Embedded NUL is also valid JSON text: storage must preserve the
  // whole key, even though SQLite's length(TEXT) stops at its first NUL.
  const firstBody = {
    ...sendBody("One durable send"),
    idempotencyKey: "1234567\u0000" + "🔁".repeat(100),
  };
  f.db.exec(
    "ALTER TABLE runs ADD COLUMN fixture_secret TEXT DEFAULT 'private-storage-field'",
  );
  f.db.exec(
    "ALTER TABLE approvals ADD COLUMN fixture_secret TEXT DEFAULT 'private-storage-field'",
  );
  const first = await json(await post("/runs", firstBody), 202);
  expect(JSON.stringify(first)).not.toContain("private-storage-field");
  expect(JSON.stringify(first)).not.toContain("integration-fixture-credential");
  expect(receipt(f, writer.id, firstBody.idempotencyKey)).toMatchObject({
    operation: "submit",
    state: "complete",
    response_status: 202,
  });
  f.db
    .prepare(
      "UPDATE runs SET state='completed',input='Current public projection' WHERE id=?",
    )
    .run(first.id);
  const before = eventCount(f);
  expect(await json(await post("/runs", firstBody), 202)).toMatchObject({
    id: first.id,
    state: "completed",
    input: "Current public projection",
  });
  expect(eventCount(f)).toEqual(before);
  expect(
    (await post("/runs", { ...firstBody, input: "Different work" })).status,
  ).toBe(409);
  expect(
    (
      await post(`/runs/${first.id}/dismiss`, {
        idempotencyKey: firstBody.idempotencyKey,
      })
    ).status,
  ).toBe(409);

  // submit also retains its existing owner-wide reconciliation across tokens.
  const second = await token(f, ["write"]);
  const sharedBody = {
    ...sendBody("Same owner-wide key"),
    idempotencyKey: "1234567\u0000second",
  };
  const shared = await json(await post("/runs", sharedBody), 202);
  expect(shared.id).not.toBe(first.id);
  expect(
    await json(await post("/runs", sharedBody, second), 202),
  ).toMatchObject({ id: shared.id });
  expect(
    f.db
      .prepare(
        "SELECT count(*) n FROM runs WHERE owner_id=? AND idempotency_key=?",
      )
      .get(f.owner, sharedBody.idempotencyKey),
  ).toEqual({ n: 1 });
  expect(receipt(f, second.id, sharedBody.idempotencyKey)?.state).toBe(
    "complete",
  );
  const replyBody = {
    ...sendBody("Quoted reply"),
    conversationId: records.conversation,
    replyToMessageId: records.reply,
    replyExcerpt: "Public fixture answer",
  };
  const reply = await json(await post("/runs", replyBody), 202);
  const replyEvents = eventCount(f);
  expect(await json(await post("/runs", replyBody), 202)).toMatchObject({
    id: reply.id,
  });
  expect(eventCount(f)).toEqual(replyEvents);
  expect(
    JSON.parse(
      (
        f.db.prepare("SELECT payload FROM runs WHERE id=?").get(reply.id) as {
          payload: string;
        }
      ).payload,
    ).replyTo,
  ).toMatchObject({ id: records.reply, content: "Public fixture answer" });

  const active = f.db
    .prepare(
      "SELECT r.id,r.conversation_id FROM runs r JOIN approvals a ON a.run_id=r.id WHERE a.id=?",
    )
    .get(records.approval) as { id: string; conversation_id: string };
  const steeringBody = {
    ...sendBody("Reply during active work"),
    conversationId: active.conversation_id,
    queue: false,
  };
  const steered = await json(await post("/runs", steeringBody), 202);
  expect(steered).toMatchObject({
    id: active.id,
    steeringId: expect.any(String),
  });
  const steeringEvents = eventCount(f);
  expect(await json(await post("/runs", steeringBody), 202)).toMatchObject({
    id: active.id,
    steeringId: steered.steeringId,
  });
  expect(
    await json(await post("/runs", steeringBody, second), 202),
  ).toMatchObject({ id: active.id, steeringId: steered.steeringId });
  expect(eventCount(f)).toEqual(steeringEvents);
  expect(
    f.db
      .prepare(
        "SELECT count(*) n FROM run_steering WHERE owner_id=? AND idempotency_key=?",
      )
      .get(f.owner, steeringBody.idempotencyKey),
  ).toEqual({ n: 1 });

  const queued = async (input: string) =>
    json(await post("/runs", sendBody(input)), 202);
  const reorderRun = await queued("Reorder");
  const reorderBody = { direction: "up", idempotencyKey: randomUUID() };
  expect(
    await json(await post(`/runs/${reorderRun.id}/reorder`, reorderBody), 200),
  ).toEqual({ ok: true });
  const ranks = f.db
      .prepare("SELECT id,queue_rank FROM runs ORDER BY id")
      .all(),
    reorderEvents = eventCount(f);
  expect(
    await json(await post(`/runs/${reorderRun.id}/reorder`, reorderBody), 200),
  ).toEqual({ ok: true });
  expect(
    f.db.prepare("SELECT id,queue_rank FROM runs ORDER BY id").all(),
  ).toEqual(ranks);
  expect(eventCount(f)).toEqual(reorderEvents);
  expect(
    (
      await post(`/runs/${reorderRun.id}/reorder`, {
        ...reorderBody,
        direction: "down",
      })
    ).status,
  ).toBe(409);

  const movedFrom = await queued("Move once");
  const moveBody = { agentId: records.agent, idempotencyKey: randomUUID() };
  const moved = await json(
    await post(`/runs/${movedFrom.id}/move`, moveBody),
    202,
  );
  expect(moved.id).not.toBe(movedFrom.id);
  f.db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(moved.id);
  const moveEvents = eventCount(f);
  expect(
    await json(await post(`/runs/${movedFrom.id}/move`, moveBody), 202),
  ).toMatchObject({ id: moved.id, state: "completed" });
  expect(eventCount(f)).toEqual(moveEvents);
  expect(
    JSON.parse(String(receipt(f, writer.id, moveBody.idempotencyKey)?.locator)),
  ).toEqual({ run: moved.id });

  for (const action of ["cancel", "dismiss"]) {
    const run = await queued(action),
      body = { idempotencyKey: randomUUID() };
    expect(
      await json(await post(`/runs/${run.id}/${action}`, body), 200),
    ).toEqual({ ok: true });
    const events = eventCount(f);
    expect(
      await json(await post(`/runs/${run.id}/${action}`, body), 200),
    ).toEqual({ ok: true });
    expect(eventCount(f)).toEqual(events);
  }
  const approvalBody = { decision: "approve", idempotencyKey: randomUUID() };
  expect(
    await json(
      await post(`/approvals/${records.approval}`, approvalBody, decider),
      200,
    ),
  ).toEqual({ ok: true });
  const decisionEvents = eventCount(f);
  expect(
    await json(
      await post(`/approvals/${records.approval}`, approvalBody, decider),
      200,
    ),
  ).toEqual({ ok: true });
  expect(eventCount(f)).toEqual(decisionEvents);
  expect(
    (
      await post(
        `/approvals/${records.approval}`,
        { ...approvalBody, decision: "reject" },
        decider,
      )
    ).status,
  ).toBe(409);

  const writes = [
    ["/runs", { agentId: records.agent, input: "Missing identity" }, writer],
    [`/runs/${shared.id}/cancel`, {}, writer],
    [`/runs/${shared.id}/reorder`, { direction: "up" }, writer],
    [`/runs/${shared.id}/withdraw`, {}, writer],
    [`/runs/${shared.id}/move`, { agentId: records.agent }, writer],
    [`/approvals/${records.approval}`, { decision: "approve" }, decider],
    [
      `/native/decisions/${records.decision}`,
      { answer: { choice: "allow" } },
      decider,
    ],
  ] as const;
  for (const [path, body, credential] of writes) {
    const receipts = f.db
      .prepare("SELECT count(*) n FROM token_requests")
      .get();
    expect((await post(path, body, reader)).status, path).toBe(403);
    const missing = await post(path, body, credential);
    expect(await json(missing, 400)).toMatchObject({
      error: expect.any(String),
    });
    expect(f.db.prepare("SELECT count(*) n FROM token_requests").get()).toEqual(
      receipts,
    );
  }
  for (const action of ["pause", "resume", "retry"]) {
    const key = randomUUID();
    expect(
      (await post(`/runs/${shared.id}/${action}`, { idempotencyKey: key }))
        .status,
    ).toBe(403);
    expect(receipt(f, writer.id, key)).toBeUndefined();
  }
  for (const path of [
    "/later",
    "/scheduled-sends",
    `/replies/${records.reply}`,
  ])
    expect((await post(path, { idempotencyKey: randomUUID() })).status).toBe(
      403,
    );
  expect(
    (
      await post(`/approvals/${records.approval}`, {
        decision: "approve",
        idempotencyKey: randomUUID(),
      })
    ).status,
  ).toBe(403);
  expect(
    (await post("/runs", sendBody("Approval scope cannot send"), decider))
      .status,
  ).toBe(403);
  for (const [path, body, credential] of [
    ["/runs", { ...sendBody("Foreign"), agentId: foreign.agent }, writer],
    [`/runs/${foreign.run}/cancel`, { idempotencyKey: randomUUID() }, writer],
    [
      `/runs/${foreign.run}/reorder`,
      { direction: "up", idempotencyKey: randomUUID() },
      writer,
    ],
    [`/runs/${foreign.run}/withdraw`, { idempotencyKey: randomUUID() }, writer],
    [
      `/runs/${foreign.run}/move`,
      { agentId: records.agent, idempotencyKey: randomUUID() },
      writer,
    ],
    [
      `/approvals/${foreign.approval}`,
      { decision: "reject", idempotencyKey: randomUUID() },
      decider,
    ],
  ] as const)
    expect((await post(path, body, credential)).status, path).toBe(404);

  // Session callers still omit optional identities, including paired CSRF.
  expect(
    (
      await post(
        `/native/decisions/${foreign.decision}`,
        { commandId: randomUUID(), answer: { choice: "allow" } },
        decider,
      )
    ).status,
  ).toBe(404);
  const sessionRun = await queued("Session cancellation");
  expect(
    (
      await f.request(`/api/runs/${sessionRun.id}/cancel`, {
        body: {},
        headers: f.browser,
      })
    ).status,
  ).toBe(200);
  for (const extra of [
    { origin: "https://foreign.example" },
    { "sec-fetch-site": "cross-site" },
  ] as Record<string, string>[])
    expect(
      (
        await f.request("/api/runs", {
          body: sendBody("Rejected origin"),
          headers: { ...writer.headers, ...extra },
        })
      ).status,
    ).toBe(403);
}, 90000);

it("companion retains identities through lost replies, rollback, restart and expiry", async () => {
  const f = await cardsFixture(),
    records = await f.integrationRecords(),
    writer = await token(f, ["write"]);
  const post = (path: string, body: unknown) =>
    f.request("/api" + path, { body, headers: writer.headers });
  const body = {
    agentId: records.agent,
    input: "Lost committed reply",
    attachmentIds: [records.file.id],
    queue: true,
    idempotencyKey: randomUUID(),
  };
  await f.tokenWriteFixture("lose-response");
  await expect(post("/runs", body)).rejects.toThrow();
  expect(receipt(f, writer.id, body.idempotencyKey)?.state).toBe("complete");
  const run = await json(await post("/runs", body), 202);
  const draftBody = { idempotencyKey: randomUUID() };
  await f.tokenWriteFixture("lose-response");
  await expect(post(`/runs/${run.id}/withdraw`, draftBody)).rejects.toThrow();
  const saved = JSON.parse(
    String(receipt(f, writer.id, draftBody.idempotencyKey)?.locator),
  );
  expect(saved).toMatchObject({
    run: run.id,
    draft: {
      input: body.input,
      attachment_ids: [records.file.id],
      attachments: [
        expect.objectContaining({ id: records.file.id, name: "fixture.txt" }),
      ],
    },
  });
  expect(f.db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual(
    { state: "cancelled" },
  );
  const beforeRestart = eventCount(f);
  await f.restart();
  expect(
    await json(await post(`/runs/${run.id}/withdraw`, draftBody), 200),
  ).toEqual(saved.draft);
  expect(await json(await post("/runs", body), 202)).toMatchObject({
    id: run.id,
    state: "cancelled",
  });
  expect(eventCount(f)).toEqual(beforeRestart);

  const rolledBack = {
    ...body,
    input: "Rollback with receipt",
    idempotencyKey: randomUUID(),
  };
  await f.tokenWriteFixture("fail-completion");
  expect((await post("/runs", rolledBack)).status).toBe(500);
  expect(receipt(f, writer.id, rolledBack.idempotencyKey)).toBeUndefined();
  expect(
    f.db
      .prepare("SELECT id FROM runs WHERE idempotency_key=?")
      .get(rolledBack.idempotencyKey),
  ).toBeUndefined();
  const restored = await json(await post("/runs", rolledBack), 202);
  f.db
    .prepare("UPDATE messages SET run_id=NULL WHERE run_id=?")
    .run(restored.id);
  f.db.prepare("DELETE FROM runs WHERE id=?").run(restored.id);
  const missing = await post("/runs", rolledBack);
  expect(await json(missing, 409)).toMatchObject({
    error: expect.stringContaining("unavailable"),
  });
  f.db
    .prepare(
      "UPDATE token_requests SET completed_at=? WHERE token_id=? AND identity=?",
    )
    .run(Date.now() - 25 * 3600000, writer.id, body.idempotencyKey);
  expect(await json(await post("/runs", body), 409)).toMatchObject({
    error: expect.stringContaining("expired"),
  });
  expect(receipt(f, writer.id, body.idempotencyKey)).toMatchObject({
    state: "complete",
    operation: null,
    request_hash: null,
    response_status: null,
    locator: null,
  });
  expect((await post("/runs", body)).status).toBe(409);
  expect(
    f.db
      .prepare("SELECT count(*) n FROM runs WHERE idempotency_key=?")
      .get(body.idempotencyKey),
  ).toEqual({ n: 1 });
}, 90000);

it("commits native pending before dispatch and never redispatches after uncertainty or restart", async () => {
  const f = await cardsFixture(),
    decider = await token(f, ["approvals:decide"]);
  const post = (decision: string, body: unknown) =>
    f.request(`/api/native/decisions/${decision}`, {
      body,
      headers: decider.headers,
    });
  const success = (await f.tokenWriteFixture("native-success"))!;
  f.db.exec(
    "ALTER TABLE native_decisions ADD COLUMN fixture_secret TEXT DEFAULT 'private-storage-field'",
  );
  const body = { commandId: randomUUID(), answer: { choice: "allow" } };
  expect(await json(await post(success.decision, body), 200)).toEqual({
    state: "resolved",
  });
  f.db
    .prepare("UPDATE native_decisions SET state='expired' WHERE id=?")
    .run(success.decision);
  expect(await json(await post(success.decision, body), 200)).toEqual({
    state: "expired",
  });
  expect(
    (await post(success.decision, { ...body, answer: { choice: "deny" } }))
      .status,
  ).toBe(409);
  f.db
    .prepare("UPDATE native_decisions SET generation=? WHERE id=?")
    .run(randomUUID(), success.decision);
  expect((await post(success.decision, body)).status).toBe(409);
  const pending: { decision: string; body: typeof body }[] = [];
  for (const action of ["native-failure", "native-success"] as const) {
    const native = (await f.tokenWriteFixture(action))!,
      request = { ...body, commandId: randomUUID() };
    if (action === "native-success")
      await f.tokenWriteFixture("fail-completion");
    expect((await post(native.decision, request)).status).toBe(
      action === "native-failure" ? 409 : 500,
    );
    expect(receipt(f, decider.id, request.commandId)?.state).toBe("pending");
    expect(await json(await post(native.decision, request), 409)).toMatchObject(
      { error: expect.stringContaining("uncertain") },
    );
    pending.push({ decision: native.decision, body: request });
  }
  const dispatches = f.db
    .prepare("SELECT * FROM fixture_token_dispatches")
    .all();
  expect(dispatches).toHaveLength(3);
  expect(
    dispatches.every(
      (row) => (row as { receipt_state: string }).receipt_state === "pending",
    ),
  ).toBe(true);
  await f.restart();
  for (const request of pending)
    expect(
      await json(await post(request.decision, request.body), 409),
    ).toMatchObject({ error: expect.stringContaining("uncertain") });
  expect(f.db.prepare("SELECT * FROM fixture_token_dispatches").all()).toEqual(
    dispatches,
  );
}, 90000);

it("documents the identity, bearer security and conditional Origin for every admitted write", () => {
  const spec = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
  const writes = Object.entries(workspaceRoutes).filter(([, contract]) =>
    isTokenMutation(contract),
  );
  expect(writes.map(([name]) => name).sort()).toEqual([
    "approval",
    "nativeAnswer",
    "runAction",
    "runMove",
    "runReorder",
    "runWithdraw",
    "submit",
  ]);
  for (const [, contract] of writes) {
    const operation =
      spec.paths["/api" + contract.path.replace(/:([^/]+)/g, "{$1}")][
        contract.method.toLowerCase()
      ];
    expect(operation["x-request-identity"]).toBe(
      "identity" in contract ? contract.identity : undefined,
    );
    expect(operation.security).toContainEqual({ IntegrationBearer: [] });
    expect(operation.responses["409"]).toEqual({
      $ref: "#/components/responses/IntegrationRequestConflict",
    });
    expect(operation.parameters).toContainEqual({
      $ref: "#/components/parameters/IntegrationWriteOrigin",
    });
  }
  expect(spec.components.parameters.IntegrationWriteOrigin.required).toBe(
    false,
  );
  expect(
    spec.components.parameters.IntegrationWriteOrigin["x-required-for"],
  ).toEqual(["PairedDevice"]);
});
