// Production images and real native runtimes. No model calls or completed account login.
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
const identity = await fetch(origin + "/api/auth/get-session");
assert.ok(identity.ok);
assert.equal((await identity.json()).mode, "single-user");
assert.equal(identity.headers.getSetCookie().length, 0);
async function api(path, body) {
  const r = await fetch(origin + "/api" + path, {
    method: body ? "POST" : "GET",
    headers: { origin, "content-type": "application/json" },
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
  if (provider === "claude") {
    // Exercise the pinned CLI, not just a fixture: provider URL changes must
    // fail CI instead of silently leaving a real user at "Starting sign-in".
    try {
      let login = await api(`/subscriptions/${c.id}/login`, {});
      const deadline = Date.now() + 60_000;
      while (login.state === "starting" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        login = await api(`/subscriptions/${c.id}/status`, {});
      }
      assert.equal(
        login.state,
        "waiting",
        login.error || "Claude must supply a sign-in link",
      );
      assert.equal(login.login.acceptsCode, true);
      const url = new URL(login.login.url);
      assert.equal(url.protocol, "https:");
      assert.ok(["claude.com", "claude.ai"].includes(url.hostname));
      assert.ok(url.searchParams.get("state"));
      assert.ok(url.searchParams.get("code_challenge"));
    } finally {
      await api(`/subscriptions/${c.id}/cancel`, {});
    }
    const connection = (await api("/bootstrap")).connections.find(
      (row) => row.id === c.id,
    );
    assert.equal(connection.status, "needs_sign_in");
  }
}
console.log(
  "PASS: Compose production build, personal workspace without a Loop55 login, API + worker health, both real native runtimes return unsigned status; Claude produces a complete official sign-in link and cancels without provider login or inference.",
);
