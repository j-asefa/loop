import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
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

const exec = promisify(execFile);

export async function installPackedLoop(
  tarball,
  { prefix, env, timeout = 240_000 } = {},
) {
  await exec(
    "npm",
    [
      "install",
      ...(prefix ? ["--prefix", prefix] : ["-g"]),
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { env, maxBuffer: 1_000_000, timeout },
  );
}

// Requests travel through the fixture's real relay listener while retaining
// the public Host and Origin headers used by its paired browser.
export function createRelayClient(relay, origin) {
  const host = new URL(origin).host;
  let cookie;
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = request(
        {
          host: relay.hostname,
          port: Number(relay.port),
          method,
          path,
          headers: {
            host,
            origin,
            ...(cookie ? { cookie } : {}),
            ...(payload === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (text += chunk));
          res.on("error", reject);
          res.on("end", () => {
            const paired = res.headers["set-cookie"]?.[0];
            if (paired) cookie = paired.split(";", 1)[0];
            resolve({ status: res.statusCode, body: text });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
}
