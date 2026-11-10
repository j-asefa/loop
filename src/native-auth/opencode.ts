import { randomBytes } from "node:crypto";
import type { AuthDriver } from "./types.js";
import type { AuthOptions } from "./types.js";
import { spawnHarnessProcess, stopHarnessProcess } from "../native-spawn.js";

export async function openCodeDriver(
  options: AuthOptions,
): Promise<AuthDriver> {
  const password = randomBytes(32).toString("hex");
  const authOverride = !!(options.env ?? process.env).OPENCODE_AUTH_CONTENT;
  const child = spawnHarnessProcess(
    options.executable,
    ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: options.project,
      stdio: "pipe",
      env: {
        ...(options.env ?? process.env),
        OPENCODE_SERVER_USERNAME: "loop",
        OPENCODE_SERVER_PASSWORD: password,
      },
    },
  );
  child.stderr.resume();
  const origin = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error("OpenCode authentication setup timed out")),
      20000,
    );
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("OpenCode exited"));
    };
    child.on("error", fail);
    child.on("exit", fail);
    child.stdout.on("data", (chunk) => {
      buffer = (buffer + chunk.toString()).slice(-16000);
      const url = buffer.match(
        /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/,
      )?.[1];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    });
  }).catch(async (error) => {
    await stopHarnessProcess(child);
    throw error;
  });
  const api = async (
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
    signal = AbortSignal.timeout(15000),
  ) => {
    const response = await fetch(origin + path, {
      method,
      signal,
      redirect: "error",
      headers: {
        Authorization:
          "Basic " + Buffer.from("loop:" + password).toString("base64"),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error("OpenCode authentication failed");
    return response.json();
  };
  let methods: Record<string, any[]> = {};
  return {
    async providers() {
      const [catalog, auth] = await Promise.all([
        api("/provider"),
        api("/provider/auth"),
      ]);
      methods = auth;
      return catalog.all.map((provider: any) => ({
        id: provider.id,
        name: provider.name,
        configured: catalog.connected.includes(provider.id),
        source:
          provider.source === "env" ||
          (authOverride && ["api", "custom"].includes(provider.source))
            ? "environment"
            : provider.source === "api"
              ? "stored"
              : provider.source === "config"
                ? "configuration"
                : "unknown",
        ...(provider.source === "api"
          ? { credentialType: "api" as const }
          : {}),
        // Configuration/custom availability is not evidence of stored auth.
        // OpenCode's public catalog only identifies stored API credentials.
        removable: !authOverride && provider.source === "api",
        methods: (auth[provider.id] || [{ type: "api", label: "API key" }]).map(
          (method: any, index: number) => ({
            id: String(index),
            label: method.label,
            type: method.type,
          }),
        ),
      }));
    },
    async login(provider, method, io) {
      const entry = methods[provider]?.[Number(method)] || { type: "api" };
      const path = encodeURIComponent(provider);
      if (entry.type === "api") {
        const key = await io.prompt({
          type: "secret",
          message: "Enter your provider API key",
        });
        await api("/auth/" + path, { type: "api", key }, "PUT", io.signal);
      } else {
        const inputs: Record<string, string> = {};
        for (const prompt of entry.prompts || []) {
          const condition = prompt.when ?? prompt.condition;
          if (
            condition &&
            (condition.op === "eq"
              ? inputs[condition.key] !== condition.value
              : inputs[condition.key] === condition.value)
          )
            continue;
          inputs[prompt.key] = await io.prompt({
            type: prompt.type === "select" ? "select" : "text",
            message: prompt.message,
            options: prompt.options?.map((option: any) => ({
              id: option.value,
              label: option.label,
            })),
          });
        }
        const authorization = await api(
          `/provider/${path}/oauth/authorize`,
          { method: Number(method), inputs },
          "POST",
          io.signal,
        );
        if (!["code", "auto"].includes(authorization.method))
          throw new Error("Unsupported authorization method");
        io.link(authorization.url, undefined, authorization.instructions);
        const code =
          authorization.method === "code"
            ? await io.prompt({
                type: "manual_code",
                message:
                  authorization.instructions ||
                  "Paste the provider verification code",
              })
            : undefined;
        if (
          (await api(
            `/provider/${path}/oauth/callback`,
            { method: Number(method), code },
            "POST",
            io.signal,
          )) !== true
        )
          throw new Error("Provider did not confirm authentication");
      }
      const catalog = await api("/provider");
      if (!catalog.connected.includes(provider))
        throw new Error("Provider did not confirm authentication");
    },
    async logout(provider) {
      await api("/auth/" + encodeURIComponent(provider), undefined, "DELETE");
    },
    async models() {
      const catalog = await api("/provider");
      return catalog.all
        .filter((p: any) => catalog.connected.includes(p.id))
        .flatMap((p: any) =>
          Object.entries(p.models || {}).map(([id, m]: [string, any]) => ({
            id: p.id + "/" + id,
            name: m.name || id,
          })),
        );
    },
    async dispose() {
      await stopHarnessProcess(child);
    },
  };
}
