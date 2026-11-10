import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { Native } from "../native.js";
import type { AuthDriver } from "./types.js";
import type { AuthOptions } from "./types.js";
import type { AuthInteraction } from "./types.js";
import type { AuthProvider } from "../shared/native-auth.js";

export async function piDriver(options: AuthOptions): Promise<AuthDriver> {
  const native = new Native(
    options.executable,
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--extension",
      fileURLToPath(new URL("../pi-auth-extension.mjs", import.meta.url)),
    ],
    options.project,
    options.env,
  );
  const channel = native.child.stdio[3] as Duplex;
  let dead = false;
  let current:
    | { io: AuthInteraction; resolve(): void; reject(error: Error): void }
    | undefined;
  let logout: { resolve(): void; reject(error: Error): void } | undefined;
  let modelRequest:
    { resolve(models: unknown): void; reject(error: Error): void } | undefined;
  const prompts = new Map<string, AbortController>();
  const providers = await new Promise<AuthProvider[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Pi authentication setup timed out")),
      20000,
    );
    native.on("failure", () => {
      dead = true;
      logout?.reject(new Error("Pi sign-out process exited"));
      modelRequest?.reject(new Error("Pi catalog process exited"));
      clearTimeout(timer);
      reject(new Error("Pi authentication process exited"));
      current?.reject(new Error("Pi authentication process exited"));
      current = undefined;
    });
    native.on("metadata", (message) => {
      if (message.type === "providers") {
        clearTimeout(timer);
        resolve(message.providers);
      }
      if (message.type === "logout_complete") logout?.resolve();
      if (message.type === "models") modelRequest?.resolve(message.models);
      if (message.type === "models_failed")
        modelRequest?.reject(new Error("Pi catalog refresh failed"));
      if (message.type === "logout_failed")
        logout?.reject(new Error("Pi sign-out failed"));
      const login = current;
      if (!login || login.io.signal.aborted) return;
      if (message.type === "link")
        login.io.link(message.url, message.code, message.instructions);
      if (message.type === "prompt") {
        const controller = new AbortController();
        prompts.set(message.id, controller);
        void login.io
          .prompt(message.prompt, controller.signal)
          .then(
            (value) => {
              if (
                !controller.signal.aborted &&
                current === login &&
                !login.io.signal.aborted
              )
                channel.write(
                  JSON.stringify({ type: "input", id: message.id, value }) +
                    "\n",
                );
            },
            (error) => {
              if (
                !controller.signal.aborted &&
                current === login &&
                !login.io.signal.aborted
              ) {
                current = undefined;
                login.reject(
                  error instanceof Error
                    ? error
                    : new Error("Pi sign-in prompt failed"),
                );
              }
            },
          )
          .finally(() => prompts.delete(message.id));
      }
      if (message.type === "clear_prompt") prompts.get(message.id)?.abort();
      if (message.type === "complete") {
        login.resolve();
        current = undefined;
      }
      if (message.type === "failed") {
        login.reject(new Error("Pi sign-in failed"));
        current = undefined;
      }
    });
  }).catch(async (error) => {
    await native.dispose();
    throw error;
  });
  return {
    get dead() {
      return dead;
    },
    async providers() {
      return providers;
    },
    async models() {
      if (dead) throw new Error("Pi authentication process exited");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise((resolve, reject) => {
          modelRequest = { resolve, reject };
          timer = setTimeout(
            () => reject(new Error("Pi catalog refresh timed out")),
            30000,
          );
          channel.write(JSON.stringify({ type: "models" }) + "\n");
        });
      } finally {
        clearTimeout(timer);
        modelRequest = undefined;
      }
    },
    async logout(provider) {
      if (dead || current || logout)
        throw new Error("Pi account process unavailable");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          logout = { resolve, reject };
          timer = setTimeout(
            () => reject(new Error("Pi sign-out timed out")),
            20000,
          );
          channel.write(JSON.stringify({ type: "logout", provider }) + "\n");
        });
      } finally {
        clearTimeout(timer);
        logout = undefined;
      }
    },
    login(provider, method, io) {
      return new Promise<void>((resolve, reject) => {
        if (dead) return reject(new Error("Pi authentication process exited"));
        current = { io, resolve, reject };
        channel.write(
          JSON.stringify({ type: "login", provider, method }) + "\n",
        );
      });
    },
    async dispose() {
      modelRequest?.reject(new Error("Catalog cancelled"));
      logout?.reject(new Error("Sign-out cancelled"));
      current?.reject(new Error("Sign-in cancelled"));
      current = undefined;
      for (const prompt of prompts.values()) prompt.abort();
      await native.dispose();
    },
  };
}
