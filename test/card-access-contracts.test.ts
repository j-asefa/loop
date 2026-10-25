import { expect, it } from "vitest";
import { cardReadRoute, cardTokenRequest } from "../src/shared/card-access";
import { CardIdSchema } from "../src/shared/cards";
import { workspaceApi } from "../src/shared/workspace-api";
import { cardsFixture } from "./helpers/cards-fixture";

async function publishCard(fixture: Awaited<ReturnType<typeof cardsFixture>>) {
  const response = await fixture.request("/api/artifacts", {
    headers: fixture.browser, body: { title: "Contract card", content: "Published content" },
  });
  expect(response.status).toBe(201);
  return (await response.json()).id as string;
}

// Frozen admission predicate from before the registry fold. In particular, URL
// normalization must not turn a refused raw target into a trusted companion read.
function previous(method: string | undefined, target: string | undefined) {
  if (method !== "GET" && method !== "HEAD") return null;
  const path = (target || "").split("?", 1)[0];
  if (path === "/api/v1/cards") return { kind: "list" };
  if (path === "/api/v1/cards/changes") return { kind: "changes" };
  const match = /^\/api\/v1\/cards\/([^/]+)$/.exec(path);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return CardIdSchema.safeParse(id).success ? { kind: "detail", id } : null;
  } catch { return null; }
}

it("keeps the literal Cards admission boundary when paths come from contracts", () => {
  const targets = [undefined, "", "/api/v1/cards", "/api/v1/cards?view=done", "/api/v1/cards/changes?after=cursor",
    "/api/v1/cards/changes", "/api/v1/cards/", "/api/v1/cards/changes/", "/api/V1/cards", "/api/v1/Cards",
    "https://loop.example/api/v1/cards", "/api//v1/cards", "/api/v1/cards/../cards", "/api/v1/cards#fragment",
    "/api/card-tokens", "/api/v1/cards/changes?after=%FF",
    "/api/v1/cards\n", "/api/v1/cards/changes\n", "/api/v1/cards\r", "/api/v1/cards\u2028", "/api/v1/cards\u2029"];
  for (const id of ["a:one", "m:message", "d:message:done", "a%3Aone", "a%253Aone", "a:%", "a:%25",
    "a:two%20words", "a:one%2Ftwo", "a:one%5Ctwo", "a:one%3Ftwo", "a:one%23two", "a:%FF", "a:", "other", "a:" + "x".repeat(159)])
    for (const suffix of ["", "?view=results", "/", "/extra"])
      targets.push("/api/v1/cards/" + id + suffix);
  for (const method of [undefined, "", "GET", "HEAD", "get", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    for (const target of targets)
      expect(cardReadRoute(method, target), `${method} ${target}`).toEqual(previous(method, target));
});

it.each(["server", "companion", "multi-user"] as const)(
  "%s enforces NoBody for raw GET and HEAD through session and both bearer grants",
  async mode => {
    const fixture = await cardsFixture(mode);
    try {
      const id = await publishCard(fixture);
      const credentials: [string, Record<string, string>][] = [["session", fixture.browser]];
      for (const scope of ["results:read", "cards:read"] as const) {
        const created = await fixture.request("/api/card-tokens", { headers: fixture.browser, body: cardTokenRequest(scope, scope) });
        expect(created.status).toBe(201);
        const { secret } = workspaceApi.cardTokenCreate.response.parse(await created.json());
        credentials.push([scope, { authorization: "Bearer " + secret }]);
      }
      const first = await fixture.request("/api/v1/cards", { headers: fixture.browser });
      expect(first.status).toBe(200);
      const page = workspaceApi.cardList.response.parse(await first.json());
      expect(page.items.some(item => item.card.id === "a:" + id)).toBe(true);
      const reads = [
        ["/api/v1/cards", workspaceApi.cardList.response],
        ["/api/v1/cards/changes?after=" + encodeURIComponent(page.revision), workspaceApi.cardChanges.response],
        ["/api/v1/cards/" + encodeURIComponent("a:" + id), workspaceApi.cardDetail.response],
      ] as const;
      for (const [identity, headers] of credentials) {
        for (const [path, schema] of reads) {
          for (const method of ["GET", "HEAD"]) {
            const valid = await fixture.request(path, { method, headers });
            expect(valid.status, `${identity} ${method} ${path}`).toBe(200);
            if (method === "GET") expect(schema.safeParse(await valid.json()).success).toBe(true);
            else expect(await valid.text()).toBe("");
            const invalid = await fixture.request(path, { method, headers, body: {} });
            expect(invalid.status, `${identity} ${method} ${path} with JSON body`).toBe(400);
            if (method === "GET") expect(await invalid.json()).toEqual({ error: expect.any(String) });
            else expect(await invalid.text()).toBe("");
          }
        }
      }
    } finally { await fixture.close(); }
  }, 30_000,
);

it("validates detail output before persisting a bearer read receipt", async () => {
  const fixture = await cardsFixture("server");
  try {
    const id = await publishCard(fixture);
    const created = await fixture.request("/api/card-tokens", { headers: fixture.browser, body: cardTokenRequest("Receipt", "results:read") });
    expect(created.status).toBe(201);
    const { token, secret } = workspaceApi.cardTokenCreate.response.parse(await created.json());
    // Corrupt one stored display value after the production write. A failed
    // projection must neither disclose its details nor count as a delivered card.
    fixture.db.prepare("UPDATE artifacts SET created_at=-1 WHERE id=?").run(id);
    const response = await fixture.request("/api/v1/cards/" + encodeURIComponent("a:" + id), { headers: { authorization: "Bearer " + secret } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The workspace response is unavailable. Please try again." });
    expect(fixture.db.prepare("SELECT count(*) n FROM card_token_reads WHERE token_id=? AND card_id=?").get(token.id, "a:" + id)).toEqual({ n: 0 });
  } finally { await fixture.close(); }
});
