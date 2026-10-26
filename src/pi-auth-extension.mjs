// Loaded only into a dedicated, prompt-free sign-in process. Pi owns auth.json.
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createReadStream, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";

export default function loopSignIn(pi) {
  pi.on("input", () => ({ action: "handled" }));
  pi.on("session_start", async () => {
    // hasConfiguredAuth reads the availability snapshot populated by refresh.
    // Skipping it makes existing native credentials appear signed out.
    const runtime = await ModelRuntime.create({ allowModelNetwork: false });
    // Pi's compiled binary closes a net.Socket on fd 3 immediately, so read
    // and write the descriptor directly, as pi-extension.mjs does.
    const channel = createReadStream(null, { fd: 3, autoClose: false });
    const send = (value) => writeSync(3, JSON.stringify(value) + "\n");
    const pending = new Map();
    let abort;
    let buffer = "";
    channel.on("error", () => abort?.abort());
    channel.on("end", () => abort?.abort());
    channel.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 100000) {
        channel.destroy();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          continue;
        }
        if (message.type === "input") pending.get(message.id)?.(message.value);
        if (message.type === "logout" && !abort) {
          abort = new AbortController();
          void runtime
            .logout(message.provider, { signal: abort.signal })
            .then(
              () => send({ type: "logout_complete" }),
              () => send({ type: "logout_failed" }),
            )
            .finally(() => {
              abort = undefined;
            });
          continue;
        }
        if (message.type !== "login" || abort) continue;
        abort = new AbortController();
        void runtime
          .login(
            message.provider,
            message.method === "api" ? "api_key" : "oauth",
            {
              signal: abort.signal,
              notify(event) {
                if (event.type === "auth_url")
                  send({
                    type: "link",
                    url: event.url,
                    instructions: event.instructions,
                  });
                if (event.type === "device_code")
                  send({
                    type: "link",
                    url: event.verificationUri,
                    code: event.userCode,
                  });
              },
              prompt(prompt) {
                return new Promise((resolve, reject) => {
                  const id = randomUUID();
                  const cleanup = () => {
                    pending.delete(id);
                    prompt.signal?.removeEventListener("abort", cancelled);
                  };
                  const cancelled = () => {
                    cleanup();
                    send({ type: "clear_prompt", id });
                    reject(new Error("Cancelled"));
                  };
                  if (prompt.signal?.aborted) return cancelled();
                  prompt.signal?.addEventListener("abort", cancelled, {
                    once: true,
                  });
                  pending.set(id, (value) => {
                    cleanup();
                    resolve(value);
                  });
                  send({
                    type: "prompt",
                    id,
                    prompt: {
                      type: prompt.type,
                      message: prompt.message,
                      options: prompt.options?.map(({ id, label }) => ({
                        id,
                        label,
                      })),
                    },
                  });
                });
              },
            },
          )
          .then(
            () => send({ type: "complete" }),
            () => send({ type: "failed" }),
          )
          .finally(() => {
            abort = undefined;
          });
      }
    });
    send({
      type: "providers",
      providers: runtime
        .getProviders()
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          configured: runtime.hasConfiguredAuth(provider.id),
          methods: [
            ...(provider.auth?.oauth
              ? [
                  {
                    id: "oauth",
                    type: "oauth",
                    label:
                      provider.auth.oauth.loginLabel ||
                      provider.auth.oauth.name,
                  },
                ]
              : []),
            ...(provider.auth?.apiKey?.login
              ? [{ id: "api", type: "api", label: provider.auth.apiKey.name }]
              : []),
          ],
        }))
        .filter((provider) => provider.methods.length),
    });
  });
}
