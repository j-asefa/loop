import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { cardsFixture } from "./helpers/cards-fixture";
import { seedCards } from "./helpers/seed-cards";
import { createCardClient } from "../src/shared/card-client";
import { CardCollection } from "../src/shared/card-sync";
import type { CardSelection } from "../src/shared/cards";
import { cardTokenRequest } from "../src/shared/card-access";
import { workspaceApi, workspaceRoutes } from "../src/shared/workspace-api";

it.each(["companion"] as const)(
  "runs the example and reconciles complete collections through %s",
  async (mode) => {
    const fixture = await cardsFixture(mode);
    try {
      await seedCards(fixture, 107);
      const spec = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
      const managementHeaders = (method: string, path: string) => {
        const operation = spec.paths[path][method];
        const requirement = operation.security.find(
          (s: any) => "PairedDevice" in s,
        );
        const credentials: Record<string, string> = {
          PairedDevice: fixture.browser.cookie,
          PairedCsrf: fixture.browser["x-loop-csrf"],
        };
        // Non-browser requests supply exactly the header names/values declared
        // by the chosen security alternative, without rewriting cookie names.
        const headers: Record<string, string> = {};
        for (const name of Object.keys(requirement)) {
          const scheme = spec.components.securitySchemes[name];
          expect(scheme.in).toBe("header");
          headers[scheme.name] = credentials[name];
        }
        for (const entry of operation.parameters) {
          // Parameter Object references carry the same header requirements
          // as inline parameters in the generated OpenAPI document.
          const parameter = entry.$ref
            ? entry.$ref
                .slice(2)
                .split("/")
                .reduce(
                  (node: any, key: string) =>
                    node[key.replaceAll("~1", "/").replaceAll("~0", "~")],
                  spec,
                )
            : entry;
          if (
            parameter.in === "header" &&
            parameter.required &&
            parameter.name === "Origin"
          )
            headers.Origin = fixture.origin;
        }
        return headers;
      };
      const createHeaders = managementHeaders("post", "/api/card-tokens");
      const withoutOrigin = { ...createHeaders };
      delete withoutOrigin.Origin;
      expect(
        (
          await fixture.request("/api/card-tokens", {
            headers: withoutOrigin,
            body: cardTokenRequest("Missing Origin", "cards:read"),
          })
        ).status,
      ).toBe(403);
      const withoutCsrf: Record<string, string> = { ...createHeaders };
      delete withoutCsrf["x-loop-csrf"];
      expect(
        (
          await fixture.request("/api/card-tokens", {
            headers: withoutCsrf,
            body: cardTokenRequest("Missing CSRF", "cards:read"),
          })
        ).status,
      ).toBe(403);
      const response = await fixture.request("/api/card-tokens", {
        headers: createHeaders,
        body: cardTokenRequest("Example", "cards:read"),
      });
      expect(response.status).toBe(201);
      const { secret, token } = await response.json();
      const client = createCardClient({
        baseUrl: fixture.origin,
        token: secret,
      });
      const selection: CardSelection = { view: "results", project: "project" };
      let wrote = false;
      const collection = new CardCollection(
        {
          ...client,
          list: async (...args) => {
            const page = await client.list(...args);
            if (!wrote) {
              wrote = true;
              fixture.db
                .prepare(
                  "UPDATE artifacts SET content='Edited during backfill' WHERE id='result-106'",
                )
                .run();
              fixture.db
                .prepare(
                  "UPDATE artifacts SET feed_hidden=1 WHERE id='result-105'",
                )
                .run();
              fixture.db
                .prepare(
                  "UPDATE artifacts SET folder_id='other' WHERE id='result-104'",
                )
                .run();
              fixture.db
                .prepare("DELETE FROM artifacts WHERE id='result-103'")
                .run();
            }
            return page;
          },
        },
        selection,
      );
      selection.project = "other"; // Caller mutation cannot retarget a live cache.
      const first = await collection.sync();
      expect(first).toHaveLength(104);
      const revokeHeaders = managementHeaders(
        "delete",
        "/api/card-tokens/{id}",
      );
      const revokeWithoutOrigin = { ...revokeHeaders };
      delete revokeWithoutOrigin.Origin;
      expect(
        (
          await fixture.request("/api/card-tokens/" + token.id, {
            method: "DELETE",
            headers: revokeWithoutOrigin,
          })
        ).status,
      ).toBe(403);
      expect(
        first.find((e) => e.card.id === "a:result-106")?.card.content,
      ).toBe("Edited during backfill");
      expect(
        first.some((e) =>
          ["a:result-105", "a:result-104", "a:result-103"].includes(e.card.id),
        ),
      ).toBe(false);
      fixture.db
        .prepare(
          "UPDATE artifacts SET folder_id='project' WHERE id='result-104'",
        )
        .run();
      fixture.db
        .prepare(
          "UPDATE artifacts SET content='Old history edited' WHERE id='result-000'",
        )
        .run();
      const final = await collection.sync();
      expect(final).toHaveLength(105);
      expect(final.slice(0, 2).map((e) => e.card.id)).toEqual([
        "a:result-106",
        "a:result-104",
      ]);
      expect(
        final.find((e) => e.card.id === "a:result-000")?.card.content,
      ).toBe("Old history edited");
      for (const view of ["saved", "sent"] as const) {
        const cache = new CardCollection(client, { view });
        const before = await cache.sync();
        expect(before.length).toBeGreaterThan(100);
        if (view === "saved")
          fixture.db
            .prepare("UPDATE artifacts SET pinned=0 WHERE id='result-001'")
            .run();
        else
          fixture.db
            .prepare(
              "UPDATE messages SET metadata='{\"personal\":false}',content='No longer personal' WHERE id='message-001'",
            )
            .run();
        const after = await cache.sync();
        const id = view === "saved" ? "a:result-001" : "m:message-001";
        expect(before.some((e) => e.card.id === id)).toBe(true);
        expect(after.some((e) => e.card.id === id)).toBe(false);
      }
      // Execute the documented CLI, not a reimplementation, against each host.
      const unicodeBody = "雪🙂 café ".repeat(2000);
      fixture.db
        .prepare("UPDATE artifacts SET content=? WHERE id='result-050'")
        .run(unicodeBody);
      const linkedExample = join(fixture.dir, "cards-example.ts");
      symlinkSync(resolve("examples/cards-sync.ts"), linkedExample);
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", linkedExample],
          {
            env: {
              ...process.env,
              CARDS_BASE_URL: fixture.origin,
              CARDS_TOKEN: secret,
              CARDS_VIEW: "results",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.on("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(stderr)),
        );
      });
      expect(output).not.toContain(secret);
      const example = JSON.parse(output);
      expect(
        example.projects
          .flatMap((p: any) => p.cards)
          .find((c: any) => c.entry.card.id === "a:result-050").entry.card
          .content,
      ).toBe(unicodeBody);
      expect(example.source).toBe(fixture.origin);
      expect(
        example.projects.flatMap((p: { cards: unknown[] }) => p.cards),
      ).toHaveLength(105);
      expect(example.projects[0].cards[0].id).toMatch(
        new RegExp("^" + fixture.origin + "#a:"),
      );
      // Run the example's returned synchronizer again, including its grouping,
      // instead of only proving that the CLI can make its first request.
      const { syncExample } = await import("../examples/cards-sync.js");
      const environment = {
        CARDS_BASE_URL: fixture.origin,
        CARDS_TOKEN: secret,
      };
      const readExample = await syncExample(environment);
      const flattened = (result: any) =>
        result.projects.flatMap((p: any) => p.cards);
      expect(flattened(await readExample())).toHaveLength(105);
      fixture.db
        .prepare("UPDATE artifacts SET folder_id='other' WHERE id='result-001'")
        .run();
      fixture.db
        .prepare(
          "UPDATE artifacts SET content='Example reconciled edit' WHERE id='result-002'",
        )
        .run();
      fixture.db
        .prepare("UPDATE artifacts SET feed_hidden=1 WHERE id='result-003'")
        .run();
      fixture.db.prepare("DELETE FROM artifacts WHERE id='result-004'").run();
      const reconciled = await readExample();
      expect(flattened(reconciled)).toHaveLength(103);
      expect(
        reconciled.projects
          .find((p: any) => p.name === "Other project")
          ?.cards.map((c: any) => c.entry.card.id),
      ).toEqual(["a:result-001"]);
      expect(
        flattened(reconciled).find(
          (c: any) => c.entry.card.id === "a:result-002",
        ).entry.card.content,
      ).toBe("Example reconciled edit");
      const readSaved = await syncExample({
        ...environment,
        CARDS_VIEW: "saved",
      });
      const initialSaved = flattened(await readSaved());
      fixture.db
        .prepare("UPDATE artifacts SET pinned=0 WHERE id='result-005'")
        .run();
      fixture.db
        .prepare("DELETE FROM message_bookmarks WHERE message_id='message-005'")
        .run();
      const unsaved = flattened(await readSaved());
      expect(unsaved).toHaveLength(initialSaved.length - 2);
      expect(
        unsaved.some((c: any) =>
          ["a:result-005", "m:message-005"].includes(c.entry.card.id),
        ),
      ).toBe(false);
      fixture.db
        .prepare("UPDATE artifacts SET pinned=1 WHERE id='result-005'")
        .run();
      fixture.db
        .prepare(
          "INSERT INTO message_bookmarks(message_id,owner_id,created_at) VALUES('message-005',?,?)",
        )
        .run(fixture.owner, Date.now());
      const savedAgain = flattened(await readSaved());
      expect(savedAgain).toHaveLength(initialSaved.length);
      expect(
        new Set(savedAgain.slice(0, 2).map((c: any) => c.entry.card.id)),
      ).toEqual(new Set(["a:result-005", "m:message-005"]));
      // Reproduce the initial v1 wire shape from the captured base, including
      // through the actual paired host. Missing additions must not hide bodies.
      const older = createCardClient({
        baseUrl: fixture.origin,
        token: secret,
        fetch: async (...args) => {
          const response = await fetch(...args);
          if (!response.ok) return response;
          const body = await response.json();
          const strip = (card: any) => {
            delete card.source.agent_id;
            if (card.type === "result")
              for (const key of [
                "size",
                "text",
                "download",
                "source",
                "refreshable",
                "app",
              ])
                delete card.display[key];
          };
          if (body.items) body.items.forEach((entry: any) => strip(entry.card));
          else strip(body);
          return Response.json(body);
        },
      });
      const oldPage = await older.list({ limit: 1 });
      const oldCard = oldPage.items[0].card;
      expect(oldCard.type === "result" && oldCard.display).toMatchObject({
        size: null,
        text: false,
        download: null,
        source: null,
        refreshable: false,
        app: false,
      });
      expect(await older.detail(oldCard.id)).toEqual(oldCard);
      fixture.db
        .prepare(
          "UPDATE artifacts SET content='Older source edited' WHERE id=?",
        )
        .run(oldCard.source.artifact_id);
      const oldDelta = await older.changes({ after: oldPage.revision });
      expect(
        oldDelta.items.find((entry) => entry.card.id === oldCard.id)?.card
          .content,
      ).toBe("Older source edited");
      expect(
        (await older.list({ view: "sent", limit: 1 })).items[0].card.type,
      ).toBe("message");

      fixture.db
        .prepare(
          "UPDATE card_tokens SET request_window=?,request_count=120 WHERE id=?",
        )
        .run(Math.floor(Date.now() / 60000), token.id);
      await expect(client.list()).rejects.toMatchObject({
        status: 429,
        retryAfter: 60,
      });
      // Exercise actual token admission on page two, accelerating only the
      // advertised wait and advancing this fixture's token window at that point.
      fixture.db
        .prepare(
          "UPDATE card_tokens SET request_window=0,request_count=0 WHERE id=?",
        )
        .run(token.id);
      const schedule = globalThis.setTimeout;
      let waits = 0,
        firstPages = 0;
      const clock = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: any,
        ms: number,
        ...args: any[]
      ) => {
        if (ms === 60000) {
          waits++;
          fixture.db
            .prepare(
              "UPDATE card_tokens SET request_window=0,request_count=0 WHERE id=?",
            )
            .run(token.id);
          fixture.db
            .prepare(
              "UPDATE artifacts SET content='Edited while throttled' WHERE id='result-106'",
            )
            .run();
        }
        return schedule(callback, ms === 60000 ? 0 : ms, ...args);
      }) as typeof setTimeout);
      try {
        const paced = new CardCollection(
          {
            ...client,
            list: async (...args) => {
              const page = await client.list(...args);
              if (!args[0]?.before) {
                firstPages++;
                fixture.db
                  .prepare(
                    "UPDATE card_tokens SET request_count=120 WHERE id=?",
                  )
                  .run(token.id);
              }
              return page;
            },
          },
          { view: "results" },
        );
        const resumed = await paced.sync();
        expect(resumed).toHaveLength(103);
        expect(
          resumed.find((entry) => entry.card.id === "a:result-106")?.card
            .content,
        ).toBe("Edited while throttled");
        expect(firstPages).toBe(1);
        expect(waits).toBe(1);
      } finally {
        clock.mockRestore();
      }
      expect(
        (
          await fixture.request("/api/card-tokens/" + token.id, {
            method: "DELETE",
            headers: revokeHeaders,
          })
        ).status,
      ).toBe(200);
      await expect(client.list()).rejects.toMatchObject({ status: 401 });
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("generates a schema with resolvable references and the runtime read/management operations", () => {
  const spec = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
  expect(spec.components.securitySchemes).not.toHaveProperty("OwnerSession");
  const walk = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      expect(value.$ref).toMatch(
        /^#\/components\/(schemas|responses|parameters)\//,
      );
      const target = value.$ref
        .slice(2)
        .split("/")
        .reduce(
          (node: any, key: string) =>
            node?.[key.replaceAll("~1", "/").replaceAll("~0", "~")],
          spec,
        );
      expect(target, value.$ref).toBeDefined();
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(spec);
  // A consumer follows Response Object references before interpreting the
  // status, content and rate-limit headers. Both reads and writes keep the
  // same error contract; the previously published Cards objects stay inline.
  for (const operation of Object.values(spec.paths).flatMap((path) =>
    Object.values(path as Record<string, any>),
  )) {
    for (const requirement of operation.security)
      for (const scheme of Object.keys(requirement))
        expect(
          spec.components.securitySchemes,
          operation.operationId,
        ).toHaveProperty(scheme);
    if (!operation.responses[400]?.$ref) continue;
    for (const status of [400, 401, 403, 429, 500]) {
      const reference = operation.responses[status].$ref;
      expect(reference).toMatch(/^#\/components\/responses\//);
      const response = spec.components.responses[reference.split("/").at(-1)];
      expect(response.description).toBeTruthy();
      expect(response.content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/Error",
      });
      if (status === 429)
        expect(response.headers["Retry-After"].schema).toEqual({
          type: "integer",
          minimum: 1,
        });
    }
  }
  expect(spec.paths["/api/v1/cards"].get.responses[400].$ref).toBeUndefined();
  for (const [key, contract] of Object.entries(workspaceRoutes)) {
    const path = "/api" + contract.path.replace(/[:*]([^/]+)/g, "{$1}");
    expect(spec.paths[path][contract.method.toLowerCase()].operationId).toBe(
      key,
    );
  }
  expect(spec.paths["/api/bootstrap"].get.security).toEqual([
    { IntegrationBearer: [] },
    { PairedDevice: [] },
  ]);
  expect(spec.paths["/api/bootstrap"].get.requestBody).toBeUndefined();
  expect(spec.paths["/api/runs"].post.responses["202"]).toBeDefined();
  expect(spec.paths["/api/runs"].post.responses["200"]).toBeUndefined();
  expect(spec.paths["/api/runs/{id}/{action}"].post.requestBody.required).toBe(
    false,
  );
  expect(
    spec.paths["/api/runs/{id}/{action}"].post.parameters
      .filter((p: any) => p.in === "path")
      .map((p: any) => p.name),
  ).toEqual(["id", "action"]);
  // Attachment IDs are deduplicated by an input transform. The document must
  // still describe the accepted array, without requiring the defaulted field.
  expect(
    spec.components.schemas.submitBody.properties.attachmentIds,
  ).toMatchObject({ type: "array", maxItems: 8, default: [] });
  expect(spec.components.schemas.submitBody.required).not.toContain(
    "attachmentIds",
  );
  expect(spec.paths["/api/agent-sources"].get.security).toEqual([
    { PairedDevice: [] },
  ]);
  expect(spec.paths).not.toHaveProperty("/api/mcp-sharing");
  expect(
    spec.paths["/api/mcp/oauth/callback"].get.responses[302].headers.Location,
  ).toBeDefined();
  expect(
    spec.paths["/api/mcp/oauth/callback"].get.responses[302].content,
  ).toBeUndefined();
  expect(spec.paths["/api/agents/{id}/tools"].put.responses[410]).toBeDefined();
  const optionalAccountSession = new Set(["authSession"]);
  for (const path of Object.values(spec.paths) as any[])
    for (const operation of Object.values(path) as any[])
      expect(
        operation.security.filter(
          (requirement: object) => Object.keys(requirement).length === 0,
        ),
        operation.operationId,
      ).toHaveLength(optionalAccountSession.has(operation.operationId) ? 1 : 0);
  for (const path of ["/capabilities", "/health"])
    expect(spec.paths["/api" + path].get.security).toEqual([]);
  expect(
    spec.paths["/api/v1/cards"].get.parameters.map((p: any) => p.name),
  ).toEqual(
    expect.arrayContaining([
      "view",
      "project",
      "agent",
      "teams",
      "q",
      "limit",
      "before",
    ]),
  );
  expect(
    spec.paths["/api/v1/cards/changes"].get.parameters.map((p: any) => p.name),
  ).toContain("after");
  expect(
    spec.paths["/api/v1/cards/{id}"].head.responses["200"].content,
  ).toBeUndefined();
  expect(spec.paths["/api/card-tokens"].post.requestBody.required).toBe(true);
  expect(spec.paths["/api/card-tokens"].get.responses["409"]).toBeUndefined();
  expect(
    spec.paths["/api/card-tokens/{id}"].delete.responses["409"],
  ).toBeUndefined();
  expect(
    spec.paths["/api/card-tokens/{id}"].delete.responses["404"].description,
  ).toContain("Token");
  expect(
    spec.paths["/api/card-tokens"].post.responses["409"].description,
  ).toContain("Creation conflict");
  expect(
    spec.paths["/api/v1/cards/changes"].get.responses["409"].description,
  ).toContain("Cursor");
  for (const method of ["get", "head"]) {
    const list = spec.paths["/api/v1/cards"][method].parameters;
    expect(list.filter((p: any) => p.required)).toEqual([]);
    expect(list.find((p: any) => p.name === "view").schema.default).toBe(
      "results",
    );
    expect(list.find((p: any) => p.name === "limit").schema.default).toBe(40);
    expect(list.find((p: any) => p.name === "q").schema.description).toContain(
      "only for Saved and Sent",
    );
    const changes = spec.paths["/api/v1/cards/changes"][method].parameters;
    expect(
      changes.filter((p: any) => p.required).map((p: any) => p.name),
    ).toEqual(["after"]);
  }
});
