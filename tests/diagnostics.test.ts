import { expect, it } from "vitest";
import {
  diagnosticText,
  errorFacts,
  errorSummary,
} from "../runtime/diagnostics.mjs";

it("redacts credentials before truncating diagnostic messages", () => {
  const secret = 'a-secret-with-specials-+/ &"';
  const value = diagnosticText("x".repeat(1190) + secret, [secret]);
  expect(value).not.toContain(secret.slice(0, 8));
  expect(value.length).toBeLessThanOrEqual(1200);
  const auth = diagnosticText(
    'Failed Bearer private.token123 at https://name:password@example.com/path?key=private#token; api_key="hidden value"',
  );
  for (const value of [
    "private.token123",
    "password",
    "?key=private",
    "#token",
    "hidden value",
  ])
    expect(auth).not.toContain(value);
  expect(auth).toContain("example.com/path");
});
it("keeps useful network error codes while excluding arbitrary thrown data", () => {
  const error = new TypeError("private payload", {
    cause: Object.assign(new Error("secret data"), { code: "UND_ERR_SOCKET" }),
  });
  expect(errorFacts(error)).toEqual({
    type: "TypeError",
    code: "UND_ERR_SOCKET",
    causes: ["UND_ERR_SOCKET"],
  });
  expect(errorSummary(error, [], false)).toBe("TypeError · UND_ERR_SOCKET");
  expect(errorSummary(error, [], false)).not.toContain("private");
});
