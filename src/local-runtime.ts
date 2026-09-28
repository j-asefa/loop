/** Laptop provisioning reuses the PR's patched HAPI runner and mTLS gateway. */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join, resolve, dirname, delimiter } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import {
  randomUUID,
  randomBytes,
  X509Certificate,
  createHash,
} from "node:crypto";
import { atomic, privateDir } from "./state.js";
import { own, killOwned } from "./processes.js";
import { MAX_CONCURRENT_RUNS } from "../runtime/concurrency.mjs";
const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export type LocalChoices = {
  providers: ("codex" | "claude")[];
  execution: "native" | "docker" | "both";
  project: string;
};
export function choices(
  providers: string,
  execution: string,
  project: string,
): LocalChoices {
  if (!["openai", "anthropic", "both"].includes(providers))
    throw new Error("--providers must be openai, anthropic or both");
  if (!["native", "docker", "both"].includes(execution))
    throw new Error("--execution must be native, docker or both");
  return {
    providers:
      providers === "both"
        ? ["codex", "claude"]
        : [providers === "openai" ? "codex" : "claude"],
    execution: execution as LocalChoices["execution"],
    project,
  };
}
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", yes);
  });
  const value = (server.address() as any).port;
  await new Promise<void>((yes) => server.close(() => yes()));
  return value;
}
async function run(command: string, args: string[], cwd = packageRoot) {
  await new Promise<void>((yes, no) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.once("error", no);
    child.once("exit", (code) =>
      code === 0
        ? yes()
        : no(
            new Error(
              `${command} failed (${code}). Retry after resolving the setup error.`,
            ),
          ),
    );
  });
}
/** Build the exact already-reviewed HAPI patch on the laptop's architecture. */
async function hapi(root: string) {
  const patchHash = createHash("sha256")
    .update(readFileSync(join(packageRoot, "native/apply-hapi-patch.mjs")))
    .update(readFileSync(join(packageRoot, "native/loopManaged.ts")))
    .digest("hex")
    .slice(0, 12);
  const source = join(root, "helpers", "hapi-0239edf3-" + patchHash);
  const target = `bun-${process.platform}-${process.arch}${process.platform === "linux" && process.arch === "x64" ? "-baseline" : ""}`;
  const binary = join(source, "cli", "dist-exe", target, "hapi");
  const ready = join(source, "loop-build-ready.json");
  if (existsSync(binary) && existsSync(ready)) return binary;
  console.log("Preparing HAPI 0.30.7 for this machine (first launch only)…");
  privateDir(dirname(source));
  if (!existsSync(join(source, ".git")))
    await run("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "https://github.com/tiann/hapi.git",
      source,
    ]);
  await run(
    "git",
    ["checkout", "0239edf38e2da653d662f31039e24ccea04c7837"],
    source,
  );
  await run(process.execPath, [
    join(packageRoot, "native/apply-hapi-patch.mjs"),
    source,
  ]);
  // npm selects the Bun binary for the host; no Linux-only executable is copied.
  await run(
    "npx",
    ["--yes", "--package", "bun@1.4.0", "bun", "install", "--frozen-lockfile"],
    source,
  );
  await run(
    "npx",
    ["--yes", "--package", "bun@1.4.0", "bun", "run", "build:exe"],
    join(source, "cli"),
  );
  if (!existsSync(binary))
    throw new Error("HAPI build did not produce the expected host binary");
  await exec(binary, ["--version"], { timeout: 10000 });
  atomic(ready, { patchHash });
  return binary;
}
type Identity = { instanceId: string; namespace: string; credential: string };
export class LocalRuntime {
  private children: ReturnType<typeof spawn>[] = [];
  private containers: string[] = [];
  private privateServer?: import("node:https").Server;
  private closed = false;
  private failure?: Error;
  private state: string;
  private envs: {
    kind: string;
    dir: string;
    settings: any;
    identity: Identity;
    workerPort: number;
    container?: string;
  }[] = [];
  private hubBinary = "";
  private hubPort = 0;
  private gatewayPort = 0;
  private hubToken = "";
  constructor(
    private root: string,
    private selection: LocalChoices,
    private buildHapi = hapi,
  ) {
    this.state = join(root, "managed");
  }
  async prepare() {
    privateDir(this.state);
    await stopManagedContainers(this.root);
    process.env.LOOP_MEMORY_ENABLED ??= process.env.LOOP_MEMORY_URL ? "1" : "0";
    const saved = join(this.state, "identity.json");
    const identity = existsSync(saved)
      ? JSON.parse(readFileSync(saved, "utf8"))
      : { hubToken: randomBytes(32).toString("hex") };
    atomic(saved, identity);
    this.hubToken = identity.hubToken;
    this.hubPort = await port();
    this.gatewayPort = await port();
    let nativeBins: Record<string, string> = {};
    if (this.selection.execution !== "docker") {
      const { discover } = await import("./host-control.js");
      for (const provider of this.selection.providers) {
        const found = await discover(provider);
        if (found.installed && found.executable)
          nativeBins[provider] = found.executable;
      }
      if (this.selection.providers.some((p) => !nativeBins[p])) {
        const directory = join(this.root, "helpers", "native");
        privateDir(directory);
        for (const file of ["package.json", "package-lock.json"])
          copyFileSync(
            join(packageRoot, "deployment/native", file),
            join(directory, file),
          );
        await run("npm", ["ci", "--omit=dev"], directory);
        for (const provider of this.selection.providers)
          nativeBins[provider] ||= join(
            directory,
            "node_modules/.bin",
            provider,
          );
      }
    }
    this.hubBinary = await this.buildHapi(this.root);
    const ca = join(this.state, "ca");
    privateDir(ca);
    if (!existsSync(join(ca, "ca.pem")))
      await this.openssl([
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(ca, "ca.key"),
        "-out",
        join(ca, "ca.pem"),
        "-days",
        "3650",
        "-subj",
        "/CN=Loop Laptop CA",
      ]);
    await this.certificate("app");
    const app = join(this.state, "app");
    Object.assign(process.env, {
      LOOP_HAPI_URL: `http://127.0.0.1:${this.hubPort}`,
      LOOP_HAPI_TOKEN: this.hubToken,
      LOOP_CONTROL_CERT: join(app, "cert.pem"),
      LOOP_CONTROL_KEY: join(app, "key.pem"),
      LOOP_CONTROL_CA: join(ca, "ca.pem"),
      LOOP_PRIVATE_CERT: join(app, "cert.pem"),
      LOOP_PRIVATE_KEY: join(app, "key.pem"),
      LOOP_PRIVATE_CA: join(ca, "ca.pem"),
      LOOP_PRIVATE_PORT: String(this.gatewayPort),
      LOOP_PRIVATE_HOST:
        this.selection.execution === "native" ? "127.0.0.1" : "0.0.0.0",
      LOOP_NATIVE_ADMISSION: "1",
    });
    for (const kind of this.selection.execution === "both"
      ? ["native", "docker"]
      : [this.selection.execution]) {
      const dir = join(
        this.state,
        kind +
          "-" +
          createHash("sha256")
            .update(this.selection.project)
            .digest("hex")
            .slice(0, 16),
      );
      privateDir(dir);
      const path = join(dir, "identity.json");
      const identity: Identity = existsSync(path)
        ? JSON.parse(readFileSync(path, "utf8"))
        : {
            instanceId: "local-" + randomUUID(),
            namespace: "laptop-" + randomBytes(12).toString("hex"),
            credential: randomBytes(32).toString("hex"),
          };
      atomic(path, identity);
      await this.certificate(
        kind +
          "-" +
          createHash("sha256")
            .update(this.selection.project)
            .digest("hex")
            .slice(0, 16),
      );
      writeFileSync(join(dir, "environment-token"), identity.credential, {
        mode: 0o600,
      });
      const docker = kind === "docker",
        workerPort = await port();
      const configDir = docker ? "/config" : dir;
      const settings = {
        nativeHome: docker ? "/home/agent" : homedir(),
        ...(!docker
          ? {
              codexHome: process.env.CODEX_HOME,
              claudeHome: process.env.CLAUDE_CONFIG_DIR,
            }
          : {}),
        instanceId: identity.instanceId,
        providers: this.selection.providers,
        appCertificateFingerprint: new X509Certificate(
          readFileSync(join(app, "cert.pem")),
        ).fingerprint256,
        credentialFile: join(configDir, "environment-token"),
        keyFile: join(configDir, "key.pem"),
        certFile: join(configDir, "cert.pem"),
        caFile: join(configDir, "ca.pem"),
        codexBinary: docker
          ? "/opt/native/node_modules/.bin/codex"
          : nativeBins.codex || "codex",
        claudeBinary: docker
          ? "/opt/native/node_modules/.bin/claude"
          : nativeBins.claude || "claude",
        hapiBinary: docker ? "hapi" : this.hubBinary,
        repositoryHosts: ["github.com"],
        gatewayUrl: `https://${docker ? "host.docker.internal" : "127.0.0.1"}:${this.gatewayPort}/mcp`,
        hapiUrl: `https://${docker ? "host.docker.internal" : "127.0.0.1"}:${this.gatewayPort}`,
        port: docker ? 3010 : workerPort,
        listenHost: docker ? "0.0.0.0" : "127.0.0.1",
        gatewayBridgePort: docker ? 3012 : await port(),
        hapiBridgePort: docker ? 3013 : await port(),
        codexPort: docker ? 3014 : await port(),
      };
      writeFileSync(join(dir, "ca.pem"), readFileSync(join(ca, "ca.pem")), {
        mode: 0o600,
      });
      atomic(join(dir, "worker.json"), settings);
      this.envs.push({ kind, dir, settings, identity, workerPort });
    }
    if (this.envs.some((e) => e.kind === "docker")) {
      await exec("docker", ["info"], {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      }).catch(() => {
        throw new Error(
          "Start Docker Desktop or your Docker daemon, then run loop again.",
        );
      });
      await run("docker", [
        "build",
        "-f",
        join(packageRoot, "deployment/Dockerfile.native"),
        "-t",
        "loop-native:local",
        packageRoot,
      ]);
    }
  }
  private async openssl(args: string[]) {
    await exec("openssl", args, {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }).catch(() => {
      throw new Error("OpenSSL could not create the private runtime identity");
    });
    // OpenSSL uses the parent's umask for keys. Keep the entire identity private.
    const { chmodSync } = await import("node:fs");
    for (let i = 0; i < args.length; i++)
      if (["-keyout", "-out"].includes(args[i])) chmodSync(args[i + 1], 0o600);
  }
  private async certificate(name: string) {
    const dir = join(this.state, name);
    privateDir(dir);
    if (existsSync(join(dir, "cert.pem"))) return;
    const ext = join(dir, "extensions");
    writeFileSync(
      ext,
      "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n",
      { mode: 0o600 },
    );
    await this.openssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "request.pem"),
      "-subj",
      "/CN=loop-" + name,
    ]);
    await this.openssl([
      "x509",
      "-req",
      "-in",
      join(dir, "request.pem"),
      "-CA",
      join(this.state, "ca/ca.pem"),
      "-CAkey",
      join(this.state, "ca/ca.key"),
      "-CAcreateserial",
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "825",
      "-sha256",
      "-extfile",
      ext,
    ]);
  }
  private child(command: string, args: string[], env: NodeJS.ProcessEnv) {
    if (this.closed) throw new Error("Runtime startup cancelled");
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    own(child);
    this.children.push(child);
    child.once("error", () => {
      this.failure = new Error(
        "A managed runtime could not start. See loop logs.",
      );
    });
    child.once("exit", () => {
      if (!this.closed)
        this.failure = new Error(
          "A managed runtime exited. See loop logs, then restart Loop.",
        );
    });
    return child;
  }
  async start() {
    if (this.closed) throw new Error("Runtime startup cancelled");
    const { provisionEnvironment, environment, refreshEnvironment } =
      await import("./server/hapi/environments.js");
    const { db, id, now } = await import("./server/db.js");
    const { OWNER, nativeSessions } =
      await import("./server/native-sessions.js");
    const project = nativeSessions.addProject(this.selection.project) as any;
    const hostIds: string[] = [];
    db.prepare(
      "UPDATE connections SET status='disconnected' WHERE owner_id=? AND json_extract(metadata,'$.environmentId') IN (SELECT host_id FROM execution_environments WHERE instance_id LIKE 'local-%')",
    ).run(OWNER);
    db.prepare(
      "UPDATE execution_environments SET state='offline' WHERE owner_id=? AND instance_id LIKE 'local-%'",
    ).run(OWNER);
    for (const e of this.envs) {
      const host = provisionEnvironment(OWNER, {
        name: e.kind === "native" ? "This laptop" : "Docker",
        url: `https://127.0.0.1:${e.workerPort}`,
        ...e.identity,
        certificateFingerprint: new X509Certificate(
          readFileSync(join(e.dir, "cert.pem")),
        ).fingerprint256,
        capacity: MAX_CONCURRENT_RUNS,
      });
      // Only local provisioning may refresh the address of an unchanged identity.
      db.prepare("UPDATE runtime_hosts SET url=? WHERE id=?").run(
        `https://127.0.0.1:${e.workerPort}`,
        host,
      );
      db.prepare(
        "INSERT INTO environment_projects VALUES(?,?,?,NULL) ON CONFLICT(environment_id,project_id) DO UPDATE SET canonical_path=excluded.canonical_path",
      ).run(
        host,
        project.id,
        e.kind === "native" ? this.selection.project : "/workspaces/project",
      );
      hostIds.push(host);
    }
    const hubHome = join(this.state, "hub");
    privateDir(hubHome);
    this.child(this.hubBinary, ["hub", "--no-relay"], {
      ...process.env,
      HAPI_HOME: hubHome,
      HAPI_LISTEN_HOST: "127.0.0.1",
      HAPI_LISTEN_PORT: String(this.hubPort),
      HAPI_PUBLIC_URL: `http://127.0.0.1:${this.hubPort}`,
      CLI_API_TOKEN: this.hubToken,
    });
    this.privateServer = (await import("./server/hapi/private.js")).server;
    for (const e of this.envs) {
      const docker = e.kind === "docker";
      const home = join(e.dir, "hapi");
      privateDir(home);
      const launches = join(e.dir, "launches");
      privateDir(launches);
      const env = {
        ...process.env,
        CLI_API_TOKEN: this.hubToken + ":" + e.identity.namespace,
        LOOP_ENVIRONMENT_GENERATION: "1",
        LOOP_EXECUTION_KIND: e.kind,
        LOOP_PROJECT_ROOT: docker
          ? "/workspaces/project"
          : this.selection.project,
        LOOP_WORKER_CONFIG: docker
          ? "/config/worker.json"
          : join(e.dir, "worker.json"),
        LOOP_LAUNCH_DIR: docker ? "/home/agent/.loop-launches" : launches,
        HAPI_HOME: docker ? "/home/agent/.hapi" : home,
        PATH: [
          dirname(this.hubBinary),
          dirname(e.settings.codexBinary),
          dirname(e.settings.claudeBinary),
          process.env.PATH,
        ].join(delimiter),
      };
      if (!docker)
        this.child(
          process.execPath,
          [join(packageRoot, "native/supervisor.mjs")],
          env,
        );
      else {
        const name = "loop-" + e.identity.namespace;
        e.container = name;
        const envFile = join(e.dir, "container.env");
        const keys = [
          "CLI_API_TOKEN",
          "LOOP_ENVIRONMENT_GENERATION",
          "LOOP_EXECUTION_KIND",
          "LOOP_PROJECT_ROOT",
          "LOOP_WORKER_CONFIG",
          "LOOP_LAUNCH_DIR",
          "HAPI_HOME",
        ] as const;
        writeFileSync(
          envFile,
          keys.map((k) => k + "=" + env[k]).join("\n") + "\n",
          { mode: 0o600 },
        );
        // The image runs as UID 10000; give it a dedicated configuration copy via
        // a named volume. Host provider homes and the Docker socket are not mounted.
        const volume = name + "-config";
        const uid = process.getuid?.() || 10000,
          gid = process.getgid?.() || 10000;
        await exec("docker", ["volume", "create", volume]);
        await exec("docker", [
          "run",
          "--rm",
          "--user",
          "0",
          "--entrypoint",
          "sh",
          "--mount",
          `type=bind,src=${e.dir},dst=/source,readonly`,
          "--mount",
          `type=volume,src=${volume},dst=/target`,
          "loop-native:local",
          "-c",
          `cp /source/worker.json /source/environment-token /source/key.pem /source/cert.pem /source/ca.pem /target/ && chown -R ${uid}:${gid} /target && chmod 700 /target && chmod 600 /target/*`,
        ]);
        await exec("docker", [
          "run",
          "--rm",
          "--user",
          "0",
          "--entrypoint",
          "sh",
          "--mount",
          `type=volume,src=${name}-home,dst=/home/agent`,
          "loop-native:local",
          "-c",
          `chown -R ${uid}:${gid} /home/agent`,
        ]);
        // Recover only this workspace's exact, identity-labelled container.
        const prior = await exec("docker", [
          "inspect",
          "--format",
          '{{index .Config.Labels "loop.identity"}}',
          name,
        ]).catch(() => undefined);
        if (prior) {
          if (prior.stdout.trim() !== e.identity.instanceId)
            throw new Error("Container name belongs to another workspace");
          await exec("docker", ["rm", "-f", name]);
        }
        if (this.closed) throw new Error("Runtime startup cancelled");
        // Persist intent before Docker can accept the launch, so crash recovery
        // also covers a lost command acknowledgement.
        this.containers.push(name);
        atomic(
          join(this.state, "containers.json"),
          this.envs
            .filter((e) => this.containers.includes(e.container || ""))
            .map((e) => ({
              name: e.container,
              identity: e.identity.instanceId,
            })),
        );
        await exec("docker", [
          "run",
          "-d",
          "--user",
          `${uid}:${gid}`,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "256",
          "--memory",
          "4g",
          "--cpus",
          "2",
          "--name",
          name,
          "--label",
          "loop.identity=" + e.identity.instanceId,
          "--add-host",
          "host.docker.internal:host-gateway",
          "--publish",
          `127.0.0.1:${e.workerPort}:3010`,
          "--env-file",
          envFile,
          "--mount",
          `type=volume,src=${volume},dst=/config,readonly`,
          "--mount",
          `type=volume,src=${name}-home,dst=/home/agent`,
          "--mount",
          `type=bind,src=${this.selection.project},dst=/workspaces/project`,
          "loop-native:local",
        ]);
        if (this.closed) {
          await stopManagedContainers(this.root);
          throw new Error("Runtime startup cancelled");
        }
      }
    }
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (this.closed) throw new Error("Runtime startup cancelled");
      if (this.failure) throw this.failure;
      const states = await Promise.all(
        hostIds.map((host) => refreshEnvironment(environment(OWNER, host))),
      );
      if (states.every((s) => s.state === "online")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    for (const host of hostIds) {
      const e = environment(OWNER, host);
      if (e.state !== "online")
        throw new Error(
          `${e.name} runner did not become ready. See loop logs.`,
        );
      const { connectProvider } = await import("./server/hapi/routes.js");
      for (const flavor of this.selection.providers) {
        try {
          await connectProvider(e, flavor);
        } catch {
          console.log(
            `${e.name}: sign in to ${flavor} in Settings → Execution environments on your paired phone.`,
          );
        }
      }
    }
    return {
      billing: {
        description: `${this.selection.providers.join(" + ")} · ${this.selection.execution} execution. Provider sign-in is scoped to each environment.`,
      },
    };
  }
  async close() {
    this.closed = true;
    const stopped = await stopManagedContainers(this.root).then(
      () => undefined,
      (error) => error as Error,
    );
    this.privateServer?.closeAllConnections();
    this.privateServer?.close();
    await Promise.all(
      this.children.map(async (c) => {
        killOwned(c, "SIGTERM");
        await new Promise<void>((r) => {
          const t = setTimeout(() => {
            killOwned(c, "SIGKILL");
            r();
          }, 6000);
          c.once("exit", () => {
            // The group can still contain managed sessions after its leader
            // exits. Finish ownership cleanup before reporting shutdown.
            killOwned(c, "SIGKILL");
            clearTimeout(t);
            r();
          });
          if (c.exitCode !== null) {
            killOwned(c, "SIGKILL");
            clearTimeout(t);
            r();
          }
        });
      }),
    );
    if (stopped) throw stopped;
  }
}

/** Recover containers after the workspace process itself crashed. */
export async function stopManagedContainers(root: string) {
  const path = join(root, "managed/containers.json");
  if (!existsSync(path)) return 0;
  const records = JSON.parse(readFileSync(path, "utf8")) as {
    name: string;
    identity: string;
  }[];
  if (
    !Array.isArray(records) ||
    records.some(
      (r) =>
        !/^loop-laptop-[a-f0-9]+$/.test(r.name) ||
        !/^local-[a-f0-9-]{36}$/.test(r.identity),
    )
  )
    throw new Error("Managed container ownership record is invalid");
  let stopped = 0;
  for (const record of records) {
    const listed = await exec("docker", [
      "ps",
      "-a",
      "--filter",
      `name=^/${record.name}$`,
      "--format",
      "{{.Names}}",
    ]);
    if (!listed.stdout.trim()) continue;
    const found = await exec("docker", [
      "inspect",
      "--format",
      '{{index .Config.Labels "loop.identity"}}',
      record.name,
    ]);
    if (found.stdout.trim() !== record.identity)
      throw new Error("Container identity changed; nothing was stopped");
    await exec("docker", ["stop", "--time", "5", record.name]);
    stopped++;
  }
  atomic(path, []);
  return stopped;
}
