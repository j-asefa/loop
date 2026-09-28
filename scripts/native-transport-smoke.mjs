// Real pinned Linux Hub/Runner and application proxy; disposable identities only.
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import https from "node:https";
import { randomBytes, X509Certificate } from "node:crypto";
import assert from "node:assert/strict";
const root = mkdtempSync(join(tmpdir(), "loop-transport-"));
chmodSync(root, 0o755);
const containerIds = [],
  children = [];
const image =
  process.env.LOOP_NATIVE_TEST_IMAGE || "loop-architecture-native:validation";
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
const port = async () => {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
};
const hubPort = await port(),
  gatewayPort = await port(),
  workerPort = await port();
const hubToken = randomBytes(32).toString("base64url"),
  credential = randomBytes(32).toString("base64url");
const cert = (name) => {
  run("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, name + ".key"),
    "-out",
    join(root, name + ".csr"),
    "-subj",
    "/CN=" + name,
  ]);
  writeFileSync(
    join(root, name + ".ext"),
    "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n",
  );
  run("openssl", [
    "x509",
    "-req",
    "-in",
    join(root, name + ".csr"),
    "-CA",
    join(root, "ca.crt"),
    "-CAkey",
    join(root, "ca.key"),
    "-CAcreateserial",
    "-out",
    join(root, name + ".crt"),
    "-days",
    "1",
    "-extfile",
    join(root, name + ".ext"),
  ]);
};
const docker = (args) => {
  const id = run("docker", ["run", "-d", "--platform", "linux/amd64", ...args]);
  containerIds.push(id);
  return id;
};
try {
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, "ca.key"),
    "-out",
    join(root, "ca.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=Loop fixture CA",
  ]);
  cert("app");
  cert("worker");
  for (const d of ["hub", "home", "projects"]) {
    mkdirSync(join(root, d));
    chmodSync(join(root, d), 0o777);
  }
  for (const f of ["worker.key", "worker.crt", "ca.crt"])
    chmodSync(join(root, f), 0o644);
  docker([
    "-p",
    `127.0.0.1:${hubPort}:3006`,
    "-e",
    "CLI_API_TOKEN=" + hubToken,
    "-e",
    "HAPI_LISTEN_HOST=0.0.0.0",
    "-e",
    "HAPI_LISTEN_PORT=3006",
    "-e",
    "HAPI_PUBLIC_URL=http://localhost:3006",
    "-v",
    join(root, "hub") + ":/home/agent/.hapi",
    image,
    "/usr/local/bin/hapi",
    "hub",
    "--no-relay",
  ]);
  const env = {
    ...process.env,
    LOOP_DATA_DIR: join(root, "app-data"),
    LOOP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    LOOP_HAPI_URL: "http://127.0.0.1:" + hubPort,
    LOOP_HAPI_TOKEN: hubToken,
    LOOP_PRIVATE_KEY: join(root, "app.key"),
    LOOP_PRIVATE_CERT: join(root, "app.crt"),
    LOOP_PRIVATE_CA: join(root, "ca.crt"),
    LOOP_PRIVATE_HOST: "0.0.0.0",
    LOOP_PRIVATE_PORT: String(gatewayPort),
  };
  const identity = {
    name: "Transport fixture",
    url: "https://127.0.0.1:" + workerPort,
    instanceId: "i-1234567890abcdef0",
    namespace: "fixture",
    credential,
    certificateFingerprint: new X509Certificate(
      readFileSync(join(root, "worker.crt")),
    ).fingerprint256,
  };
  writeFileSync(join(root, "identity.json"), JSON.stringify(identity), {
    mode: 0o600,
  });
  run(
    "node",
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import {readFileSync} from 'node:fs';import {provisionEnvironment} from './src/server/hapi/environments.ts';provisionEnvironment('fixture-owner',JSON.parse(readFileSync(process.argv[1],'utf8')));",
      join(root, "identity.json"),
    ],
    { env },
  );
  const proxy = spawn(
    "node",
    ["--import", "tsx", "src/server/hapi/private.ts"],
    { env, stdio: "ignore" },
  );
  children.push(proxy);
  writeFileSync(join(root, "environment-token"), credential);
  chmodSync(join(root, "environment-token"), 0o644);
  writeFileSync(
    join(root, "worker.json"),
    JSON.stringify({
      nativeHome: "/home/agent",
      instanceId: identity.instanceId,
      appCertificateFingerprint: new X509Certificate(
        readFileSync(join(root, "app.crt")),
      ).fingerprint256,
      credentialFile: "/config/environment-token",
      keyFile: "/config/worker.key",
      certFile: "/config/worker.crt",
      caFile: "/config/ca.crt",
      codexBinary: "/opt/native/node_modules/.bin/codex",
      claudeBinary: "/opt/native/node_modules/.bin/claude",
      gatewayUrl: `https://host.docker.internal:${gatewayPort}/mcp`,
      hapiUrl: `https://host.docker.internal:${gatewayPort}`,
    }),
  );
  const worker = docker([
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    `127.0.0.1:${workerPort}:3010`,
    "-e",
    "CLI_API_TOKEN=" + hubToken + ":fixture",
    "-e",
    "LOOP_WORKER_CONFIG=/config/worker.json",
    "-e",
    "LOOP_PROJECT_ROOT=/workspaces",
    "-e",
    "LOOP_LAUNCH_DIR=/home/agent/.loop-launches",
    "-e",
    "LOOP_ENVIRONMENT_GENERATION=1",
    "-v",
    root + ":/config:ro",
    "-v",
    join(root, "home") + ":/home/agent",
    "-v",
    join(root, "projects") + ":/workspaces",
    image,
  ]);
  const tls = {
    cert: readFileSync(join(root, "worker.crt")),
    key: readFileSync(join(root, "worker.key")),
    ca: readFileSync(join(root, "ca.crt")),
  };
  const request = (path, token = credential, certificate = true) =>
    new Promise((resolve, reject) => {
      const r = https.get(
        `https://127.0.0.1:${gatewayPort}` + path,
        {
          ...(certificate ? tls : { ca: tls.ca }),
          // Each authorization assertion needs a fresh TLS connection. Node's
          // default keep-alive pool can reuse the pre-revocation socket while
          // the proxy's revocation sweep is destroying it (ECONNRESET instead
          // of the expected 401 on a new connection).
          agent: false,
          headers: {
            "x-loop-environment-token": token,
            authorization: "Bearer " + hubToken + ":fixture",
          },
          timeout: 3000,
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      r.on("error", reject);
      r.on("timeout", () => r.destroy());
    });
  let token, machines;
  for (let i = 0; i < 80; i++) {
    try {
      const login = await fetch(`http://127.0.0.1:${hubPort}/api/auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken: hubToken + ":fixture" }),
      });
      token = (await login.json()).token;
      const r = await fetch(`http://127.0.0.1:${hubPort}/api/machines`, {
        headers: { authorization: "Bearer " + token },
      });
      machines = (await r.json()).machines;
      if (machines?.some((m) => m.active)) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert(
    machines?.some((m) => m.active),
    "Actual Runner must authenticate through private Loop proxy",
  );
  assert.equal(await request("/health"), 200);
  assert.equal(await request("/health", "wrong"), 401);
  await assert.rejects(request("/health", credential, false));
  assert.equal(
    await request("/api/sessions"),
    403,
    "Worker must not reach interactive Hub API",
  );
  const bypass = run("docker", [
    "exec",
    worker,
    "node",
    "-e",
    "fetch('http://127.0.0.1:3013/cli/machines',{headers:{authorization:'Bearer '+process.env.CLI_API_TOKEN.replace(':fixture',':another')}}).then(r=>console.log(r.status))",
  ]);
  assert.equal(bypass, "403", "Copied Hub token cannot switch namespace");
  run(
    "node",
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import {db} from './src/server/db.ts';db.prepare(\"UPDATE execution_environments SET revoked_at=1\").run();db.close();",
    ],
    { env },
  );
  assert.equal(
    await request("/health"),
    401,
    "Revocation must deny fresh requests",
  );
  console.log(
    JSON.stringify({
      realLinuxHubRunner: "passed",
      mutualTls: "passed",
      wrongCredential: "denied",
      workerInteractiveApi: "denied",
      copiedHubTokenNamespace: "denied",
      revocation: "denied",
      modelCalls: 0,
    }),
  );
} finally {
  for (const child of children) child.kill();
  for (const id of containerIds)
    try {
      run("docker", ["rm", "-f", id]);
    } catch {}
  // Docker Desktop maps bind ownership to the desktop user; Linux retains
  // native UID 10000's private directories. Remove only this disposable test
  // mount through an offline helper before the host removes its temp root.
  if (process.platform === "linux")
    run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "DAC_OVERRIDE",
      "-v",
      root + ":/fixture",
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "-e",
      "import {readdirSync,rmSync} from 'node:fs'; for (const entry of readdirSync('/fixture')) rmSync('/fixture/'+entry,{recursive:true,force:true});",
    ]);
  rmSync(root, { recursive: true, force: true });
}
