import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CircleCheck } from "lucide-react";
import { api } from "./api";
import {
  workspaceApi,
  type RouteInput,
  type RouteResponse,
} from "../shared/workspace-api";
import { callRoute, readRoute } from "./workspace-api";
import { useProjectionRoute, useSourceId } from "./SourceContext";
type NativeAuthView = RouteResponse<typeof workspaceApi.runtimeAuthStatus>;
type SignIn = NonNullable<NativeAuthView["attempt"]>;
type Target =
  | {
      runtime: RouteInput<
        typeof workspaceApi.runtimeAuthStatus
      >["params"]["name"];
      base?: never;
      backend: "direct";
    }
  | {
      base: `/subscriptions/${string}/native-auth`;
      runtime?: never;
      backend: "environment";
    };

type RuntimeSignInProps = Target & {
  location: string;
  name: string;
  label: string;
  projectId?: string;
  signedIn: boolean;
  enabled: boolean;
  enabling: boolean;
  enableAction: ReactNode;
  connectionSetup?: ReactNode;
  onStateChange(
    name: string,
    state: SignIn["state"] | undefined,
    attemptId?: string,
  ): void;
  onClose(): void;
};

// Pi and OpenCode have no account of their own; sign-in connects the model
// provider they call, so the copy names the provider rather than the harness.
export const connectsModelProvider = (name: string) =>
  name === "pi" || name === "opencode";

function forStartCommand(
  view: NativeAuthView,
  commandId?: string,
): NativeAuthView {
  const attempt = view.attempt;
  // An older completed attempt is evidence of the old account, not success
  // for the new start. Keep unrelated active attempts visible for cancellation.
  if (
    commandId &&
    attempt &&
    attempt.commandId !== commandId &&
    !["starting", "waiting"].includes(attempt.state)
  )
    return { providers: view.providers };
  return view;
}

export function RuntimeSignIn(props: RuntimeSignInProps) {
  return (
    <RuntimeSignInSession
      // The account belongs to the runtime, not the project: a project change
      // refetches the catalog without discarding an in-progress sign-in view.
      key={`${props.backend}:${props.runtime ?? props.base}`}
      {...props}
    />
  );
}

