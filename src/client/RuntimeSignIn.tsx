import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleCheck } from "lucide-react";
import { api } from "./api";
import type { NativeAuthView, SignIn } from "../shared/native-auth";

export function RuntimeSignIn({
  name,
  label,
  projectId,
  signedIn,
  enabled,
  enabling,
  enableAction,
  onStateChange,
  onClose,
}: {
  name: string;
  label: string;
  projectId: string;
  signedIn: boolean;
  enabled: boolean;
  enabling: boolean;
  enableAction: ReactNode;
  onStateChange(name: string, state: SignIn["state"] | undefined): void;
  onClose(): void;
}) {
  const base = `/workspace/runtimes/${name}/auth`;
  const nativeShell = !!(window as { ReactNativeWebView?: unknown })
    .ReactNativeWebView;
  const [view, setView] = useState<NativeAuthView>();
  const [provider, setProvider] = useState("");
  const [method, setMethod] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  const requestId = useRef<string | undefined>(undefined);
  const attempt = view?.attempt;
  const complete = attempt?.state === "complete" || (!view && signedIn);
  const waiting = !!attempt && ["starting", "waiting"].includes(attempt.state);
  const selected = view?.providers.find((p) => p.id === provider);
  const selectedMethod = selected?.methods.find((m) => m.id === method);
  const receive = (next: NativeAuthView) => {
    if (!mounted.current) return;
    onStateChange(name, next.attempt?.state);
    if (!next.providers.length && !next.attempt) {
      setView((old) =>
        old?.attempt
          ? {
              providers: old.providers,
              attempt: {
                id: old.attempt.id,
                provider: old.attempt.provider,
                method: old.attempt.method,
                state: "expired",
                expiresAt: Date.now(),
              },
            }
          : next,
      );
      return;
    }
    setView(next);
    if (next.attempt) {
      setProvider(next.attempt.provider);
      setMethod(next.attempt.method);
    } else {
      setProvider((old) => old || next.providers[0]?.id || "");
      setMethod((old) => old || next.providers[0]?.methods[0]?.id || "");
    }
  };
  useEffect(() => {
    mounted.current = true;
    setError("");
    const controller = new AbortController();
    void api<NativeAuthView>(
      `${base}?projectId=${encodeURIComponent(projectId)}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then(receive)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [base, projectId, reload]);
  useEffect(() => {
    if (!waiting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<NativeAuthView>(
          base + "/status",
          undefined,
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          receive(next);
          setError("");
        }
      } catch {
        if (!controller.signal.aborted)
          setError("Couldn’t check sign-in. Reconnecting…");
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1200);
    };
    timer = setTimeout(poll, 800);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [base, waiting, attempt?.id]);
  useEffect(() => setValue(""), [attempt?.prompt?.id]);
  async function perform(action: () => Promise<NativeAuthView>) {
    setBusy(true);
    setError("");
    try {
      receive(await action());
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function answer() {
    if (busy || !attempt?.prompt || !value.trim()) return;
    const input = value;
    setValue("");
    void perform(() =>
      api(base + "/input", {
        attemptId: attempt.id,
        promptId: attempt.prompt!.id,
        value: input,
      }),
    );
  }
  return (
    <section
      className="native-decision native-sign-in"
      aria-label={`${label} account`}
    >
      {complete ? (
        <>
          <div className="native-sign-in-success" role="status">
            <CircleCheck size={22} aria-hidden="true" />
            <h3>Signed in to {label}</h3>
          </div>
          <p>
            {enabled
              ? `Refresh ${label} to update the models available in Loop.`
              : `Enable ${label} to use its models in Loop.`}
          </p>
          {enableAction}
        </>
      ) : (
        <>
          <h3>Sign in to {label}</h3>
          <p>
            Your account is saved by {label} on this computer. Complete the
            provider’s sign-in, then return here.
          </p>
        </>
      )}
      {!view && !error && !complete && <p role="status">Loading providers…</p>}
      {!view && error && (
        <button type="button" onClick={() => setReload((n) => n + 1)}>
          Try loading providers again
        </button>
      )}
      {view && !view.providers.length && (
        <p>No sign-in methods are available from this harness.</p>
      )}
      {view && !waiting && attempt?.state !== "complete" && (
        <>
          <label>
            Provider
            <select
              aria-label={`${label} sign-in provider`}
              value={provider}
              disabled={busy}
              onChange={(e) => {
                setProvider(e.target.value);
                setMethod(
                  view.providers.find((p) => p.id === e.target.value)
                    ?.methods[0]?.id || "",
                );
                requestId.current = undefined;
              }}
            >
              {view.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.configured ? " · signed in" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Sign-in method
            <select
              aria-label="Sign-in method"
              value={method}
              disabled={busy}
              onChange={(e) => {
                setMethod(e.target.value);
                requestId.current = undefined;
              }}
            >
              {selected?.methods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {name === "pi" && provider === "anthropic" && (
        <p className="note">
          Claude sign-in through Pi uses separately billed extra usage. It does
          not use your included Claude plan allowance.
        </p>
      )}
      {selectedMethod?.type === "api" && (
        <p className="note">
          This provider bills API usage separately from subscriptions. Entering
          a key does not change Loop’s selected billing policy.
        </p>
      )}
      {attempt?.url && (
        <>
          {attempt.code && (
            <p>
              Enter this code on the provider’s page:{" "}
              <strong>{attempt.code}</strong>
            </p>
          )}
          {attempt.instructions && <p>{attempt.instructions}</p>}
          <a
            className="btn primary"
            href={attempt.url}
            // Older native shells already intercept external top-frame links.
            target={nativeShell ? "_self" : "_blank"}
            rel="noreferrer"
          >
            Open provider sign-in
          </a>
        </>
      )}
      {waiting && !attempt?.prompt && (
        <p role="status">
          {attempt?.url
            ? "Waiting for provider authorization…"
            : "Starting sign-in…"}
        </p>
      )}
      {waiting && attempt?.prompt && (
        <div
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              answer();
            }
          }}
        >
          <label>
            {attempt.prompt.message}
            {attempt.prompt.type === "select" ? (
              <select
                aria-label="Provider sign-in response"
                value={value}
                disabled={busy}
                onChange={(e) => setValue(e.target.value)}
              >
                <option value="">Choose an option</option>
                {attempt.prompt.options?.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-label="Provider sign-in response"
                type={attempt.prompt.type === "secret" ? "password" : "text"}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={value}
                disabled={busy}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !value.trim()}
            onClick={answer}
          >
            Continue sign-in
          </button>
        </div>
      )}
      {complete && view && (
        <button
          type="button"
          className="text-button"
          disabled={enabling}
          onClick={() => {
            setView({ providers: view!.providers });
            requestId.current = undefined;
            setError("");
          }}
        >
          Change account
        </button>
      )}
      {attempt &&
        ["failed", "cancelled", "expired"].includes(attempt.state) && (
          <p role="status">
            {attempt.state === "failed"
              ? "Sign-in did not complete. Check the provider’s response and try again."
              : `Sign-in ${attempt.state}. You can start again.`}
          </p>
        )}
      {!waiting && !complete && (
        <button
          type="button"
          className="btn primary"
          disabled={busy || !selectedMethod}
          onClick={() => {
            requestId.current ||= crypto.randomUUID();
            void perform(async () => {
              const next = await api<NativeAuthView>(base + "/start", {
                projectId,
                provider,
                method,
                commandId: requestId.current,
              });
              requestId.current = undefined;
              return next;
            });
          }}
        >
          Start sign-in
        </button>
      )}
      {waiting && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void perform(() =>
              api(base + "/cancel", { attemptId: attempt!.id }),
            )
          }
        >
          Cancel sign-in
        </button>
      )}
      <button
        type="button"
        className="text-button"
        disabled={enabling}
        onClick={onClose}
      >
        {complete ? "Done" : "Close"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
