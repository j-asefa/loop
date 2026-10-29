import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("resolves every local reference in the published fleet OpenAPI document", () => {
  const document = JSON.parse(
    readFileSync(
      new URL("../docs/fleet-openapi.json", import.meta.url),
      "utf8",
    ),
  );
  let references = 0;
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if ("$ref" in value && typeof value.$ref === "string") {
      expect(value.$ref.startsWith("#/"), value.$ref).toBe(true);
      const target = value.$ref
        .slice(2)
        .split("/")
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
        .reduce((node, key) => node?.[key], document);
      expect(target, value.$ref).toBeDefined();
      references++;
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(document);
  expect(references).toBeGreaterThan(0);
});