function RuntimeSignInSession({
  base,
  runtime,
  backend,
  location,
  name,
  label,
  projectId,
  signedIn,
  enabled,
  enabling,
  enableAction,
  connectionSetup,
  onStateChange,
  onClose,
}: RuntimeSignInProps) {
  const sourceId = useSourceId();
  const read = useProjectionRoute();
  const [view, setView] = useState<NativeAuthView>();
  const [provider, setProvider] = useState("");
  const [method, setMethod] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [changingAccount, setChangingAccount] = useState(false);
  const [startRecovery, setStartRecovery] = useState<{
    id: string;
    inspected?: boolean;
  }>();
  const mounted = useRef(true);
  const requestId = useRef<string | undefined>(undefined);
  const attempt = view?.attempt;
  const waiting = !!attempt && ["starting", "waiting"].includes(attempt.state);
  const selected = view?.providers.find((p) => p.id === provider);
  const complete =
    (!startRecovery || attempt?.commandId === startRecovery.id) &&
    (attempt?.state === "complete" ||
      // CLI catalogs don't report `configured` for credentials that predate this
      // auth manager (a restart, or a sign-in outside Loop); the runtime's own
      // signed-in status covers those.
      (!attempt && !changingAccount && (selected?.configured ?? signedIn)));
  const selectedMethod = selected?.methods.find((m) => m.id === method);
  const receive = (
    next: NativeAuthView,
    recoveryCommand: string | null = startRecovery?.id ?? null,
  ) => {
    if (!mounted.current) return;
    next = forStartCommand(next, recoveryCommand ?? undefined);
    setError("");
    if (
      next.attempt &&
      (!recoveryCommand || next.attempt.commandId === recoveryCommand) &&
      ["starting", "waiting", "complete"].includes(next.attempt.state)
    )
      setStartRecovery(undefined);
    onStateChange(name, next.attempt?.state, next.attempt?.id);
    if (!next.providers.length && !next.attempt) {
      setView((old) =>
        old?.attempt
          ? {
              providers: old.providers,
              attempt: {
                id: old.attempt.id,
                commandId: old.attempt.commandId,
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
      const first =
        next.providers.find((p) => p.configured) || next.providers[0];
      setProvider((old) => old || first?.id || "");
      setMethod((old) => old || first?.methods[0]?.id || "");
    }
  };
  function catalog(signal?: AbortSignal) {
    return runtime
      ? signal
        ? readRoute(
            workspaceApi.runtimeAuthProviders,
            {
              params: { name: runtime },
              query: { projectId: projectId || "" },
            },
            sourceId,
            signal,
          )
        : read(workspaceApi.runtimeAuthProviders, {
            params: { name: runtime },
            query: { projectId: projectId || "" },
          })
      : api<NativeAuthView>(`${base}/providers`, {}, undefined, signal);
  }
  function status(signal?: AbortSignal, onRetry?: (error: unknown) => void) {
    return runtime
      ? signal
        ? readRoute(
            workspaceApi.runtimeAuthStatus,
            { params: { name: runtime } },
            sourceId,
            signal,
            onRetry,
          )
        : read(workspaceApi.runtimeAuthStatus, { params: { name: runtime } })
      : api<NativeAuthView>(`${base}/status`, {}, undefined, signal);
  }
  useEffect(() => {
    mounted.current = true;
    setError("");
    const controller = new AbortController();
    void catalog(controller.signal)
      .then(receive)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [base, runtime, sourceId, projectId, reload]);
  useEffect(() => {
    if (!waiting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await status(controller.signal, () =>
          setError("Couldn’t check sign-in. Reconnecting…"),
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
  }, [base, runtime, sourceId, waiting, attempt?.id]);
  // Clear a new prompt before it can accept input. A passive effect can run
  // after the user types and erase that response, leaving Continue disabled.
  useLayoutEffect(() => setValue(""), [attempt?.id, attempt?.prompt?.id]);
  async function perform(
    action: () => Promise<NativeAuthView>,
    confirmedStart = false,
  ) {
    setBusy(true);
    setError("");
    try {
      receive(
        await action(),
        confirmedStart ? null : (startRecovery?.id ?? null),
      );
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function start(newAttempt = false) {
    if (busy || !selectedMethod) return;
    if (newAttempt) requestId.current = undefined;
    const commandId = (requestId.current ||= crypto.randomUUID());
    setStartRecovery(undefined);
    void perform(async () => {
      try {
        const body = {
          projectId: projectId || "",
          provider,
          method,
          commandId,
        };
        const next = runtime
          ? await callRoute(
              workspaceApi.runtimeAuthStart,
              { params: { name: runtime }, body },
              sourceId,
            )
          : await api<NativeAuthView>(`${base}/start`, body);
        requestId.current = undefined;
        return next;
      } catch (error) {
        if (mounted.current) setStartRecovery({ id: commandId });
        throw error;
      }
    }, true);
  }
  function inspectStart() {
    const failure = startRecovery;
    void perform(async () => {
      let next = await status();
      // A restarted authority has no cached providers until discovery runs.
      // Load the catalog without creating a sign-in attempt.
      if (!next.providers.length && !next.attempt) next = await catalog();
      next = forStartCommand(next, failure?.id);
      if (
        mounted.current &&
        (!next.attempt ||
          !["starting", "waiting", "complete"].includes(next.attempt.state))
      )
        setStartRecovery((current) =>
          current === failure && current
            ? { ...current, inspected: true }
            : current,
        );
      return next;
    });
  }
  function answer() {
    if (busy || !attempt?.prompt || !value.trim()) return;
    const input = value;
    setValue("");
    const body = {
      attemptId: attempt.id,
      promptId: attempt.prompt.id,
      value: input,
    };
    void perform(() =>
      runtime
        ? callRoute(
            workspaceApi.runtimeAuthInput,
            { params: { name: runtime }, body },
            sourceId,
          )
        : api<NativeAuthView>(`${base}/input`, body),
    );
  }
  return (
    <section
      className="native-sign-in settings-sign-in"
      aria-label={`${label} account`}
    >
      {complete ? (
        <>
          <div className="native-sign-in-success" role="status">
            <CircleCheck size={22} aria-hidden="true" />
            <div>
              <h3>
                {!view
                  ? "Saved account"
                  : enabled
                    ? "Ready in Loop"
                    : connectsModelProvider(name)
                      ? `Provider connected to ${label}`
                      : `Signed in to ${label}`}
              </h3>
              {enabled && (
                <p>
                  {connectsModelProvider(name)
                    ? `Provider connected to ${label}`
                    : `Signed in to ${label}`}
                </p>
              )}
            </div>
          </div>
          <p>
            {enabling
              ? "Connecting this account to Loop…"
              : enabled
                ? `Refresh ${label} to update the models available in Loop.`
                : "Your account is saved. Finish connecting to make it available in Loop."}
          </p>
          <ol className="connection-steps" aria-label="Connection progress">
            <li>✓ Sign in</li>
            <li>{enabled ? "✓" : "2."} Connect to Loop</li>
          </ol>
          {connectionSetup}
          {enableAction}
        </>
      ) : connectsModelProvider(name) ? (
        <>
          <h3>Connect a model provider for {label}</h3>
          <p>
            {label} runs on {location} and needs a model provider. Choose one,
            then sign in or enter its API key. {label} saves the credential in{" "}
            {location}.
          </p>
        </>
      ) : (
        <>
          <h3>Sign in to {label}</h3>
          <p>
            Your account is saved by {label} in {location}. Complete the
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
      {view && !waiting && !complete && (
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
                setStartRecovery(undefined);
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
                setStartRecovery(undefined);
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
            target="_blank"
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
            setChangingAccount(true);
            setView({ providers: view!.providers });
            requestId.current = undefined;
            setStartRecovery(undefined);
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
          onClick={() => start()}
        >
          Start sign-in
        </button>
      )}
      {!waiting && !complete && (
        // Not every harness reports an existing sign-in (one made outside
        // Loop, or before a restart). Enabling checks the account itself.
        <details className="settings-details">
          <summary>Already signed in on {location}?</summary>
          <p className="field-hint">
            Connect {label} without signing in again. Loop checks the account
            before enabling it.
          </p>
          {connectionSetup}
          {enableAction}
        </details>
      )}
      {!waiting && !complete && startRecovery && (
        <div>
          <p>
            {startRecovery.inspected
              ? "No sign-in is in progress. Start a new sign-in if needed."
              : "Check sign-in status before starting a new attempt."}
          </p>
          <button
            type="button"
            disabled={busy || !selectedMethod}
            onClick={() =>
              startRecovery.inspected ? start(true) : inspectStart()
            }
          >
            {startRecovery.inspected
              ? "Start new sign-in"
              : "Check sign-in status"}
          </button>
        </div>
      )}
      {waiting && startRecovery && attempt?.commandId !== startRecovery.id && (
        <p className="note">
          A different sign-in is in progress. Continue or cancel it before
          starting a new one.
        </p>
      )}
      {waiting && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void perform(() =>
              runtime
                ? callRoute(
                    workspaceApi.runtimeAuthCancel,
                    {
                      params: { name: runtime },
                      body: { attemptId: attempt!.id },
                    },
                    sourceId,
                  )
                : api<NativeAuthView>(`${base}/cancel`, {
                    attemptId: attempt!.id,
                  }),
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
