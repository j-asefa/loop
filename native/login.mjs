import { randomUUID } from "node:crypto";

// Ephemeral authentication exchanges never enter the Hub transcript or logs.
// Each provider owns its attempt, so late process events cannot alter another.
export function nativeLogins({ spawn, binary, env, lifetime = 900000 }) {
  const attempts = new Map();
  const valid = (flavor) => {
    if (!["codex", "claude"].includes(flavor))
      throw new Error("Unsupported provider");
    return flavor;
  };
  const view = (attempt) =>
    attempt
      ? {
          id: attempt.id,
          state: attempt.state,
          expiresAt: attempt.expiresAt,
          ...(attempt.url
            ? {
                login: {
                  url: attempt.url,
                  code: attempt.code,
                  acceptsCode: attempt.acceptsCode,
                },
              }
            : {}),
        }
      : { state: "idle" };
  const stop = (attempt, state) => {
    clearTimeout(attempt.timer);
    attempt.state = state;
    const child = attempt.process;
    attempt.process = null;
    delete attempt.url;
    delete attempt.code;
    child?.kill();
  };
  const current = (flavor, id) => {
    const attempt = attempts.get(valid(flavor));
    if (!attempt || attempt.id !== id)
      throw new Error("This sign-in attempt is no longer current");
    return attempt;
  };
  return {
    status(flavor) {
      return view(attempts.get(valid(flavor)));
    },
    start(flavor) {
      valid(flavor);
      const prior = attempts.get(flavor);
      // Retrying after a lost HTTP response must not replace the native login.
      if (prior?.process && prior.expiresAt > Date.now()) return view(prior);
      if (prior?.process) stop(prior, "expired");
      const child = spawn(
        binary(flavor),
        flavor === "codex"
          ? ["login", "--device-auth"]
          : ["auth", "login", "--claudeai"],
        {
          env: { ...env(), BROWSER: "false" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const attempt = {
        id: randomUUID(),
        state: "starting",
        expiresAt: Date.now() + lifetime,
        process: child,
      };
      attempts.set(flavor, attempt);
      let output = "";
      const live = () =>
        attempts.get(flavor) === attempt && attempt.process === child;
      const consume = (chunk) => {
        if (!live()) return;
        output = (output + chunk.toString())
          .replace(/\x1b\[[0-9;]*m/g, "")
          .slice(-16000);
        const url = (output.match(/https:\/\/[^\s<>"']+/g) || []).find(
          (value) => {
            try {
              return /(^|\.)(openai\.com|anthropic\.com|claude\.ai|chatgpt\.com)$/.test(
                new URL(value).hostname,
              );
            } catch {
              return false;
            }
          },
        );
        if (url) {
          attempt.url = url;
          attempt.code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0];
          attempt.acceptsCode = /paste.*code|enter.*code/i.test(output);
          attempt.state = "waiting";
        }
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      const finish = (state) => {
        if (live()) {
          attempt.process = null;
          stop(attempt, state);
        }
        output = "";
      };
      child.on("exit", (code) => finish(code === 0 ? "complete" : "failed"));
      child.on("error", () => finish("failed"));
      attempt.timer = setTimeout(() => {
        if (live()) stop(attempt, "expired");
        output = "";
      }, lifetime);
      attempt.timer.unref();
      return view(attempt);
    },
    cancel(flavor, id) {
      stop(current(flavor, id), "cancelled");
    },
    code(flavor, id, code) {
      const attempt = current(flavor, id);
      if (
        !attempt.process ||
        !attempt.acceptsCode ||
        attempt.expiresAt <= Date.now() ||
        typeof code !== "string" ||
        !code.length ||
        code.length > 2048 ||
        /[\r\n]/.test(code)
      )
        throw new Error("No native code prompt is pending");
      attempt.process.stdin.write(code + "\n");
    },
    dispose() {
      for (const attempt of attempts.values()) stop(attempt, "cancelled");
      attempts.clear();
    },
  };
}
