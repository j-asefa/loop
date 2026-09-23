import { useId, useState, useEffect, useRef, type FormEvent } from "react";
import { ClipboardPaste, KeyRound, RefreshCw, Unplug } from "lucide-react";
import { api, parse } from "./api";
import { Badge, Sheet } from "./components";
import type { Connection } from "../shared/types";
type Login = {
  state?: string;
  error?: string;
  authenticated?: boolean;
  expiresAt?: number;
  login?: { url: string; code?: string; acceptsCode: boolean };
};
const subscription = (c: Connection) =>
  parse<any>(c.metadata, {}).authMode === "subscription";
export function Connections({
  connections,
  onChange,
  onClose,
}: {
  connections: Connection[];
  onChange: () => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"subscription" | "api">("subscription"),
    [provider, setProvider] = useState("codex"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [secret, setSecret] = useState(""),
    [showSecret, setShowSecret] = useState(false),
    [pasteMessage, setPasteMessage] = useState(""),
    [edit, setEdit] = useState<string | null>(null),
    [active, setActive] = useState<string | null>(
      connections.find((c) => subscription(c) && c.status === "signing_in")
        ?.id || null,
    ),
    [login, setLogin] = useState<Login | null>(null);
  const secretId = useId();

  async function pasteKey() {
    try {
      // Keep the read inside this user gesture for Safari's clipboard access.
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        setPasteMessage("Copy your API key first, then tap Paste.");
        return;
      }
      setSecret(text);
      setPasteMessage("Key pasted.");
    } catch {
      setPasteMessage(
        "Tap Show key, then touch and hold the field and choose Paste.",
      );
    }
  }

  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    if (!active) return;
    let live = true,
      polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const value = await api<Login>(`/subscriptions/${active}/status`, {});
        if (!live) return;
        setLogin(value);
        if (
          value.authenticated ||
          value.state === "failed" ||
          value.state === "cancelled" ||
          value.authenticated === false
        ) {
          setActive(null);
          await changed.current();
          if (value.error) setError(value.error);
        }
      } catch (e) {
        if (live) {
          setError((e as Error).message);
          setActive(null);
        }
      } finally {
        polling = false;
      }
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active]);
  async function begin(id: string) {
    setError("");
    const value = await api<Login>(
      `/subscriptions/${id}/${connections.find((c) => c.id === id)?.status === "signing_in" ? "status" : "login"}`,
      {},
    );
    setLogin(value);
    setActive(id);
    await onChange();
  }
  async function connect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const form = e.currentTarget,
      f = new FormData(form);
    try {
      if (mode === "subscription") {
        const record = await api("/subscriptions", {
          provider,
          label: f.get("label"),
        });
        await onChange();
        await begin(record.id);
      } else {
        await api(edit ? `/connections/${edit}/reconnect` : "/connections", {
          provider,
          label: f.get("label"),
          secret: secret.trim(),
        });
        setEdit(null);
        await onChange();
      }
      form.reset();
      setSecret("");
      setShowSecret(false);
      setPasteMessage("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function act(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Provider connections" onClose={onClose}>
      <p className="muted">
        Use your ChatGPT or Claude subscription. Sign-in stays with the official
        provider runtime. Import past conversations separately.
      </p>
      <div className="connection-list">
        {connections.map((c) => {
          const meta = parse<any>(c.metadata, {}),
            sub = subscription(c);
          return (
            <div className="connection-card" key={c.id}>
              <div>
                <Badge provider={c.provider} />
                <h3>{c.label}</h3>
                <p className="muted">
                  {c.status.replaceAll("_", " ")} ·{" "}
                  {sub ? "Subscription allowance" : "API-billed"}
                  {meta.plan ? ` · ${meta.plan}` : ""}
                </p>
              </div>
              <div className="actions">
                <button
                  disabled={busy}
                  aria-label={"Refresh " + c.label}
                  className="icon-button"
                  onClick={() =>
                    act(() =>
                      api(
                        sub
                          ? `/subscriptions/${c.id}/status`
                          : `/connections/${c.id}/refresh`,
                        {},
                      ),
                    )
                  }
                >
                  <RefreshCw size={17} />
                </button>
                <button
                  disabled={busy || !!active}
                  className="text-button"
                  onClick={() =>
                    sub
                      ? act(() => begin(c.id))
                      : (setMode("api"), setEdit(c.id), setProvider(c.provider))
                  }
                >
                  {sub ? "Sign in / reconnect" : "Reconnect"}
                </button>
                <button
                  disabled={busy}
                  aria-label={"Disconnect " + c.label}
                  className="icon-button"
                  onClick={() =>
                    act(async () => {
                      await api(`/connections/${c.id}`, {}, "DELETE");
                      if (active === c.id) {
                        setActive(null);
                        setLogin(null);
                      }
                    })
                  }
                >
                  <Unplug size={17} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {active && (
        <section className="note" aria-label="Subscription sign-in">
          <h3>Finish signing in</h3>
          {login?.login ? (
            <>
              <a
                href={login.login.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open provider sign-in
              </a>
              {login.login.code && (
                <p>
                  Enter this code on the provider page:{" "}
                  <strong>{login.login.code}</strong>
                </p>
              )}
              {login.login.acceptsCode && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    e.currentTarget.reset();
                    void act(() =>
                      api(`/subscriptions/${active}/code`, {
                        code: f.get("code"),
                      }),
                    );
                  }}
                >
                  <label>
                    One-time sign-in code
                    <input
                      name="code"
                      autoComplete="off"
                      required
                      maxLength={4096}
                      placeholder="Paste the code shown by Claude"
                    />
                  </label>
                  <p>
                    The code is passed directly to Claude Code’s native login
                    flow. Never paste a password or API key here.
                  </p>
                  <button disabled={busy} className="primary">
                    Complete sign-in
                  </button>
                </form>
              )}
            </>
          ) : (
            <p>Starting the official sign-in flow…</p>
          )}
          <p>
            Waiting for the provider to confirm. This sign-in expires after 10
            minutes.
          </p>
          <button
            className="text-button"
            onClick={() =>
              act(async () => {
                await api(`/subscriptions/${active}/cancel`, {});
                setActive(null);
                setLogin(null);
              })
            }
          >
            Cancel sign-in
          </button>
        </section>
      )}
      <div className="provider-picker">
        <button
          type="button"
          className={mode === "subscription" ? "selected" : ""}
          onClick={() => {
            setMode("subscription");
            setProvider("codex");
            setEdit(null);
          }}
        >
          Use my subscription
        </button>
        <button
          type="button"
          className={mode === "api" ? "selected" : ""}
          onClick={() => {
            setMode("api");
            setProvider("openai");
            setEdit(null);
          }}
        >
          Use an API key
        </button>
      </div>
      <form onSubmit={connect}>
        <h3>{edit ? "Reconnect account" : "Add a connection"}</h3>
        <label>
          Provider
          <select
            aria-label="Provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={!!edit}
          >
            {mode === "subscription" ? (
              <>
                <option value="codex">ChatGPT subscription · Codex</option>
                <option value="claude">
                  Claude subscription · Claude Code
                </option>
              </>
            ) : (
              <>
                <option value="openai">OpenAI API</option>
                <option value="anthropic">Anthropic API</option>
              </>
            )}
          </select>
        </label>
        {!edit && (
          <label>
            Account label
            <input
              name="label"
              placeholder="Personal account"
              required
              maxLength={80}
            />
          </label>
        )}
        {mode === "api" && (
          <div className="api-key-field">
            <label htmlFor={secretId}>API key</label>
            <div className="api-key-input">
              <input
                id={secretId}
                name="secret"
                type={showSecret ? "text" : "password"}
                value={secret}
                onChange={(e) => {
                  setSecret(e.target.value);
                  setPasteMessage("");
                }}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                required
                placeholder="Paste your API key"
                aria-describedby={secretId + "-status"}
              />
              <button
                type="button"
                className="text-button"
                aria-controls={secretId}
                onClick={() => setShowSecret(!showSecret)}
              >
                {showSecret ? "Hide key" : "Show key"}
              </button>
            </div>
            <div className="api-key-actions">
              <button
                type="button"
                className="text-button"
                onClick={pasteKey}
                disabled={busy}
              >
                <ClipboardPaste size={16} /> Paste
              </button>
              <span id={secretId + "-status"} className="muted" role="status">
                {pasteMessage || "Stored securely on the server."}
              </span>
            </div>
          </div>
        )}
        <p className="note">
          {mode === "subscription"
            ? "Uses your provider subscription through its official runtime. Plan limits and any extra-usage settings apply. Loop never switches this connection to API billing. Responses appear after validation; tool requests still need your approval."
            : "API usage is billed separately from your subscription. This is an optional connection."}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary"
          disabled={busy || (mode === "subscription" && !!active)}
        >
          <KeyRound size={17} />
          {busy
            ? "Connecting…"
            : mode === "subscription"
              ? "Continue to subscription sign-in"
              : "Validate and connect"}
        </button>
      </form>
    </Sheet>
  );
}
