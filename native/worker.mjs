import { HarnessUpgrades } from "./generated/harness-upgrades.mjs";
import https from "node:https";
import { runtimeInventory } from "./runtime-inventory.mjs";
import http from "node:http";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  existsSync,
  renameSync,
  statSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
} from "node:fs";
import { join, relative, extname, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import WebSocket from "ws";
import {
  runnerLoginApi,
  discoverOpencode,
  logoutOpencode,
  discoverPi,
  logoutPi,
} from "./generated/native-auth/service.mjs";
import { inspectCodexAppServer } from "./codex-app-server-status.mjs";
import { piCustomization } from "./generated/pi-customizations.mjs";
import { claudeUsageFile, readClaudeUsage, readCodexUsage } from "./subscription-usage.mjs";

const versions = JSON.parse(
  readFileSync(new URL("../deployment/versions.json", import.meta.url), "utf8"),
);
const settings = JSON.parse(
  readFileSync(process.env.LOOP_WORKER_CONFIG, "utf8"),
);
const launchDir = process.env.LOOP_LAUNCH_DIR;
mkdirSync(launchDir, { recursive: true, mode: 0o700 });
const upgrades = new HarnessUpgrades(join(launchDir, "maintenance", "harness-upgrades.json"));
const root = realpathSync(process.env.LOOP_PROJECT_ROOT);
const generation = Number(process.env.LOOP_ENVIRONMENT_GENERATION);
const credential = readFileSync(settings.credentialFile, "utf8").trim();
const hash = (s) => createHash("sha256").update(s).digest();
function env() {
  const e = { ...process.env };
  delete e.CLI_API_TOKEN;
  for (const key of Object.keys(e))
    if (key.startsWith("LOOP_") && key !== "LOOP_SESSION_TOKEN") delete e[key];
  delete e.LOOP_CODEX_APP_SERVER_TOKEN;
  delete e.LOOP_CODEX_APP_SERVER_ENDPOINT;
  for (const k of Object.keys(e))
    if (
      /^(OPENAI_|ANTHROPIC_|AZURE_OPENAI_|AWS_|GOOGLE_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY)/.test(
        k,
      )
    )
      delete e[k];
  e.HOME = settings.nativeHome;
  if (process.env.LOOP_EXECUTION_KIND === "native") {
    // Preserve unset config-dir variables: macOS keychain profiles can depend
    // on whether these overrides are present, even for the default directory.
    if (settings.codexHome) e.CODEX_HOME = settings.codexHome;
    else delete e.CODEX_HOME;
    if (settings.claudeHome) e.CLAUDE_CONFIG_DIR = settings.claudeHome;
    else delete e.CLAUDE_CONFIG_DIR;
  } else {
    e.CODEX_HOME = settings.codexHome || join(settings.nativeHome, ".codex");
    e.CLAUDE_CONFIG_DIR =
      settings.claudeHome || join(settings.nativeHome, ".claude");
  }
  e.DISABLE_AUTOUPDATER = "1";
  e.CLAUDE_CODE_USE_BEDROCK = "0";
  e.CLAUDE_CODE_USE_VERTEX = "0";
  return e;
}
const binary = (flavor) => {
  const path = {
    codex: settings.codexBinary,
    claude: settings.claudeBinary,
    opencode: settings.opencodeBinary,
    pi: settings.piBinary,
  }[flavor];
  if (!path) throw new Error("Runtime executable unavailable");
  return path;
};
async function command(flavor, args) {
  const child = spawn(binary(flavor), args, {
    env: env(),
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout.on("data", (c) => {
    if (output.length < 64000) output += c;
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 15000);
  try {
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (c) =>
        c === 0 ? resolve() : reject(new Error("Native status unavailable")),
      );
    });
    return output;
  } finally {
    clearTimeout(timer);
  }
}
export async function authStatus(flavor) {
  validFlavor(flavor);
  if (flavor === "opencode")
    return discoverOpencode({
      executable: binary(flavor),
      project: root,
      env: env(),
    });
  if (flavor === "pi") {
    const status = await discoverPi({
      executable: binary(flavor),
      project: root,
      env: env(),
    });
    return { ...status, managed: true, checkedAt: Date.now() };
  }
  if (flavor === "claude") {
    const s = JSON.parse(await command("claude", ["auth", "status", "--json"]));
    return {
      authenticated:
        s.loggedIn === true &&
        ["claude.ai", "oauth"].includes(s.authMethod) &&
        s.apiProvider === "firstParty",
      authMethod: "claude",
      managed: true,
      checkedAt: Date.now(),
      models: ["default", "sonnet", "opus", "haiku"].map((id) => ({
        id,
        name: id,
        capabilities:
          "Native Claude alias; availability depends on your account",
      })),
    };
  }
  return inspectCodexAppServer({
    endpoint: process.env.LOOP_CODEX_APP_SERVER_ENDPOINT,
    token: process.env.LOOP_CODEX_APP_SERVER_TOKEN,
    WebSocketCtor: WebSocket,
  });
}
const validFlavor = (f) => {
  if (
    !["codex", "claude", "opencode", "pi"].includes(f) ||
    (settings.providers && !settings.providers.includes(f))
  )
    throw new Error("Unsupported provider");
  return f;
};
const logins = runnerLoginApi((flavor) => ({
  name: validFlavor(flavor),
  executable: binary(flavor),
  project: root,
  env: env(),
}));
function authorized(req) {
  const supplied = String(req.headers.authorization || "").replace(
    /^Bearer /,
    "",
  );
  const fingerprint = req.socket.getPeerCertificate()?.fingerprint256;
  return (
    req.socket.authorized &&
    fingerprint === settings.appCertificateFingerprint &&
    timingSafeEqual(hash(supplied), hash(credential))
  );
}
const server = https.createServer(
  {
    key: readFileSync(settings.keyFile),
    cert: readFileSync(settings.certFile),
    ca: readFileSync(settings.caFile),
    requestCert: true,
    rejectUnauthorized: true,
  },
  async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    try {
      if (!authorized(req)) {
        res.writeHead(401);
        res.end('{"error":"Unauthorized environment controller"}');
        return;
      }
      let bytes = 0,
        chunks = [];
      for await (const c of req) {
        bytes += c.length;
        if (bytes > 64000) throw new Error("Request too large");
        chunks.push(c);
      }
      const data = bytes ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (req.method === "GET" && req.url === "/status") {
        let machineId;
        try {
          machineId = JSON.parse(
            readFileSync(join(process.env.HAPI_HOME, "settings.json"), "utf8"),
          ).machineId;
        } catch {}
        res.end(
          JSON.stringify({
            instanceId: settings.instanceId,
            gatewayUrl: settings.gatewayUrl,
            generation,
            maintenance: ['codex', 'claude', 'pi', 'opencode'].filter((name) => upgrades.busy(name)),
            machineId,
            versions: {
              hapi: versions.hapi,
              codex: versions.codex,
              claude: versions.claudeCode,
              opencode: versions.opencode,
              pi: versions.pi,
            },
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/runtimes") {
        res.end(
          JSON.stringify(
            await runtimeInventory({
              providers: settings.providers,
              binary,
              authStatus,
            }),
          ),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/subscription-usage") {
        const configDir = settings.claudeHome || env().CLAUDE_CONFIG_DIR || join(settings.nativeHome, ".claude");
        const [codex, claude] = await Promise.all([
          (!settings.providers || settings.providers.includes("codex"))
            ? readCodexUsage({
                endpoint: process.env.LOOP_CODEX_APP_SERVER_ENDPOINT,
                token: process.env.LOOP_CODEX_APP_SERVER_TOKEN,
                WebSocketCtor: WebSocket,
              })
            : { status: "unavailable" },
          (!settings.providers || settings.providers.includes("claude"))
            ? readClaudeUsage(claudeUsageFile(configDir))
            : { status: "unavailable" },
        ]);
        res.end(JSON.stringify({ collectedAt: new Date().toISOString(), codex, claude }));
        return;
      }
      if (req.url?.startsWith("/login/")) {
        if (req.method !== "POST") throw new Error("Sign-in requires POST");
        if (req.url === "/login/start" && upgrades.busy(data.flavor)) throw new Error("Wait for the runtime upgrade to finish before signing in.");
        res.end(JSON.stringify(await logins.request(req.url.slice(7), data)));
        return;
      }
      if (req.url === "/logout") {
        const flavor = validFlavor(data.flavor);
        if (flavor === "opencode")
          await logoutOpencode({
            executable: binary(flavor),
            project: root,
            env: env(),
          });
        else if (flavor === "pi")
          await logoutPi({
            executable: binary(flavor),
            project: root,
            env: env(),
          });
        else
          await command(
            flavor,
            flavor === "codex" ? ["logout"] : ["auth", "logout"],
          );
        res.end('{"ok":true}');
        return;
      }
      if (req.url === "/auth") {
        res.end(JSON.stringify(await authStatus(validFlavor(data.flavor))));
        return;
      }
      if (data.generation !== generation)
        throw new Error("Fenced environment generation");
      if (req.url === "/runtime/upgrade") {
        const flavor = validFlavor(data.flavor);
        if (req.method !== "POST") throw new Error("Upgrade requires POST");
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.commandId)) throw new Error("Invalid upgrade identity");
        const previous = upgrades.operation(flavor, data.commandId);
        if (previous) { res.end(JSON.stringify({ upgrade: previous })); return; }
        if (flavor === "opencode") throw new Error("Managed OpenCode uses Loop’s guarded build. Update Loop and restart the workspace to update this runtime.");
        // Hold the runtime across the sign-in check so /prepare cannot start a
        // session in between; the upgrade takes over the hold in the same tick.
        const release = upgrades.reserve(flavor);
        try {
          const login = await logins.request("status", { flavor });
          if (["starting", "waiting"].includes(login.state)) throw new Error("Finish or cancel sign-in before upgrading.");
          release();
          res.end(JSON.stringify({ upgrade: upgrades.start(flavor, binary(flavor), data.commandId, env(), { restartRequired: flavor === "codex" }) }));
        } finally {
          release();
        }
        return;
      }
      if (req.url === "/runtime/upgrade/dismiss") {
        upgrades.dismiss(validFlavor(data.flavor));
        res.end(JSON.stringify({ upgrade: null }));
        return;
      }
      if (req.url === "/runtime/upgrade/recover") {
        if (req.method !== 'POST' || data.confirmedStopped !== true) throw new Error('Recovery requires confirmation');
        const flavor = validFlavor(data.flavor);
        upgrades.recover(flavor, data.commandId);
        res.end(JSON.stringify({ upgrade: upgrades.status(flavor) }));
        return;
      }
      if (req.url === "/runtime/upgrade/status") {
        const flavor = validFlavor(data.flavor);
        const availability = flavor === "opencode"
          ? { canUpgrade: false, upgradeHelp: "Managed OpenCode uses Loop’s guarded build. Update Loop and restart the workspace to update this runtime." }
          : upgrades.availability(flavor, binary(flavor));
        res.end(JSON.stringify({ upgrade: upgrades.status(flavor), ...availability }));
        return;
      }
      if (req.url === "/project/verify") {
        const path = realpathSync(data.path),
          sub = relative(root, path);
        if (
          sub.startsWith("..") ||
          isAbsolute(sub) ||
          !statSync(path).isDirectory()
        )
          throw new Error("Project escaped root");
        res.end(JSON.stringify({ path }));
        return;
      }
      if (req.url === "/project/clone") {
        const url = new URL(data.repository);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !settings.repositoryHosts?.includes(url.hostname) ||
          !/^[a-zA-Z0-9_-]{1,80}$/.test(data.directory)
        )
          throw new Error("Repository is outside allowed hosts");
        const target = join(root, data.directory);
        if (existsSync(target)) throw new Error("Directory already exists");
        const child = spawn("git", ["clone", "--", url.toString(), target], {
          env: env(),
          stdio: "ignore",
        });
        const timer = setTimeout(() => child.kill(), 30000);
        try {
          await new Promise((resolve, reject) => {
            child.on("error", reject);
            child.on("exit", (c) =>
              c === 0 ? resolve() : reject(new Error("Clone unconfirmed")),
            );
          });
        } finally {
          clearTimeout(timer);
        }
        res.end(JSON.stringify({ path: realpathSync(target) }));
        return;
      }
      if (req.url === "/pi/customizations") {
        if (req.method !== "POST" || data.flavor !== "pi")
          throw new Error("Pi customization requires a Pi request");
        validFlavor("pi");
        const project = realpathSync(data.project);
        const sub = relative(root, project);
        if (
          sub.startsWith("..") ||
          isAbsolute(sub) ||
          !statSync(project).isDirectory()
        )
          throw new Error("Project escaped environment root");
        const processEnv = env();
        res.end(
          JSON.stringify(
            await piCustomization(data, {
              project,
              agentDir:
                processEnv.PI_CODING_AGENT_DIR ||
                join(processEnv.HOME, ".pi", "agent"),
              executable: binary("pi"),
              environment: processEnv,
            }),
          ),
        );
        return;
      }
      if (!/^[a-f0-9-]{36}$/.test(data.launchId))
        throw new Error("Invalid launch identity");
      const file = join(launchDir, data.launchId + ".json");
      if (req.url === "/prepare") {
        if (upgrades.busy(validFlavor(data.flavor))) {
          res.end(JSON.stringify({ deferred: "runtime-maintenance" }));
          return;
        }
        const directory = realpathSync(data.directory),
          sub = relative(root, directory);
        if (sub.startsWith("..") || sub.startsWith("/"))
          throw new Error("Directory is outside approved project root");
        if (data.flavor === "pi") {
          const processEnv = env();
          await piCustomization(
            { action: "guard-trust" },
            {
              project: directory,
              agentDir:
                processEnv.PI_CODING_AGENT_DIR ||
                join(processEnv.HOME, ".pi", "agent"),
              executable: binary("pi"),
              environment: processEnv,
            },
          );
        }
        if (
          data.gatewayUrl !== settings.gatewayUrl ||
          data.gatewayToken?.length < 40 ||
          data.billing?.allowApiFallback !== false
        )
          throw new Error("Invalid managed launch policy");
        if (existsSync(file)) {
          const old = JSON.parse(readFileSync(file, "utf8"));
          if (
            old.directory !== directory ||
            old.flavor !== data.flavor ||
            old.conversationId !== data.conversationId
          )
            throw new Error("Launch identity cannot be reused");
        }
        const tmp = file + ".tmp";
        writeFileSync(
          tmp,
          JSON.stringify({
            ...data,
            directory,
            gatewayUrl: `http://127.0.0.1:${settings.gatewayBridgePort || 3012}/mcp`,
          }),
          { mode: 0o600 },
        );
        renameSync(tmp, file);
        res.end(JSON.stringify({ auth: await authStatus(data.flavor) }));
        return;
      }
      if (req.url === "/verify") {
        const b = JSON.parse(readFileSync(file, "utf8"));
        res.end(JSON.stringify(await authStatus(b.flavor)));
        return;
      }
      if (req.url === "/artifact/read") {
        const b = JSON.parse(readFileSync(file, "utf8"));
        if (
          typeof data.path !== "string" ||
          isAbsolute(data.path) ||
          data.path
            .split(/[\\/]/)
            .some((p) => p === ".." || p.startsWith(".")) ||
          /auth|credential|secret|token/i.test(data.path)
        )
          throw new Error("File is outside published project content");
        const path = realpathSync(join(b.directory, data.path)),
          sub = relative(b.directory, path);
        if (sub.startsWith("..") || isAbsolute(sub))
          throw new Error("File escaped project");
        const types = {
          ".txt": "text/plain",
          ".md": "text/markdown",
          ".pdf": "application/pdf",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".json": "application/json",
          ".csv": "text/csv",
          ".zip": "application/zip",
        };
        const mime = types[extname(path).toLowerCase()];
        if (!mime) throw new Error("File type unavailable");
        const st = statSync(path);
        if (!st.isFile() || st.size > 10 * 1024 * 1024)
          throw new Error("File exceeds upload limit");
        const descriptor = openSync(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        let bytes;
        try {
          const actual = realpathSync(
            process.platform === "linux" ? "/proc/self/fd/" + descriptor : path,
          );
          const within = relative(b.directory, actual);
          if (within.startsWith("..") || isAbsolute(within))
            throw new Error("Opened file escaped project");
          const checked = fstatSync(descriptor);
          if (
            !checked.isFile() ||
            checked.dev !== st.dev ||
            checked.ino !== st.ino ||
            checked.size > 10 * 1024 * 1024
          )
            throw new Error("File changed during publication");
          bytes = Buffer.alloc(checked.size);
          const { readSync } = await import("node:fs");
          const count = readSync(descriptor, bytes, 0, bytes.length, 0);
          if (
            count !== bytes.length ||
            fstatSync(descriptor).size !== checked.size
          )
            throw new Error("File changed during publication");
        } finally {
          closeSync(descriptor);
        }
        if (!bytes.length || bytes.length > 10 * 1024 * 1024)
          throw new Error("File exceeds upload limit");
        res.end(
          JSON.stringify({
            base64: bytes.toString("base64"),
            mime,
            checksum: createHash("sha256").update(bytes).digest("base64"),
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end('{"error":"Unknown worker operation"}');
    } catch {
      res.writeHead(409);
      res.end(
        '{"error":"Native environment operation could not be verified. Check provider setup and project mapping."}',
      );
    }
  },
);
server.listen(settings.port || 3010, settings.listenHost || "0.0.0.0");
// Native runtimes use ordinary localhost HTTP MCP/HAPI transports. Only this
// supervisor owns the mutual TLS connection and environment credential.
const tls = {
  cert: readFileSync(settings.certFile),
  key: readFileSync(settings.keyFile),
  ca: readFileSync(settings.caFile),
};
for (const [port, base] of [
  [settings.gatewayBridgePort || 3012, settings.gatewayUrl],
  [settings.hapiBridgePort || 3013, settings.hapiUrl],
]) {
  const destination = new URL(base);
  if (destination.protocol !== "https:")
    throw new Error("Private transport requires HTTPS");
  const headers = (req) => ({
    ...req.headers,
    host: destination.host,
    "x-loop-environment-token": credential,
  });
  const bridge = http.createServer((req, res) => {
    const upstream = https.request(
      destination.origin +
        (port === (settings.gatewayBridgePort || 3012)
          ? destination.pathname
          : req.url),
      { ...tls, method: req.method, headers: headers(req) },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  bridge.on("upgrade", (req, socket, head) => {
    if (
      port !== (settings.hapiBridgePort || 3013) ||
      !req.url.startsWith("/socket.io/")
    ) {
      socket.destroy();
      return;
    }
    const upstream = https.request(destination.origin + req.url, {
      ...tls,
      headers: headers(req),
    });
    upstream.on("upgrade", (response, remote, remoteHead) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          Object.entries(response.headers)
            .map(([k, v]) => k + ": " + v)
            .join("\r\n") +
          "\r\n\r\n",
      );
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote);
      remote.pipe(socket);
      socket.on("close", () => remote.destroy());
      remote.on("error", () => socket.destroy());
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  bridge.listen(port, "127.0.0.1");
}
