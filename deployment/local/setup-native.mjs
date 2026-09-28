import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { MAX_CONCURRENT_RUNS } from "../../runtime/concurrency.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = resolve(root, ".local-native");
const secrets = resolve(state, "secrets");
const appSecrets = resolve(secrets, "app");
const workerSecrets = resolve(secrets, "worker");
const memorySecrets = resolve(secrets, "memory");
if (existsSync(resolve(appSecrets, "environments.json"))) {
  const path = resolve(appSecrets, "environments.json");
  const environments = JSON.parse(readFileSync(path, "utf8"));
  // Upgrade the old generated default without replacing identities or custom caps.
  let changed = false;
  for (const environment of environments) {
    if (environment.capacity === 4 || environment.capacity === undefined) {
      environment.capacity = MAX_CONCURRENT_RUNS;
      changed = true;
    }
  }
  if (changed) writeFileSync(path, JSON.stringify(environments, null, 2) + "\n", { mode: 0o600 });
  console.log("Local native environment preserved; capacity defaults updated. Restart Loop to apply provisioning changes.");
  process.exit(0);
}
const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" });
if (openssl.status !== 0) throw new Error("OpenSSL is required to create local mutual-TLS identities");
mkdirSync(secrets, { recursive: true, mode: 0o700 });
for (const directory of [appSecrets, workerSecrets, memorySecrets]) mkdirSync(directory, { recursive: true, mode: 0o700 });
const run = (args) => {
  const r = spawnSync("openssl", args, { cwd: secrets, stdio: "ignore" });
  if (r.status !== 0) throw new Error("Could not create local mutual-TLS identity");
};
run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "3650", "-subj", "/CN=Loop Local CA"]);
for (const [name, san] of [["app", "DNS:gateway,DNS:loop,IP:127.0.0.1"], ["worker", "DNS:runner,IP:127.0.0.1"]]) {
  writeFileSync(resolve(secrets, name + ".ext"), "subjectAltName=" + san + "\nextendedKeyUsage=serverAuth,clientAuth\nkeyUsage=digitalSignature,keyEncipherment\n", { mode: 0o600 });
  run(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", name + ".key", "-out", name + ".csr", "-subj", "/CN=loop-" + name]);
  run(["x509", "-req", "-in", name + ".csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", name + ".pem", "-days", "825", "-sha256", "-extfile", name + ".ext"]);
}
const token = randomBytes(32).toString("hex");
const hubToken = randomBytes(32).toString("hex");
const appCertificateFingerprint = new X509Certificate(readFileSync(resolve(secrets, "app.pem"))).fingerprint256;
const workerCertificateFingerprint = new X509Certificate(readFileSync(resolve(secrets, "worker.pem"))).fingerprint256;
const memoryToken = createHash("sha256").update("loop-memory-v1:" + hubToken).digest("hex");
writeFileSync(resolve(memorySecrets, "token"), memoryToken, { mode: 0o644 });
for (const file of ["ca.pem", "app.pem", "app.key"]) renameSync(resolve(secrets, file), resolve(appSecrets, file));
for (const file of ["worker.pem", "worker.key"]) renameSync(resolve(secrets, file), resolve(workerSecrets, file));
copyFileSync(resolve(appSecrets, "ca.pem"), resolve(workerSecrets, "ca.pem"));
writeFileSync(resolve(workerSecrets, "environment-token"), token + "\n", { mode: 0o600 });
for (const file of ["ca.key", "ca.pem", "ca.srl", "app.csr", "app.ext", "worker.csr", "worker.ext"]) {
  const path = resolve(secrets, file);
  if (existsSync(path)) unlinkSync(path);
}
const instanceId = "i-" + randomBytes(8).toString("hex");
const namespace = "local-" + randomBytes(8).toString("hex");
writeFileSync(resolve(appSecrets, "environments.json"), JSON.stringify([{
  name: "Docker", url: "https://runner:3010", instanceId, namespace, credential: token,
  certificateFingerprint: workerCertificateFingerprint,
  capacity: MAX_CONCURRENT_RUNS,
}], null, 2) + "\n", { mode: 0o600 });
writeFileSync(resolve(workerSecrets, "worker.json"), JSON.stringify({
  nativeHome: "/home/agent",
  instanceId,
  appCertificateFingerprint,
  credentialFile: "/config/environment-token",
  keyFile: "/config/worker.key",
  certFile: "/config/worker.pem",
  caFile: "/config/ca.pem",
  codexBinary: "/opt/native/node_modules/.bin/codex",
  claudeBinary: "/opt/native/node_modules/.bin/claude",
  repositoryHosts: ["github.com"],
  gatewayUrl: "https://gateway:3007/mcp",
  hapiUrl: "https://gateway:3007",
  port: 3010,
  listenHost: "0.0.0.0",
}, null, 2) + "\n", { mode: 0o600 });
writeFileSync(resolve(state, "app.env"), [
  `LOOP_HAPI_URL=http://hapi:3006`,
  `LOOP_HAPI_TOKEN=${hubToken}`,
  `LOOP_MEMORY_URL=http://memory:3011`,
  `LOOP_MEMORY_TOKEN=${memoryToken}`,
  `LOOP_CONTROL_CERT=/run/loop/private/app.pem`,
  `LOOP_CONTROL_KEY=/run/loop/private/app.key`,
  `LOOP_CONTROL_CA=/run/loop/private/ca.pem`,
  `LOOP_PRIVATE_CERT=/run/loop/private/app.pem`,
  `LOOP_PRIVATE_KEY=/run/loop/private/app.key`,
  `LOOP_PRIVATE_CA=/run/loop/private/ca.pem`,
  `LOOP_ENVIRONMENTS_FILE=/run/loop/private/environments.json`,
  `LOOP_NATIVE_GATEWAY_URL=https://gateway:3007/mcp`,
  `LOOP_NATIVE_ADMISSION=1`,
].join("\n") + "\n", { mode: 0o600 });
writeFileSync(resolve(state, "worker.env"), [
  `CLI_API_TOKEN=${hubToken}:${namespace}`,
  `LOOP_ENVIRONMENT_GENERATION=1`,
  `LOOP_PROJECT_ROOT=/workspaces`,
  `LOOP_WORKER_CONFIG=/config/worker.json`,
  `LOOP_LAUNCH_DIR=/home/agent/.loop-launches`,
].join("\n") + "\n", { mode: 0o600 });
writeFileSync(resolve(state, "hub.env"), `CLI_API_TOKEN=${hubToken}\n`, { mode: 0o600 });
for (const file of ["ca.pem", "app.pem", "app.key"]) chmodSync(resolve(appSecrets, file), 0o600);
for (const file of ["ca.pem", "worker.pem", "worker.key", "environment-token", "worker.json"]) chmodSync(resolve(workerSecrets, file), 0o600);
console.log("Created a laptop-local HAPI identity and credentials in .local-native (mode 0600).");
console.log("Next: node scripts/setup.mjs, then run Compose with -f compose.yaml -f deployment/local/compose.yaml.");
