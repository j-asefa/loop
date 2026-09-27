// Official binaries, disposable native home, no provider/model calls.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const root = mkdtempSync("/tmp/loop-native-compat-");
const env = {
  PATH: process.env.PATH,
  HOME: root,
  CODEX_HOME: root + "/.codex",
  CLAUDE_CONFIG_DIR: root + "/.claude",
  DISABLE_AUTOUPDATER: "1",
};
mkdirSync(env.CODEX_HOME);
mkdirSync(env.CLAUDE_CONFIG_DIR);
const report = {
  versions: {
    hapi: execFileSync("hapi", ["--version"], { encoding: "utf8", env }).trim(),
    codex: execFileSync("codex", ["--version"], {
      encoding: "utf8",
      env,
    }).trim(),
    claude: execFileSync("claude", ["--version"], {
      encoding: "utf8",
      env,
    }).trim(),
  },
};
async function inspect(cachedApi = false) {
  if (cachedApi)
    writeFileSync(
      env.CODEX_HOME + "/auth.json",
      JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: "synthetic-invalid-not-a-credential",
      }),
      { mode: 0o600 },
    );
  const child = spawn(
    "codex",
    [
      "app-server",
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      'model_provider="openai"',
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const wait = new Map();
  let n = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (text) => {
    try {
      const m = JSON.parse(text);
      if (wait.has(m.id)) {
        const p = wait.get(m.id);
        wait.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    } catch {}
  });
  const timer = setTimeout(() => {
    for (const p of wait.values()) p.reject(new Error("timeout"));
    child.kill();
  }, 30000);
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++n;
      wait.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ method, params, id }) + "\n");
    });
  try {
    await request("initialize", {
      clientInfo: { name: "loop-compatibility", version: "1" },
    });
    child.stdin.write('{"method":"initialized"}\n');
    const account = await request("account/read", { refreshToken: true });
    const config = await request("config/read", { includeLayers: false });
    if (
      config.config.forced_login_method !== "chatgpt" ||
      config.config.model_provider !== "openai"
    )
      throw new Error("Policy not effective");
    if (account.account?.type === "chatgpt")
      throw new Error("Disposable home unexpectedly authenticated");
    return {
      authMethod: account.account?.type || "unknown",
      subscriptionAllowed: false,
      forcedLoginMethod: config.config.forced_login_method,
    };
  } finally {
    clearTimeout(timer);
    child.kill();
    lines.close();
  }
}
report.missingAuth = await inspect();
report.cachedApi = await inspect(true);
const c = spawn("claude", ["auth", "status", "--json"], {
  env,
  stdio: ["ignore", "pipe", "ignore"],
});
let out = "";
c.stdout.on("data", (b) => (out += b));
await new Promise((r) => c.on("close", r));
const status = JSON.parse(out);
report.claude = {
  authenticated: status.loggedIn,
  authMethod: status.authMethod,
  apiProvider: status.apiProvider,
};
if (status.loggedIn)
  throw new Error("Disposable Claude home unexpectedly authenticated");
report.liveTurn = "Blocked: human provider sign-in not performed";
console.log(JSON.stringify(report, null, 2));
