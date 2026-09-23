// Production images and real, unauthenticated native runtimes. No model calls or account login.
import assert from "node:assert/strict";
const origin = "http://localhost:3000";
let healthy = false;
for (let i = 0; i < 90; i++) {
  try {
    if ((await fetch(origin + "/api/health")).ok) {
      healthy = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
assert.ok(healthy, "API and independent worker become healthy");
const signup = await fetch(origin + "/api/auth/sign-up/email", {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({
    name: "Compose verification",
    email: "compose-" + crypto.randomUUID() + "@example.com",
    password: crypto.randomUUID() + "Ab1!",
  }),
});
assert.ok(signup.ok, await signup.text());
const cookie = signup.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
async function api(path, body) {
  const r = await fetch(origin + "/api" + path, {
    method: body ? "POST" : "GET",
    headers: { origin, cookie, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  assert.ok(r.ok, JSON.stringify(data));
  return data;
}
const boot = await api("/bootstrap");
assert.equal(boot.capabilities.codex, true);
assert.equal(boot.capabilities.claudeLogin, true);
for (const provider of ["codex", "claude"]) {
  const c = await api("/subscriptions", {
    provider,
    label: provider + " unsigned smoke",
  });
  const status = await api("/subscriptions/" + c.id + "/status", {});
  assert.equal(
    status.authenticated,
    false,
    provider + " must fail closed before native subscription sign-in",
  );
}
console.log(
  "PASS: Compose production build, HTTP signup/session, API + worker health, private broker and both real native runtimes return unsigned status without API keys or inference.",
);
