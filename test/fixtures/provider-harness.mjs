// Native provider protocols with isolated credential files; no provider traffic.
import { createServer } from "node:http";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const name = process.env.LOOP_TEST_HARNESS;
const dir = process.env.LOOP_TEST_PROVIDER_DIR;
const file = join(dir, name + "-auth.json");
const read = () =>
  existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const environment = () =>
  existsSync(join(dir, name + "-environment.json"))
    ? JSON.parse(readFileSync(join(dir, name + "-environment.json"), "utf8"))
    : {};
const configuration = () =>
  existsSync(join(dir, name + "-config.json"))
    ? JSON.parse(readFileSync(join(dir, name + "-config.json"), "utf8"))
    : {};
const credentials = () => ({ ...configuration(), ...environment(), ...read() });
const audit = (action) =>
  appendFileSync(join(dir, "provider-audit"), `${name}:${action}\n`);
const names = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
};
const methods = (id) => [
  ...(id === "anthropic"
    ? [{ id: "oauth", type: "oauth", label: "Claude sign-in" }]
    : []),
  { id: "api", type: "api", label: "API key" },
];
const providers = () =>
  Object.entries(names).map(([id, label]) => ({
    id,
    name: label,
    configured: !!credentials()[id],
    source: read()[id]
      ? "stored"
      : environment()[id]
        ? "environment"
        : configuration()[id]
          ? "configuration"
          : "unknown",
    credentialType: credentials()[id]?.type,
    removable: !!read()[id],
    methods: methods(id),
    secret: "fixture-private-must-not-project",
  }));
const models = () =>
  Object.keys(credentials()).map((provider) => ({
    provider,
    id: provider === "openrouter" ? "vendor/model" : "model",
    name: `${names[provider]} model`,
    key: "fixture-private-model-field",
  }));
function save(provider, type, key) {
  writeFileSync(
    file,
    JSON.stringify({ ...read(), [provider]: { type, key } }),
    { mode: 0o600 },
  );
  audit("save:" + provider);
  if (existsSync(join(dir, `fail-${name}-discovery-after-save`)))
    writeFileSync(join(dir, `fail-${name}-version`), "yes");
  if (existsSync(join(dir, "lose-" + name + "-reply"))) process.exit(1);
}
function remove(provider) {
  const auth = read();
  delete auth[provider];
  writeFileSync(file, JSON.stringify(auth), { mode: 0o600 });
  audit("remove:" + provider);
}
if (process.argv.includes("--version")) {
  if (existsSync(join(dir, `fail-${name}-version`))) process.exit(1);
  console.log(name === "pi" ? "0.87.1" : "1.18.32");
} else if (name === "pi") {
  const channel = new Socket({ fd: 3, readable: true, writable: true });
  const send = (value) => channel.write(JSON.stringify(value) + "\n");
  const signingIn = process.argv.some((a) =>
    a.endsWith("/pi-auth-extension.mjs"),
  );
  if (signingIn) {
    send({ type: "providers", providers: providers() });
    let login;
    createInterface({ input: channel }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type === "models")
        send({
          type: "models",
          models: models().map((m) => ({ ...m, id: m.provider + "/" + m.id })),
        });
      if (message.type === "login") {
        login = message;
        if (message.method === "oauth")
          send({ type: "link", url: "https://claude.ai/fixture-sign-in" });
        send({
          type: "prompt",
          id: "credential",
          prompt: {
            type: message.method === "api" ? "secret" : "manual_code",
            message: "Enter provider credential",
          },
        });
      }
      if (message.type === "input") {
        save(login.provider, login.method, message.value);
        const complete = () => {
          if (existsSync(join(dir, "hold-login"))) setTimeout(complete, 10);
          else send({ type: "complete" });
        };
        complete();
      }
      if (message.type === "logout") {
        remove(message.provider);
        send({ type: "logout_complete" });
      }
    });
  } else {
    if (existsSync(join(dir, "fail-pi-model-refresh"))) process.exit(1);
    const model = models()[0];
    send({
      configured: !!model,
      subscription: credentials()[model?.provider]?.type === "oauth",
      provider: model?.provider,
      model: model?.id,
      modelBilling: models().map((m) => ({
        id: m.provider + "/" + m.id,
        subscription: credentials()[m.provider]?.type === "oauth",
      })),
    });
    createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type === "prompt") {
        audit("UNEXPECTED_PROMPT");
        process.exit(2);
      }
      const data =
        message.type === "get_state"
          ? { model, thinkingLevel: "off", sessionId: "fixture" }
          : message.type === "get_available_models"
            ? { models: models() }
            : message.type === "get_available_thinking_levels"
              ? { levels: ["off"] }
              : message.type === "get_commands"
                ? { commands: [] }
                : message.type === "get_messages"
                  ? { messages: [] }
                  : {};
      process.stdout.write(
        JSON.stringify({
          type: "response",
          id: message.id,
          command: message.type,
          success: true,
          data,
        }) + "\n",
      );
    });
  }
} else {
  const authorization =
    "Basic " +
    Buffer.from(
      process.env.OPENCODE_SERVER_USERNAME +
        ":" +
        process.env.OPENCODE_SERVER_PASSWORD,
    ).toString("base64");
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture").pathname;
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== authorization) {
      res.writeHead(401);
      return res.end("{}");
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const respond = (data) => res.end(JSON.stringify(data));
    if (path === "/provider/auth")
      return respond(
        Object.fromEntries(Object.keys(names).map((id) => [id, methods(id)])),
      );
    if (path === "/provider")
      return respond({
        all: providers().map((p) => ({
          ...p,
          source:
            p.source === "stored"
              ? "api"
              : p.source === "environment"
                ? "env"
                : p.source === "configuration"
                  ? "config"
                  : undefined,
          models: Object.fromEntries(
            models()
              .filter((m) => m.provider === p.id)
              .map((m) => [m.id, m]),
          ),
        })),
        connected: Object.keys(credentials()),
      });
    if (path.startsWith("/auth/")) {
      const provider = decodeURIComponent(path.slice(6));
      if (req.method === "PUT") save(provider, body.type, body.key);
      if (req.method === "DELETE") remove(provider);
      return respond(true);
    }
    if (path === "/config") {
      if (existsSync(join(dir, "fail-model-refresh"))) {
        res.writeHead(503);
        return respond({ error: "Fixture model probe failure" });
      }
      const model = models()[0];
      return respond({
        model: model ? model.provider + "/" + model.id : undefined,
      });
    }
    if (path === "/command") return respond([]);
    audit("UNEXPECTED_ENDPOINT:" + path);
    res.writeHead(404);
    respond({ error: "Unsupported fixture endpoint" });
  });
  server.listen(0, "127.0.0.1", () =>
    console.log(
      "opencode server listening on http://127.0.0.1:" + server.address().port,
    ),
  );
}
