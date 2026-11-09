import { museHost } from "../adapters/muse.js";
import type { AuthDriver } from "../server/native-auth.js";
import type { AuthOptions } from "../server/native-auth.js";

// Muse Code's MSP host owns sign-in: a device-code flow for a Meta account or
// a stored API key. Credentials stay in Muse's own store.
export async function museDriver(options: AuthOptions): Promise<AuthDriver> {
  const { native } = await museHost(
    options.executable,
    options.project,
    options.env,
  );
  let dead = false;
  let current: ((outcome: string) => void) | undefined;
  native.on("failure", () => {
    dead = true;
    current?.("failed");
  });
  native.on("message", (m) => {
    if (m.method === "account/loginCompleted") current?.(m.params?.outcome);
    if (m.id !== undefined && m.method)
      void native
        .write({
          id: m.id,
          error: { code: -32601, message: "Unsupported Loop client request" },
        })
        .catch(() => {});
  });
  const configured = async () => {
    const account = await native.request("account/read", {});
    return ["accountLogin", "apiKey", "envKey"].includes(account.state);
  };
  return {
    get dead() {
      return dead;
    },
    async providers() {
      return [
        {
          id: "meta",
          name: "Meta",
          configured: await configured(),
          methods: [
            { id: "oauth", type: "oauth", label: "Sign in with Meta" },
            { id: "api", type: "api", label: "Meta API key" },
          ],
        },
      ];
    },
    async logout() {
      await native.request("account/logout", {});
    },
    async login(_provider, method, io) {
      if (dead) throw new Error("Muse Code account process exited");
      let settle!: (outcome: string) => void;
      const outcome = new Promise<string>((resolve) => (settle = resolve));
      current = settle;
      // Muse reports the cancelled flow before answering loginCancel, so
      // settle only then: a late outcome must not reach the next login.
      const abort = () =>
        void native
          .request("account/loginCancel", {})
          .catch(() => {})
          .finally(() => settle("cancelled"));
      io.signal.addEventListener("abort", abort, { once: true });
      try {
        if (method === "api") {
          const apiKey = await io.prompt({
            type: "secret",
            message: "Enter your Meta API key",
          });
          await native.request("account/loginStart", {
            type: "apiKey",
            apiKey,
          });
        } else {
          const flow = await native.request("account/loginStart", {
            type: "deviceCode",
          });
          if (new URL(flow.verificationUrl).hostname !== "auth.meta.com")
            throw new Error("Unsupported sign-in response");
          io.link(flow.verificationUrl, flow.userCode);
          if ((await outcome) !== "granted") throw new Error("Sign-in failed");
        }
        // An API key settles with loginStart itself; the account state, not a
        // completion notification, confirms it.
        if (!(await configured()))
          throw new Error("Provider did not confirm authentication");
      } finally {
        if (current === settle) current = undefined;
        io.signal.removeEventListener("abort", abort);
      }
    },
    async dispose() {
      current?.("cancelled");
      await native.dispose();
    },
  };
}
