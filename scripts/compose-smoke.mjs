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
await api("/bootstrap");
for (const provider of ["codex", "claude"]) {
  const response = await fetch(origin + "/api/subscriptions", {
    method:"POST",headers:{origin,"content-type":"application/json"},
    body:JSON.stringify({provider,label:"Retired smoke"}),
  });
  assert.equal(response.status,410);
  assert.match((await response.json()).error,/HAPI/);
}
console.log("PASS: Compose API/worker health and retired subscription routes. HAPI runner compatibility is checked separately; no sign-in or inference.");
