import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { cardsFixture } from "./helpers/cards-fixture";
import { integrationTokenRequest } from "../src/shared/card-access";
import type { TokenScope } from "../src/shared/token-scopes";

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
async function json(response: Response, status: number) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
function receipt(f: Fixture, tokenId: string, identity: string) {
  return f.db
    .prepare(
      "SELECT operation,state,response_status FROM token_requests WHERE owner_id=? AND token_id=? AND identity=?",
    )
    .get(f.owner, tokenId, identity) as Record<string, unknown> | undefined;
}

it("write tokens change Done read and saved state once per identity, owner-scoped", async () => {
  const f = await cardsFixture(false, { projectedWrites: true });
  const records = await f.integrationRecords();
  const second = await f.integrationRecords();
  const foreign = await f.integrationRecords("foreign-state-owner");
  const writer = await token(f, ["read", "write"]),
    reader = await token(f, ["read"]);
  const send = (
    method: string,
    path: string,
    body: unknown,
    credential: { headers: Record<string, string> } = writer,
  ) => f.request("/api" + path, { method, body, headers: credential.headers });
  const doneItem = async () => {
    const page = await json(
      await f.request("/api/feed?filter=done", { headers: writer.headers }),
      200,
    );
    const item = page.items.find(
      (candidate: { conversation_id: string; done_card_key?: string }) =>
        candidate.conversation_id === records.conversation &&
        candidate.done_card_key,
    );
    expect(item, JSON.stringify(page.items)).toBeTruthy();
    return item as {
      done_card_key: string;
      unread_version: number;
      read_at: number | null;
    };
  };
  const readPath = `/feed/${records.conversation}/read`;

  // Done card read state.
  const card = await doneItem();
  expect(card.read_at).toBeNull();
  const cardKey = card.done_card_key;
  expect(
    await json(await send("PUT", readPath, { cardKey }), 400),
  ).toMatchObject({ error: expect.stringContaining("idempotencyKey") });
  const readKey = randomUUID();
  const readBody = {
    cardKey,
    unreadVersion: card.unread_version,
    idempotencyKey: readKey,
  };
  expect(await json(await send("PUT", readPath, readBody), 200)).toEqual({
    ok: true,
  });
  expect((await doneItem()).read_at).toEqual(expect.any(Number));
  expect(receipt(f, writer.id, readKey)).toEqual({
    operation: "feedRead",
    state: "complete",
    response_status: 200,
  });
  expect(await json(await send("PUT", readPath, readBody), 200)).toEqual({
    ok: true,
  });
  expect(
    (await send("PUT", readPath, { ...readBody, unreadVersion: 99 })).status,
  ).toBe(409);
  expect(
    (
      await send("DELETE", readPath, {
        cardKey,
        idempotencyKey: readKey,
      })
    ).status,
  ).toBe(409);

  // Unread advances the version once; a replay returns the original versions.
  const unreadBody = { cardKey, idempotencyKey: randomUUID() };
  const unread = await json(await send("DELETE", readPath, unreadBody), 200);
  expect(unread).toMatchObject({
    ok: true,
    unreadVersions: expect.any(Object),
  });
  const advanced = await doneItem();
  expect(advanced.read_at).toBeNull();
  expect(await json(await send("DELETE", readPath, unreadBody), 200)).toEqual(
    unread,
  );
  expect((await doneItem()).unread_version).toBe(advanced.unread_version);

  // Saved state. Every bearer write needs its identity, including the
  // DELETE operations and a save sent with no body at all.
  expect((await send("DELETE", readPath, { cardKey })).status).toBe(400);
  const savePath = `/messages/${records.reply}/saved`;
  expect((await send("POST", savePath, {})).status).toBe(400);
  expect((await send("POST", savePath, undefined)).status).toBe(400);
  expect((await send("DELETE", savePath, {})).status).toBe(400);
  const saveBody = { idempotencyKey: randomUUID() };
  expect(await json(await send("POST", savePath, saveBody), 200)).toEqual({
    ok: true,
    saved: true,
  });
  expect(await json(await send("POST", savePath, saveBody), 200)).toEqual({
    ok: true,
    saved: true,
  });
  const saved = await json(
    await f.request("/api/saved", { headers: f.browser }),
    200,
  );
  expect(JSON.stringify(saved)).toContain(records.reply);
  expect(
    await json(
      await send("DELETE", savePath, { idempotencyKey: randomUUID() }),
      200,
    ),
  ).toEqual({ ok: true, saved: false });
  // The completed save replays its original response; it does not save again.
  expect(await json(await send("POST", savePath, saveBody), 200)).toEqual({
    ok: true,
    saved: true,
  });
  expect(
    JSON.stringify(
      await json(await f.request("/api/saved", { headers: f.browser }), 200),
    ),
  ).not.toContain(records.reply);

  // Saved Done threads.
  const thread = randomUUID();
  await json(
    await f.request("/api/feed/threads", {
      headers: f.browser,
      body: {
        id: thread,
        title: "Fixture group",
        cardIds: [`d:${cardKey}`, `d:run:${second.run}`],
      },
    }),
    200,
  );
  // Saved Done threads stay session-only: a token cannot see their members
  // or versions, so it could not tell whether a thread read took effect.
  const threadPath = `/feed/threads/${thread}/read`;
  for (const method of ["PUT", "DELETE"])
    expect(
      (await send(method, threadPath, { idempotencyKey: randomUUID() })).status,
    ).toBe(403);

  // A read with an older version answers ok but never erases a later unread.
  const current = await doneItem();
  expect(current.read_at).toBeNull();
  expect(
    await json(
      await send("PUT", readPath, {
        cardKey,
        unreadVersion: current.unread_version - 1,
        idempotencyKey: randomUUID(),
      }),
      200,
    ),
  ).toEqual({ ok: true });
  expect((await doneItem()).read_at).toBeNull();

  // A read-only token and another owner's records are refused, and a refused
  // write leaves no receipt that could later replay.
  for (const [method, path, body] of [
    ["PUT", readPath, { cardKey, idempotencyKey: randomUUID() }],
    ["DELETE", readPath, { cardKey, idempotencyKey: randomUUID() }],
    ["POST", savePath, { idempotencyKey: randomUUID() }],
    ["DELETE", savePath, { idempotencyKey: randomUUID() }],
  ] as const)
    expect((await send(method, path, body, reader)).status).toBe(403);
  for (const [method, path, body] of [
    [
      "PUT",
      `/feed/${foreign.conversation}/read`,
      { cardKey: `run:${foreign.run}`, idempotencyKey: randomUUID() },
    ],
    [
      "POST",
      `/messages/${foreign.reply}/saved`,
      { idempotencyKey: randomUUID() },
    ],
  ] as const) {
    expect((await send(method, path, body)).status).toBe(404);
    expect(receipt(f, writer.id, body.idempotencyKey)).toBeUndefined();
  }

  // Session callers keep their identity-free requests.
  expect(
    await json(
      await f.request("/api" + readPath, {
        method: "DELETE",
        headers: f.browser,
        body: { cardKey },
      }),
      200,
    ),
  ).toMatchObject({ ok: true });
  expect(
    await json(
      await f.request("/api" + savePath, { headers: f.browser, body: {} }),
      200,
    ),
  ).toEqual({ ok: true, saved: true });
  expect(
    await json(
      await f.request("/api" + threadPath, {
        method: "DELETE",
        headers: f.browser,
      }),
      200,
    ),
  ).toMatchObject({ ok: true });
}, 90000);
