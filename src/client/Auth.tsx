import { capabilities } from "./capabilities";
import { Pairing } from "./Pairing";
import { useState, useEffect, type FormEvent } from "react";
import { Orbit, ArrowRight, ShieldCheck } from "lucide-react";
import { readRoute, callRoute } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import { executionSourceId } from "./sourceRouting";
function ServerAuth({ onDone }: { onDone: () => void }) {
  const [github, setGithub] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    readRoute(
      workspaceApi.authOptions,
      {},
      executionSourceId(),
      controller.signal,
    )
      .then((v) => setGithub(v.github))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const [signup, setSignup] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await callRoute(
        signup ? workspaceApi.authSignUpEmail : workspaceApi.authSignInEmail,
        {
          body: {
            name: String(f.get("name") || "Loop55 user"),
            email: String(f.get("email") || ""),
            password: String(f.get("password") || ""),
          },
        },
        executionSourceId(),
      );
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-story">
        <div className="wordmark">
          <Orbit />
          loop55
          <span className="wordmark-dot" />
        </div>
        <div>
          <span className="eyebrow">A little space for big ideas</span>
          <h1>
            Keep your agents.
            <br />
            Stay in the loop.
          </h1>
          <p>One workspace for your ideas, agents, and everything they make.</p>
          <div className="auth-lines">
            <span>01 &nbsp; Give an idea somewhere to go.</span>
            <span>02 &nbsp; Let your agents take it further.</span>
            <span>03 &nbsp; Keep the work, not the scroll.</span>
          </div>
        </div>
        <span className="muted">
          <ShieldCheck size={15} /> Your workspace is private.
        </span>
      </div>
      <section className="auth-form">
        <span className="eyebrow">Welcome to Loop55</span>
        <h2>
          {signup ? "Make room for your ideas." : "Pick up where you left off."}
        </h2>
        <p className="muted">
          {signup
            ? "Create your account to get started."
            : "Sign in to your workspace."}
        </p>
        {github && (
          <button
            onClick={async () => {
              try {
                const r = await callRoute(
                  workspaceApi.authSignInSocial,
                  {
                    body: {
                      provider: "github",
                      callbackURL: location.href,
                    },
                  },
                  executionSourceId(),
                );
                if (r.url) location.assign(r.url);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Continue with GitHub
          </button>
        )}
        <form onSubmit={send}>
          {signup && (
            <label>
              Your name
              <input name="name" autoComplete="name" required />
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={signup ? "new-password" : "current-password"}
              minLength={12}
              required
              placeholder={signup ? "At least 12 characters" : ""}
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy
              ? "Opening your workspace…"
              : signup
                ? "Create account"
                : "Sign in"}
            <ArrowRight size={18} />
          </button>
        </form>
        <button
          className="text-button"
          onClick={() => {
            setSignup(!signup);
            setError("");
          }}
        >
          {signup
            ? "Already have an account? Sign in"
            : "New here? Create an account"}
        </button>
      </section>
    </div>
  );
}

export function Auth(props: Parameters<typeof ServerAuth>[0]) {
  return capabilities.pairedDevices ? (
    <Pairing {...props} />
  ) : (
    <ServerAuth {...props} />
  );
}
