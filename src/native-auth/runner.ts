export { discoverClaudeModels, claudeAuthStatus } from "./claude-discovery.js";
export { discoverOpencode, logoutOpencode } from "./opencode-discovery.js";
export { inspectPiAuth, discoverPi, logoutPi } from "./pi-status.js";
export { inspectOpencodeNativeAuth } from "../../native/loopManaged.js";
import { piExistingEnvironment } from "../../native/loopManaged.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createAuthDriver } from "./drivers.js";
import { opencodeSignInEnvironment } from "./runner-environment.js";
import {
  NativeSignIns,
  type AuthDriver,
  type AuthOptions,
} from "../server/native-auth.js";
import type { AuthProvider } from "../shared/native-auth.js";

// This module is bundled for the isolated runner. No database or host settings
// may be imported: credentials and subprocesses belong to this runner alone.
export function runnerSignIns(factory = createAuthDriver) {
  return new NativeSignIns(
    async (options: AuthOptions): Promise<AuthDriver> => {
      if (!options.env)
        throw new Error("Runner sign-in requires an explicit environment");
      if (!["codex", "claude", "opencode", "pi"].includes(options.name))
        throw new Error("Unsupported runtime");
      const driver = await factory(
        options.name === "opencode"
          ? { ...options, env: opencodeSignInEnvironment(options.env) }
          : options.name === "pi"
            ? { ...options, env: piExistingEnvironment(options.env) }
            : options,
      );
      let allowed: AuthProvider[] = [];
      return {
        get dead() {
          return driver.dead;
        },
        async providers() {
          allowed = (await driver.providers()).flatMap((provider) => {
            if (options.name === "pi") return [provider]; // Existing billing.
            const id = options.name === "claude" ? "anthropic" : "openai";
            if (provider.id !== id) return [];
            const methods = provider.methods.filter(
              (method) =>
                method.type === "oauth" &&
                (options.name === "opencode" || method.id === "oauth"),
            );
            return methods.length ? [{ ...provider, methods }] : [];
          });
          return allowed;
        },
        async login(provider, method, interaction) {
          if (
            !allowed.some(
              (p) =>
                p.id === provider && p.methods.some((m) => m.id === method),
            )
          )
            throw new Error(
              "Sign-in method is outside the runner billing policy",
            );
          return driver.login(provider, method, interaction);
        },
        dispose: () => driver.dispose(),
      };
    },
  );
}

// Transport adapter shared by the worker and its fixtures. Browser input never
// participates in executable, project or environment resolution.
export function runnerLoginApi(
  options: (name: string) => AuthOptions,
  auth = runnerSignIns(),
) {
  const pendingLegacy = new Map<string, Promise<unknown>>();
  const view = (name: string) => {
    const rich = auth.status(name);
    const attempt = rich.attempt;
    return {
      ...rich,
      ...(attempt
        ? {
            id: attempt.id,
            state: attempt.state,
            expiresAt: attempt.expiresAt,
            ...(attempt.url
              ? {
                  login: {
                    url: attempt.url,
                    code: attempt.code,
                    acceptsCode: attempt.prompt?.type === "manual_code",
                  },
                }
              : {}),
          }
        : { state: "idle" }),
    };
  };
  return {
    async request(action: string, input: unknown) {
      const data = loginRequest.parse(input);
      const resolved = options(data.flavor);
      const name = resolved.name;
      if (action === "providers") {
        await auth.catalog(resolved);
      } else if (action === "start") {
        if (data.commandId || data.provider || data.method) {
          await auth.start(
            resolved,
            nonempty.parse(data.provider),
            nonempty.parse(data.method),
            identity.parse(data.commandId),
          );
        } else {
          // Old clients have no command ID. Coalesce concurrent starts and keep
          // the active attempt when a response was lost. New runtimes require
          // explicit provider/method selection through the richer protocol.
          if (!["codex", "claude"].includes(name))
            throw new Error("Choose a provider and sign-in method");
          let pending = pendingLegacy.get(name);
          if (!pending) {
            pending = (async () => {
              await auth.catalog(resolved);
              if (!auth.inProgress(name))
                await auth.start(
                  resolved,
                  name === "claude" ? "anthropic" : "openai",
                  "oauth",
                  randomUUID(),
                );
            })().finally(() => pendingLegacy.delete(name));
            pendingLegacy.set(name, pending);
          }
          await pending;
        }
      } else if (action === "cancel") {
        await auth.cancel(name, identity.parse(data.attemptId));
      } else if (action === "input") {
        auth.answer(
          name,
          identity.parse(data.attemptId),
          identity.parse(data.promptId),
          z.string().max(8192).parse(data.value),
        );
      } else if (action === "code") {
        const prompt = auth.status(name).attempt?.prompt;
        if (prompt?.type !== "manual_code")
          throw new Error("No native code prompt is pending");
        auth.answer(
          name,
          identity.parse(data.attemptId),
          prompt.id,
          z
            .string()
            .min(1)
            .max(2048)
            .regex(/^[^\r\n]+$/)
            .parse(data.code),
        );
      } else if (action !== "status") {
        throw new Error("Unsupported sign-in operation");
      }
      return view(name);
    },
    close: () => auth.close(),
  };
}

const identity = z.string().uuid();
const nonempty = z.string().min(1).max(200);
const loginRequest = z.object({
  flavor: nonempty,
  provider: nonempty.optional(),
  method: nonempty.optional(),
  commandId: identity.optional(),
  attemptId: identity.optional(),
  promptId: identity.optional(),
  value: z.string().max(8192).optional(),
  code: z.string().max(2048).optional(),
});
