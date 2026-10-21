import { expect, it } from "vitest";
import { createCardClient } from "../src/shared/card-client";

it("never sends credentials to remote plaintext origins and keeps redirects disabled", async () => {
  const requests: { url: string; options?: RequestInit }[] = [];
  const send: typeof fetch = async (input, options) => {
    requests.push({ url: String(input), options });
    return Response.json({ revision: "fixture", items: [], next: null });
  };
  for (const baseUrl of [
    "http://workspace.example",
    "http://localhost.example",
    "http://127.0.0.1.example",
    "http://10.0.0.1",
    "http://[2001:db8::1]",
  ])
    expect(() =>
      createCardClient({ baseUrl, token: "fixture-token", fetch: send }),
    ).toThrow("HTTPS");
  expect(requests).toEqual([]);
  for (const baseUrl of [
    "https://workspace.example",
    "http://localhost:3456",
    "http://127.0.0.1:3456",
    "http://[::1]:3456",
  ]) {
    await createCardClient({
      baseUrl,
      token: "fixture-token",
      fetch: send,
    }).list();
    const request = requests.at(-1)!;
    expect(new URL(request.url).origin).toBe(baseUrl);
    expect(request.options).toMatchObject({
      redirect: "error",
      credentials: "omit",
    });
    expect(new Headers(request.options?.headers).get("authorization")).toBe(
      "Bearer fixture-token",
    );
  }
});
