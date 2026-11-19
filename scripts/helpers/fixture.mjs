import { createInterface } from "node:readline";

export function waitForFixtureAnnouncement(child, timeoutMs = 30_000) {
  const output = createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const logs = [];
    const record = (chunk) => logs.push(String(chunk));
    const fail = (cause) => {
      cleanup();
      reject(
        new Error(
          `Fixture did not start (${cause.message}): ${logs.join("")}`,
          { cause },
        ),
      );
    };
    const closed = (code, signal) =>
      fail(
        new Error(
          `Fixture exited before announcing readiness (${signal ?? code})`,
        ),
      );
    const timer = setTimeout(
      () => fail(new Error("Fixture readiness timed out")),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      child.off("close", closed);
      child.off("error", fail);
      child.stderr.off("data", record);
      output.close();
      child.stdout.resume();
      child.stderr.resume();
    };
    child.once("close", closed);
    child.once("error", fail);
    child.stderr.on("data", record);
    output.on("line", (line) => {
      if (!line.startsWith('{"origin"')) {
        record(line + "\n");
        return;
      }
      // Let close finish draining diagnostics when the process has already exited.
      if (child.exitCode !== null || child.signalCode !== null) return;
      let announcement;
      try {
        announcement = JSON.parse(line);
      } catch (error) {
        fail(error);
        return;
      }
      cleanup();
      resolve(announcement);
    });
  });
}

// Redeem a loopback fixture's one-time code and read its paired session.
export async function pairDevice(origin, secret, name) {
  const response = await fetch(origin + "/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ secret, name }),
  });
  if (response.status !== 200)
    throw new Error(
      `Fixture pairing failed (${response.status}): ${await response.text()}`,
    );
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Fixture pairing did not set a device cookie");
  const session = await fetch(origin + "/session", { headers: { cookie } });
  if (!session.ok)
    throw new Error(
      `Fixture session failed (${session.status}): ${await session.text()}`,
    );
  const { csrf } = await session.json();
  if (!csrf) throw new Error("Fixture session did not return a CSRF token");
  return { cookie, csrf };
}
