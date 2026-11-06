import { expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { cardsFixture } from "./helpers/cards-fixture";
import type { TokenScope } from "../src/shared/token-scopes";
import { CardPageSchema, CardChangesSchema } from "../src/shared/cards";
import {
  integrationTokenRequest,
  type CardToken,
} from "../src/shared/card-access";

it("enforces scoped card credentials through the real companion entrypoint", async () => {
  const fixture = await cardsFixture();
  const { db, owner, request, browser, origin } = fixture;
  try {
    db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('agent',?,'Writer','writer','openai','fixture',1)",
    ).run(owner);
    db.prepare(
      "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('project',?,'project','Project',1),('foreign-project','foreign','project','Secret project',1)",
    ).run(owner);
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES('thread',?,'agent','Thread','project',1)",
    ).run(owner);
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES('run',?,'agent','thread','Prompt','completed','run',1,1)",
    ).run(owner);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES('prompt',?,'thread','run','user','Personal prompt','{\"personal\":true}',1),('assistant',?,'thread','run','assistant','Saved reply','{}',2)",
    ).run(owner, owner);
    db.prepare(
      "INSERT INTO message_bookmarks(message_id,owner_id,created_at) VALUES('assistant',?,3)",
    ).run(owner);
    const artifact = db.prepare(
      "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,title,kind,content,metadata,pinned,archived,feed_hidden,created_at,updated_at) VALUES(?,?,'agent','thread',?,'markdown','Answer',?,?,?,?,1,1)",
    );
    for (const [id, meta, pin, archive, hidden] of [
      ["result", "{}", 0, 0, 0],
      ["hidden", "{}", 1, 0, 1],
      ["upload", '{"upload":true}', 1, 0, 0],
      ["partial", '{"partial":true}', 0, 0, 0],
      ["trace", '{"tool":"private"}', 0, 0, 0],
      ["archived", "{}", 0, 1, 0],
    ] as const)
      artifact.run(id, owner, id, meta, pin, archive, hidden);
    db.prepare(
      "INSERT INTO artifacts(id,owner_id,title,kind,content,metadata,created_at,updated_at) VALUES('foreign','foreign','Secret','markdown','Secret','{}',1,1)",
    ).run();
    const create = async (scope: TokenScope, name: string = scope) => {
      const response = await request("/api/card-tokens", {
        body: integrationTokenRequest(name, [scope]),
        headers: browser,
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { token: CardToken; secret: string };
    };
    const results = await create("read"),
      all = await create("read");
    expect(results.secret).toMatch(/^loop_token_[\w-]{43}$/);
    expect(results.secret).not.toBe(all.secret);
    const headers = (secret = results.secret) => ({
      authorization: "Bearer " + secret,
    });
    for (const method of ["GET", "HEAD"]) {
      expect(
        (
          await request("/api/v1/cards?view=done", {
            headers: browser,
            method,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request("/api/v1/cards/d%3Arun%3Arun", {
            headers: browser,
            method,
          })
        ).status,
      ).toBe(200);
      for (const secret of [results.secret, all.secret]) {
        expect(
          (
            await request("/api/v1/cards?view=done", {
              headers: headers(secret),
              method,
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await request("/api/v1/cards/changes?view=done&after=unused", {
              headers: headers(secret),
              method,
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await request("/api/v1/cards/d%3Arun%3Arun", {
              headers: headers(secret),
              method,
            })
          ).status,
        ).toBe(404);
      }
    }
    const list = await request("/api/card-tokens", { headers: browser });
    const metadata = await list.json();
    expect(metadata).toHaveLength(2);
    expect(JSON.stringify(metadata)).not.toContain(results.secret);
    expect(Object.keys(metadata[0]).sort()).toEqual([
      "created_at",
      "id",
      "last_used_at",
      "name",
      "revoked_at",
      "scopes",
    ]);
    const stored = db
      .prepare("SELECT digest FROM card_tokens WHERE id=?")
      .get(results.token.id) as { digest: string };
    expect(stored.digest).toBe(
      createHash("sha256").update(results.secret).digest("hex"),
    );
    expect(stored.digest).not.toContain(results.secret);

    const productTables = [
      "artifacts",
      "messages",
      "message_bookmarks",
      "artifact_bookmarks",
      "feed_revisions",
      "runs",
      "approvals",
      "conversations",
      "saved_labels",
    ];
    const snapshot = () =>
      productTables.map((table) => db.prepare("SELECT * FROM " + table).all());
    const before = snapshot();
    const response = await request("/api/v1/cards", { headers: headers() });
    expect(response.status).toBe(200);
    const page = CardPageSchema.parse(await response.json());
    expect(page.items.map((i) => i.card.id)).toEqual(["a:result"]);
    const changes = await request(
      "/api/v1/cards/changes?after=" + page.revision,
      { headers: headers() },
    );
    expect(changes.status).toBe(200);
    expect(CardChangesSchema.parse(await changes.json()).removed).toEqual([]);
    for (const method of ["GET", "HEAD"]) {
      const detail = await request("/api/v1/cards/a%3Aresult", {
        method,
        headers: headers(),
      });
      expect(detail.status).toBe(200);
      if (method === "HEAD") expect(await detail.text()).toBe("");
      for (const view of ["saved", "sent"]) {
        expect(
          (
            await request("/api/v1/cards?view=" + view, {
              method,
              headers: headers(all.secret),
            })
          ).status,
        ).toBe(200);
      }
      for (const id of ["m:prompt", "m:assistant", "a:hidden", "a:upload"])
        expect(
          (
            await request("/api/v1/cards/" + encodeURIComponent(id), {
              method,
              headers: headers(all.secret),
            })
          ).status,
        ).toBe(200);
      for (const id of ["a:partial", "a:trace", "a:archived", "a:foreign"])
        expect(
          (
            await request("/api/v1/cards/" + encodeURIComponent(id), {
              method,
              headers: headers(all.secret),
            })
          ).status,
        ).toBe(404);
    }
    for (const query of [
      "owner=foreign",
      "project=foreign-project",
      "agent=foreign",
      "teams=foreign",
    ])
      expect(
        (await request("/api/v1/cards?" + query, { headers: headers() }))
          .status,
      ).toBeGreaterThanOrEqual(400);
    expect(snapshot()).toEqual(before);
    const usage = () =>
      (
        db
          .prepare("SELECT last_used_at FROM card_tokens WHERE id=?")
          .get(results.token.id) as { last_used_at: number }
      ).last_used_at;
    const firstUsed = usage();
    expect(firstUsed).toBeGreaterThan(0);
    await request("/api/v1/cards", { headers: headers() });
    expect(usage()).toBe(firstUsed);

    // Authorization always wins over a valid or invalid browser session.
    for (const cookie of [browser.cookie, "loop_local=invalid"])
      for (const authorization of ["Basic abc", "Bearer wrong", "Bearer", ""])
        expect(
          (
            await request("/api/v1/cards", {
              headers: { ...browser, cookie, authorization },
            })
          ).status,
        ).toBe(401);
    expect(
      (
        await request("/api/v1/cards?view=saved", {
          headers: { ...browser, ...headers() },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/v1/cards", {
          headers: { ...headers(), origin: "https://foreign.example" },
        })
      ).status,
    ).toBe(403);
    const wrong = "loop_token_" + randomBytes(32).toString("base64url");
    db.prepare(
      "INSERT INTO card_tokens(id,owner_id,name,digest,scope,created_at) VALUES('wrong','foreign','Wrong owner',?,json_array('read'),1)",
    ).run(createHash("sha256").update(wrong).digest("hex"));
    expect(
      (await request("/api/v1/cards", { headers: headers(wrong) })).status,
    ).toBe(401);
    db.pragma("ignore_check_constraints = ON");
    for (const scope of ["admin", Buffer.from('["read"]')]) {
      db.prepare("UPDATE card_tokens SET scope=? WHERE id=?").run(
        scope,
        all.token.id,
      );
      expect(
        (await request("/api/v1/cards", { headers: headers(all.secret) }))
          .status,
      ).toBe(401);
    }
    db.prepare(
      "UPDATE card_tokens SET scope=json_array('read') WHERE id=?",
    ).run(all.token.id);
    db.pragma("ignore_check_constraints = OFF");

    const forbidden = [
      "/api/card-tokens",
      "/api/v1/anything",
      "/api/objects/file",
      "/api/linked/" + "a".repeat(64) + "/v1/cards",
      "/api/agent-sources/source/v1/cards",
      "/api/v1/cards/",
      "/api/v1//cards",
      "/api/v1/cards//a:result",
      "/api/v1/cards/a%2Fresult",
      "/api/v1/cards/a%5Cresult",
      "/api/v1/cards/%ZZ",
      "/api/v1/cards/a%253Aresult",
      "/API/v1/cards",
    ];
    for (const path of forbidden)
      expect(
        (await request(path, { headers: { ...browser, ...headers() } })).status,
        path,
      ).toBeGreaterThanOrEqual(400);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
      for (const path of [
        "/api/v1/cards",
        "/api/card-tokens",
        "/api/card-tokens/" + all.token.id,
      ])
        expect(
          (
            await request(path, {
              method,
              headers: { ...browser, ...headers() },
              body: { name: "No", scopes: ["read"] },
            })
          ).status,
        ).toBe(403);
    expect(
      (
        await request("/api/v1/cards", {
          headers: { ...headers(), "x-http-method-override": "POST" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/v1/cards", {
          headers: {
            authorization: "Bearer bad",
            "x-loop-card-owner": owner,
            "x-loop-card-scope": "read",
            "x-loop-card-authenticated": "1",
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request("/api/card-tokens", {
          body: { name: "Cross site", scopes: ["read"] },
          headers: { ...browser, origin: "https://foreign.example" },
        })
      ).status,
    ).toBe(403);
    expect((await request("/api/v1/cards")).status).toBe(401);
    expect(
      (
        await request("/api/card-tokens", {
          body: { name: "No CSRF", scopes: ["read"] },
          headers: { cookie: browser.cookie, origin },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/v1/cards", {
          headers: {
            "x-loop-card-owner": owner,
            "x-loop-card-scope": "read",
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (await request("/session", { headers: { cookie: browser.cookie } }))
        .status,
    ).toBe(200);
    expect((await request("/api/v1/cards", { headers: browser })).status).toBe(
      200,
    );
    const fresh = await create("read", "Revoke from browser");
    expect(
      (
        await request("/api/card-tokens/" + fresh.token.id, {
          method: "DELETE",
          headers: browser,
        })
      ).status,
    ).toBe(200);
    for (const method of ["GET", "HEAD"])
      expect(
        (
          await request("/api/v1/cards", {
            method,
            headers: { ...browser, ...headers(fresh.secret) },
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await request("/api/card-tokens/wrong", {
          method: "DELETE",
          headers: browser,
        })
      ).status,
    ).toBe(404);

    const window = Math.floor(Date.now() / 60000);
    db.prepare(
      "UPDATE card_tokens SET request_window=?,request_count=120 WHERE id=?",
    ).run(window, results.token.id);
    const limited = await request("/api/v1/cards", { headers: headers() });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(
      (await request("/api/v1/cards", { headers: headers(all.secret) })).status,
    ).toBe(200);
    db.prepare(
      "UPDATE card_owner_limits SET window=?,count=600 WHERE owner_id=?",
    ).run(window, owner);
    expect(
      (await request("/api/v1/cards", { headers: headers(all.secret) })).status,
    ).toBe(429);
    // Revocation bypasses usage throttling and remains effective under limits.
    expect(
      (
        await request("/api/card-tokens/" + results.token.id, {
          method: "DELETE",
          headers: browser,
        })
      ).status,
    ).toBe(200);
    expect(
      (await request("/api/v1/cards", { headers: headers() })).status,
    ).toBe(401);
  } finally {
    await fixture.close();
  }
}, 60000);

it("keeps bearer reads bound to the paired owner, whatever owner the request names", async () => {
  const fixture = await cardsFixture();
  try {
    const { owner, db, request, browser } = fixture;
    const other = "another-owner";
    for (const id of [owner, other])
      db.prepare(
        "INSERT INTO artifacts(id,owner_id,title,kind,content,created_at,updated_at) VALUES(?,?,?,'markdown',?,1,1)",
      ).run(id, id, "Owner " + id, "Private body " + id);
    const create = await request("/api/card-tokens", {
      headers: browser,
      body: integrationTokenRequest("Owner token", ["read"]),
    });
    expect(create.status).toBe(201);
    const { secret, token } = await create.json();
    const bearer = {
      authorization: "Bearer " + secret,
      "x-loop-card-owner": other,
    };
    const response = await request("/api/v1/cards", { headers: bearer });
    expect(response.status).toBe(200);
    expect(
      (await response.json()).items.map(
        (i: { card: { id: string } }) => i.card.id,
      ),
    ).toEqual(["a:" + owner]);
    expect(
      (await request("/api/v1/cards/a%3A" + other, { headers: bearer })).status,
    ).toBe(404);
    expect(
      (await request("/api/v1/cards?view=saved", { headers: bearer })).status,
    ).toBe(200);
    expect((await request("/api/bootstrap", { headers: bearer })).status).toBe(
      200,
    );
    expect(
      (
        await request("/api/v1/cards", {
          headers: { authorization: "Bearer invalid" },
        })
      ).status,
    ).toBe(401);
    expect((await request("/api/v1/cards")).status).toBe(401);
    expect(
      (
        await request("/api/card-tokens/" + token.id, {
          headers: browser,
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    expect((await request("/api/v1/cards", { headers: bearer })).status).toBe(
      401,
    );
  } finally {
    await fixture.close();
  }
}, 30000);

it("reconciles token creation identities, enforces issuance bounds and never revives a pruned revoked request", async () => {
  const fixture = await cardsFixture();
  try {
    const { request, browser, db, owner } = fixture;
    const draft = integrationTokenRequest("Stable creation", ["read"]);
    const create = (body = draft) =>
      request("/api/card-tokens", { headers: browser, body });
    const first = await create();
    expect(first.status).toBe(201);
    const made = await first.json();
    expect(made.secret).toBe(draft.secret);
    expect(await (await create()).json()).toEqual(made);
    expect(
      db
        .prepare("SELECT count(*) n FROM card_tokens WHERE owner_id=?")
        .get(owner),
    ).toEqual({ n: 1 });
    expect((await create({ ...draft, scopes: ["write"] })).status).toBe(409);
    expect(
      (
        await create({
          ...draft,
          secret: integrationTokenRequest("other", ["read"]).secret,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("/api/card-tokens", {
          headers: browser,
          body: { name: "Missing identity", scopes: ["read"] },
        })
      ).status,
    ).toBe(400);
    expect(
      (await create({ ...draft, request_id: crypto.randomUUID() })).status,
    ).toBe(409);
    for (let n = 0; n < 49; n++)
      expect(
        (await create(integrationTokenRequest("Token " + n, ["read"]))).status,
      ).toBe(201);
    expect(
      (await create(integrationTokenRequest("Over limit", ["read"]))).status,
    ).toBe(409);
    expect((await create()).status).toBe(201); // Same operation still succeeds at the active cap.
    expect(
      (await create({ ...draft, request_id: crypto.randomUUID() })).status,
    ).toBe(409);
    await request("/api/card-tokens/" + made.token.id, {
      headers: browser,
      method: "DELETE",
    });
    expect((await create()).status).toBe(409);
    expect(
      (await create({ ...draft, request_id: crypto.randomUUID() })).status,
    ).toBe(409);
    db.prepare("UPDATE card_tokens SET revoked_at=1 WHERE owner_id=?").run(
      owner,
    );
    for (let n = 0; n < 3; n++) {
      const next = await (
        await create(integrationTokenRequest("New " + n, ["read"]))
      ).json();
      await request("/api/card-tokens/" + next.token.id, {
        headers: browser,
        method: "DELETE",
      });
    }
    // Force this old identity outside the bounded recent-metadata history.
    db.prepare("UPDATE card_tokens SET revoked_at=0 WHERE id=?").run(
      made.token.id,
    );
    await create(integrationTokenRequest("Prune history", ["read"]));
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM card_tokens WHERE owner_id=? AND revoked_at IS NOT NULL",
        )
        .get(owner),
    ).toEqual({ n: 50 });
    expect(
      db.prepare("SELECT 1 FROM card_tokens WHERE id=?").get(made.token.id),
    ).toBeUndefined();
    expect((await create()).status).toBe(409);
    expect(
      (await create({ ...draft, request_id: crypto.randomUUID() })).status,
    ).toBe(409);
    expect(
      (
        await request("/api/v1/cards", {
          headers: { authorization: "Bearer " + draft.secret },
        })
      ).status,
    ).toBe(401);
  } finally {
    await fixture.close();
  }
}, 30000);

it("does not disclose never-readable identities through scoped companion removals", async () => {
  const fixture = await cardsFixture();
  try {
    const { request, browser, db, owner } = fixture;
    const make = async (scope: TokenScope) => {
      const response = await request("/api/card-tokens", {
        headers: browser,
        body: integrationTokenRequest("Visibility", [scope]),
      });
      expect(response.status).toBe(201);
      return (await response.json()).secret as string;
    };
    const secret = await make("read"),
      fresh = await make("read");
    const headers = { authorization: "Bearer " + secret };
    const start = await (await request("/api/v1/cards", { headers })).json();
    const insert = db.prepare(
      "INSERT INTO artifacts(id,owner_id,title,kind,content,metadata,feed_hidden,created_at,updated_at) VALUES(?,?,'Fixture','markdown','Body',?,?,1,1)",
    );
    insert.run("private-upload", owner, '{"upload":true}', 0);
    insert.run("never-visible", owner, "{}", 1);
    insert.run("public", owner, "{}", 0);
    const update = await (
      await request("/api/v1/cards/changes?after=" + start.revision, {
        headers,
      })
    ).json();
    expect(update.removed).toEqual([]);
    expect(
      update.items.map((i: { card: { id: string } }) => i.card.id),
    ).toEqual(["a:public"]);
    expect(JSON.stringify(update)).not.toContain("private-upload");
    expect(JSON.stringify(update)).not.toContain("never-visible");
    db.prepare("UPDATE artifacts SET feed_hidden=1 WHERE id='public'").run();
    const hidden = await (
      await request("/api/v1/cards/changes?after=" + update.revision, {
        headers,
      })
    ).json();
    expect(hidden.removed).toEqual(["a:public"]);
    const unobserved = await (
      await request("/api/v1/cards/changes?after=" + update.revision, {
        headers: { authorization: "Bearer " + fresh },
      })
    ).json();
    expect(unobserved.removed).toEqual([]);
    db.prepare("UPDATE artifacts SET feed_hidden=0 WHERE id='public'").run();
    const detail = await request("/api/v1/cards/a%3Apublic", {
      headers: { authorization: "Bearer " + fresh },
    });
    expect(detail.status).toBe(200);
    db.prepare(
      "DELETE FROM artifacts WHERE id IN ('public','private-upload','never-visible')",
    ).run();
    const removed = await (
      await request("/api/v1/cards/changes?after=" + hidden.revision, {
        headers: { authorization: "Bearer " + fresh },
      })
    ).json();
    expect(removed.removed).toEqual(["a:public"]);
    // Plain owner-session synchronization still produces complete selection tombstones.
    const ownerDelta = await (
      await request("/api/v1/cards/changes?after=" + start.revision, {
        headers: browser,
      })
    ).json();
    expect(ownerDelta.removed).toContain("a:public");
    // IDs are decoded exactly once at both real boundaries, including literal
    // percent characters that resemble another encoded path separator.
    for (const id of ["foo%bar", "literal%2Fsegment"]) {
      insert.run(id, owner, "{}", 0);
      for (const credential of [browser, headers]) {
        const listed = await (
          await request("/api/v1/cards", { headers: credential })
        ).json();
        expect(
          listed.items.some(
            (item: { card: { id: string } }) => item.card.id === "a:" + id,
          ),
        ).toBe(true);
        for (const method of ["GET", "HEAD"]) {
          const detail = await request(
            "/api/v1/cards/" + encodeURIComponent("a:" + id),
            { headers: credential, method },
          );
          expect(detail.status).toBe(200);
          if (method === "GET")
            expect((await detail.json()).id).toBe("a:" + id);
          else expect(await detail.text()).toBe("");
        }
      }
    }
  } finally {
    await fixture.close();
  }
}, 30000);
