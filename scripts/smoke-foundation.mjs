import "../runtime/environment.mjs";
import assert from "node:assert/strict";
const origin = process.env.LOOP55_URL || "http://localhost:3000";
async function user() {
  const r = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      name: "Foundation tester",
      email: `test-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID() + "Ab1!",
    }),
  });
  assert.equal(r.status, 200, await r.text());
  return r.headers.get("set-cookie").split(";")[0];
}
const cookie = await user(),
  stranger = await user();
const call = (path, body, who = cookie) =>
  fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", origin, cookie: who },
    body: body ? JSON.stringify(body) : undefined,
  });
const key = crypto.randomUUID();
const first = await (await call("/api/diagnostic", { key })).json();
assert.equal(
  (await (await call("/api/diagnostic", { key })).json()).id,
  first.id,
);
let events = [];
for (let i = 0; i < 30; i++) {
  events = await (await call("/api/events")).json();
  if (events.some((x) => x.type === "completed")) break;
  await new Promise((r) => setTimeout(r, 200));
}
assert.deepEqual(
  events.map((x) => x.type),
  ["queued", "running", "progress", "completed"],
);
assert.equal((await (await call("/api/runs")).json())[0].state, "completed");
assert.equal(
  (await (await call("/api/events", null, stranger)).json()).length,
  0,
);
assert.equal((await fetch(origin + "/api/runs")).status, 401);
console.log(
  "PASS: maintained-auth signup/session, persisted run read, idempotency, separate worker events, owner isolation, anonymous rejection",
);
