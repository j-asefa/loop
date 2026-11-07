import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cardsFixture } from "./helpers/cards-fixture";
import { seedCards } from "./helpers/seed-cards";
import { integrationTokenRequest } from "../src/shared/card-access";
import { workspaceApi, workspaceRoutes } from "../src/shared/workspace-api";

it("serves the Cards HTTP contract and enforces documented token management headers", async () => {
  const fixture = await cardsFixture();
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
          body: integrationTokenRequest("Missing Origin", ["read"]),
        })
      ).status,
    ).toBe(403);
    const withoutCsrf: Record<string, string> = { ...createHeaders };
    delete withoutCsrf["x-loop-csrf"];
    expect(
      (
        await fixture.request("/api/card-tokens", {
          headers: withoutCsrf,
          body: integrationTokenRequest("Missing CSRF", ["read"]),
        })
      ).status,
    ).toBe(403);
    const response = await fixture.request("/api/card-tokens", {
      headers: createHeaders,
      body: integrationTokenRequest("Example", ["read"]),
    });
    expect(response.status).toBe(201);
    const { secret, token } = await response.json();
    const headers = { authorization: "Bearer " + secret };
    const list = await fixture.request("/api/v1/cards?view=results&limit=1", {
      headers,
    });
    expect(list.status).toBe(200);
    const page = workspaceApi.cardList.response.parse(await list.json());
    expect(page.items).toHaveLength(1);
    const card = page.items[0].card;
    const detail = await fixture.request(
      "/api/v1/cards/" + encodeURIComponent(card.id),
      { headers },
    );
    expect(detail.status).toBe(200);
    expect(workspaceApi.cardDetail.response.parse(await detail.json())).toEqual(
      card,
    );
    fixture.db
      .prepare("UPDATE artifacts SET content='Current HTTP edit' WHERE id=?")
      .run(card.source.artifact_id);
    const delta = await fixture.request(
      "/api/v1/cards/changes?after=" + page.revision,
      { headers },
    );
    expect(delta.status).toBe(200);
    expect(
      workspaceApi.cardChanges.response
        .parse(await delta.json())
        .items.find((entry) => entry.card.id === card.id)?.card.content,
    ).toBe("Current HTTP edit");
    fixture.db
      .prepare(
        "UPDATE card_tokens SET request_window=?,request_count=120 WHERE id=?",
      )
      .run(Math.floor(Date.now() / 60000), token.id);
    const throttled = await fixture.request("/api/v1/cards", { headers });
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
    const revokeHeaders = managementHeaders("delete", "/api/card-tokens/{id}");
    const withoutRevokeOrigin = { ...revokeHeaders };
    delete withoutRevokeOrigin.Origin;
    expect(
      (
        await fixture.request("/api/card-tokens/" + token.id, {
          method: "DELETE",
          headers: withoutRevokeOrigin,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fixture.request("/api/card-tokens/" + token.id, {
          method: "DELETE",
          headers: revokeHeaders,
        })
      ).status,
    ).toBe(200);
    expect((await fixture.request("/api/v1/cards", { headers })).status).toBe(
      401,
    );
  } finally {
    await fixture.close();
  }
}, 30000);

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
