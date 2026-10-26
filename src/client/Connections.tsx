import { useProjectionRoute } from "./SourceContext";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { callRoute } from "./workspace-api";
import { executionSourceId } from "./sourceRouting";
import { capabilities } from "./capabilities";
import { RuntimeHosts } from "./RuntimeHosts";
import { NativeConnections } from "./NativeConnections";
import { useId, useState, useEffect, useRef, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Asterisk,
  Check,
  ChevronRight,
  ClipboardPaste,
  LoaderCircle,
  Plus,
  RefreshCw,
  Sparkles,
  Unplug,
} from "lucide-react";
import { api, parse } from "./api";
import { Sheet } from "./components";
import type { Connection } from "../shared/types";

const providers = {
  chatgpt: {
    name: "ChatGPT",
    company: "OpenAI",
    runtime: "Codex",
    subscription: "codex",
    api: "openai",
  },
  claude: {
    name: "Claude",
    company: "Anthropic",
    runtime: "Claude Code",
    subscription: "claude",
    api: "anthropic",
  },
} as const;
type Brand = keyof typeof providers;
type Method = "subscription" | "api";
type Account = {
  id: string;
  brand: Brand;
  method: Method;
  label: string;
  status: string;
  runtimeHostId?: string;
  runtimeKind?: string;
  plan?: string;
};
type Screen =
  | { page: "accounts" }
  | { page: "providers" }
  | { page: "setup"; brand: Brand; method: Method; account?: Account }
  | { page: "signin"; account: Account }
  | { page: "connected"; account: Account };
type SubscriptionResponse = RouteResponse<typeof workspaceApi.subscriptionAction>;
function loginView(value: SubscriptionResponse) {
  return {
    state: "state" in value ? value.state : undefined,
    error: "error" in value ? value.error : undefined,
    authenticated: "authenticated" in value ? value.authenticated : undefined,
    authMode: "authMode" in value ? value.authMode : undefined,
    expiresAt: "expiresAt" in value ? value.expiresAt : undefined,
    login: "login" in value ? value.login : undefined,
  };
}
type Login = ReturnType<typeof loginView>;
async function subscriptionAction(id: string, action: "login" | "status" | "code" | "cancel", body: unknown = {}) {
  return loginView(await callRoute(workspaceApi.subscriptionAction, { params: { id, action }, body }, executionSourceId()));
}
function accountFrom(c: Connection): Account {
  const meta = parse<{
    authMode?: string;
    runtimeHostId?: string;
    runtimeKind?: string;
    plan?: string;
  }>(c.metadata, {});
  return {
    id: c.id,
    brand: c.provider === "anthropic" ? "claude" : "chatgpt",
    method: meta.authMode === "subscription" ? "subscription" : "api",
    label: c.label,
    status: c.status,
    runtimeHostId: meta.runtimeHostId,
    runtimeKind: meta.runtimeKind,
    plan: meta.plan,
  };
}
const hostAccount = (kind?: string) =>
  kind === "codex-app-server" || kind === "native-host";
function screenTitle(screen: Screen) {
  if (screen.page === "accounts") return "Provider connections";
  if (screen.page === "providers") return "Choose a provider";
  if (screen.page === "setup")
    return `${screen.account ? "Reconnect" : "Connect"} ${providers[screen.brand].name}`;
  const name = providers[screen.account.brand].name;
  if (screen.page === "signin" && hostAccount(screen.account.runtimeKind))
    return `Connect remote ${providers[screen.account.brand].name}`;
  return screen.page === "signin" ? `Sign in to ${name}` : `${name} connected`;
}
function ProviderMark({ brand }: { brand: Brand }) {
  return (
    <span className={`connection-mark ${brand}`} aria-hidden="true">
      {brand === "claude" ? <Asterisk size={25} /> : <Sparkles size={23} />}
    </span>
  );
}

function ServerConnections({
  connections,
  onChange,
  onClose,
}: {
  connections: Connection[];
  onChange: () => Promise<void>;
  onClose: () => void;
}) {
  const [screen, setScreen] = useState<Screen>({
      page: connections.length ? "accounts" : "providers",
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [label, setLabel] = useState(""),
    [secret, setSecret] = useState(""),
    [showSecret, setShowSecret] = useState(false),
    [pasteMessage, setPasteMessage] = useState(""),
    [login, setLogin] = useState<Login | null>(null),
    [polling, setPolling] = useState(false),
    [pollVersion, setPollVersion] = useState(0),
    [hosts, setHosts] = useState<RouteResponse<typeof workspaceApi.runtimeHostList>>(
      [],
    ),
    [hostsError, setHostsError] = useState(""),
    [addingHost, setAddingHost] = useState(false),
    [runtimeHostId, setRuntimeHostId] = useState("");
  const read = useProjectionRoute();
  const secretId = useId(),
    heading = useRef<HTMLHeadingElement>(null),
    generation = useRef(0),
    locked = useRef(false),
    mounted = useRef(true),
    changed = useRef(onChange);
  changed.current = onChange;
  const title = screenTitle(screen),
    setup = screen.page === "setup" ? screen : null,
    choice = setup ? providers[setup.brand] : null,
    signing = screen.page === "signin" ? screen.account : null,
    direct =
      setup?.method === "subscription" &&
      hostAccount(hosts.find((h) => h.id === runtimeHostId)?.kind);
  const current = (ticket: number) =>
    mounted.current && generation.current === ticket;
  useEffect(() => {
    mounted.current = true;
    void read(workspaceApi.runtimeHostList, {})
      .then((value) => mounted.current && setHosts(value))
      .catch((e) => mounted.current && setHostsError(e.message));
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    heading.current
      ?.closest("dialog")
      ?.querySelector(".sheet-body")
      ?.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [title, screen.page]);

  function clearKey() {
    setSecret("");
    setShowSecret(false);
    setPasteMessage("");
  }
  function navigate(next: Screen) {
    generation.current++;
    locked.current = false;
    setBusy(false);
    setPolling(false);
    setLogin(null);
    setError("");
    clearKey();
    setScreen(next);
  }
  function choose(brand: Brand) {
    setLabel("");
    setRuntimeHostId("");
    navigate({ page: "setup", brand, method: "subscription" });
  }
  async function refresh(ticket: number) {
    try {
      await changed.current();
    } catch {
      if (current(ticket))
        setError(
          "Could not refresh your connections. Close and reopen this screen to try again.",
        );
    }
  }
  async function perform(work: (ticket: number) => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    const ticket = ++generation.current;
    setPollVersion(ticket);
    setBusy(true);
    setError("");
    try {
      await work(ticket);
    } catch (e) {
      if (current(ticket)) setError((e as Error).message);
    } finally {
      if (current(ticket)) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  function receive(value: Login, account: Account, ticket: number) {
    if (!current(ticket)) return false;
    setLogin(value);
    if (value.authenticated === true && value.authMode === "subscription") {
      setPolling(false);
      setError("");
      setScreen({ page: "connected", account });
      return true;
    }
    if (
      value.authenticated !== undefined ||
      value.state === "failed" ||
      value.state === "cancelled"
    ) {
      setPolling(false);
      setError(
        value.error ||
          (hostAccount(account.runtimeKind)
            ? `Sign in on the remote machine using ${account.brand === "claude" ? "claude auth login" : "codex login"}, then check the connection again.`
            : `Sign-in was not completed. Try signing in to ${providers[account.brand].name} again.`),
      );
      return true;
    }
    setPolling(true);
    return false;
  }
  async function start(account: Account, resume: boolean, ticket: number) {
    // Keep the provider with the request, before bootstrap can return the new row.
    setScreen({ page: "signin", account });
    setLogin(null);
    setPolling(false);
    try {
      const value = await subscriptionAction(account.id, resume ? "status" : "login");
      receive(value, account, ticket);
    } finally {
      // A workspace refresh must not keep a failed sign-in spinning or delay
      // its retry action after the provider request has already settled.
      void refresh(ticket);
    }
  }
  async function retrySignIn(account: Account, ticket: number) {
    setPolling(false);
    setLogin(null);
    // A lost response can leave the official login running. Resume it before
    // attempting another login, which the runtime would reject as busy.
    const value = await subscriptionAction(account.id, "status");
    if (!current(ticket)) return;
    if (
      value.authenticated === false ||
      (value.authenticated === true && value.authMode !== "subscription") ||
      value.state === "failed" ||
      value.state === "cancelled"
    )
      await start(account, false, ticket);
    else if (receive(value, account, ticket)) await refresh(ticket);
  }
  useEffect(() => {
    if (!signing || !polling) return;
    const ticket = generation.current;
    let live = true,
      pending = false;
    const timer = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await subscriptionAction(signing.id, "status");
        if (!live || !current(ticket)) return;
        if (receive(value, signing, ticket)) await refresh(ticket);
      } catch (e) {
        if (live && current(ticket)) {
          setError((e as Error).message);
          setPolling(false);
        }
      } finally {
        pending = false;
      }
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [signing?.id, polling, pollVersion]);

  async function pasteKey() {
    const ticket = generation.current;
    try {
      // Keep the read inside this user gesture for Safari's clipboard access.
      const text = (await navigator.clipboard.readText()).trim();
      if (!current(ticket)) return;
      if (!text) {
        setPasteMessage("Copy your API key first, then tap Paste.");
        return;
      }
      setSecret(text);
      setPasteMessage("Key pasted.");
    } catch {
      if (current(ticket))
        setPasteMessage(
          "Tap Show key, then touch and hold the field and choose Paste.",
        );
    }
  }
  function connect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!setup || !choice) return;
    void perform(async (ticket) => {
      const accountLabel =
        setup.account?.label ||
        label.trim() ||
        (setup.method === "subscription"
          ? choice.name
          : `${choice.company} API`);
      if (setup.method === "subscription") {
        const record = await callRoute(workspaceApi.subscriptionCreate, { body: {
          provider: choice.subscription,
          label: accountLabel,
          runtimeHostId: runtimeHostId || undefined,
        } }, executionSourceId());
        if (!current(ticket)) {
          await refresh(ticket);
          return;
        }
        await start(
          {
            id: record.id,
            brand: setup.brand,
            method: "subscription",
            label: accountLabel,
            status: "signing_in",
            runtimeHostId: runtimeHostId || undefined,
            runtimeKind:
              hosts.find((h) => h.id === runtimeHostId)?.kind || "broker",
          },
          false,
          ticket,
        );
      } else {
        const result = setup.account
          ? await callRoute(workspaceApi.connectionReconnect, { params: { id: setup.account.id }, body: { secret: secret.trim() } }, executionSourceId())
          : await callRoute(workspaceApi.connectionCreate, { body: { provider: choice.api, label: accountLabel, secret: secret.trim() } }, executionSourceId());
        if (!current(ticket)) {
          await refresh(ticket);
          return;
        }
        clearKey();
        setScreen({
          page: "connected",
          account: {
            id: setup.account?.id || ("id" in result ? result.id : ""),
            brand: setup.brand,
            method: "api",
            label: accountLabel,
            status: "connected",
          },
        });
        await refresh(ticket);
      }
    });
  }
  function code(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!signing) return;
    const form = e.currentTarget,
      value = new FormData(form).get("code");
    setPolling(false);
    void perform(async (ticket) => {
      try {
        await subscriptionAction(signing.id, "code", { code: value });
        if (!current(ticket)) return;
        form.reset();
        const result = await subscriptionAction(signing.id, "status");
        if (receive(result, signing, ticket)) await refresh(ticket);
      } catch (e) {
        if (current(ticket)) setPolling(true);
        throw e;
      }
    });
  }
  const back = (text: string, next: Screen) => (
    <button
      type="button"
      className="connection-back"
      disabled={busy}
      onClick={() => navigate(next)}
    >
      <ArrowLeft size={16} /> {text}
    </button>
  );
  return (
    <Sheet className="settings-sheet" title={title} titleRef={heading} onClose={onClose}>
      <div className="connections-flow">
        {screen.page === "accounts" && (
          <>
            <p className="settings-intro">Accounts Loop can use.</p>
            <div className="connection-accounts settings-list">
              {connections.map(accountFrom).map((account) => {
                const provider = providers[account.brand],
                  sub = account.method === "subscription",
                  status =
                    {
                      connected: "Connected",
                      signing_in: "Sign-in in progress",
                      needs_sign_in: "Sign-in needed",
                      needs_reconnect: "Reconnect needed",
                      disconnected: "Disconnected",
                    }[account.status] ||
                    account.status.replaceAll("_", " "),
                  machine = [
                    sub ? "Subscription" : `${provider.company} API`,
                    sub && account.plan ? account.plan : "",
                    sub
                      ? account.runtimeHostId
                        ? hosts.find((h) => h.id === account.runtimeHostId)
                            ?.name || "remote machine"
                        : "Loop server"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ");
                return (
                  <section
                    className="connection-account"
                    key={account.id}
                    aria-label={`${provider.name}: ${account.label}`}
                  >
                    <div className="connection-identity">
                      <ProviderMark brand={account.brand} />
                      <div>
                        <h3>{provider.name}</h3>
                        <p className="muted">{account.label}</p>
                      </div>
                      <span
                        className={
                          "settings-pill " +
                          (account.status === "connected"
                            ? "ready"
                            : account.status === "disconnected"
                              ? ""
                              : "attention")
                        }
                      >
                        {status}
                      </span>
                    </div>
                    {machine && (
                      <p className="connection-machine muted">{machine}</p>
                    )}
                    <div className="connection-account-actions">
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          if (sub)
                            void perform((ticket) =>
                              start(
                                account,
                                account.status === "signing_in",
                                ticket,
                              ),
                            );
                          else
                            navigate({
                              page: "setup",
                              brand: account.brand,
                              method: "api",
                              account,
                            });
                        }}
                      >
                        {account.status === "signing_in"
                          ? "Continue sign-in"
                          : hostAccount(account.runtimeKind)
                            ? "Check connection"
                            : sub
                              ? account.status === "connected"
                                ? "Reconnect"
                                : "Sign in"
                              : account.status === "connected"
                                ? "Update API key"
                                : "Reconnect"}
                      </button>
                      {account.status !== "disconnected" && (
                        <>
                          <button
                            className="text-button"
                            aria-label={`Refresh ${account.label}`}
                            disabled={busy}
                            onClick={() =>
                              perform(async (ticket) => {
                                try {
                                  if (sub) await subscriptionAction(account.id, "status");
                                  else await callRoute(workspaceApi.connectionRefresh, { params: { id: account.id }, body: {} }, executionSourceId());
                                } finally {
                                  await refresh(ticket);
                                }
                              })
                            }
                          >
                            <RefreshCw size={16} aria-hidden="true" />
                            Refresh
                          </button>
                          <button
                            className="text-button"
                            aria-label={`Disconnect ${account.label}`}
                            disabled={busy}
                            onClick={() =>
                              perform(async (ticket) => {
                                try {
                                  await callRoute(workspaceApi.connectionDisconnect, { params: { id: account.id }, body: {} }, executionSourceId());
                                } finally {
                                  await refresh(ticket);
                                }
                              })
                            }
                          >
                            <Unplug size={16} aria-hidden="true" />
                            Disconnect
                          </button>
                        </>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
            <button
              className="secondary connection-full"
              onClick={() => navigate({ page: "providers" })}
              disabled={busy}
            >
              <Plus size={17} /> Add a provider
            </button>
            <p className="field-hint">
              Secrets are encrypted on the server. Disconnecting never signs you
              out with the provider.
            </p>
          </>
        )}
        {screen.page === "providers" && (
          <>
            {connections.length > 0 &&
              back("Your connections", { page: "accounts" })}
            <p className="muted connection-intro">
              Connect a subscription or an API key. Choose the provider you want
              to use.
            </p>
            <div className="connection-providers">
              {(Object.keys(providers) as Brand[]).map((brand) => (
                <button
                  key={brand}
                  className="connection-provider"
                  aria-label={providers[brand].name}
                  onClick={() => choose(brand)}
                >
                  <ProviderMark brand={brand} />
                  <span>
                    <strong>{providers[brand].name}</strong>
                    <small>{providers[brand].company}</small>
                  </span>
                  <ChevronRight size={19} />
                </button>
              ))}
            </div>
            <p className="connection-footnote">
              You can connect both and choose an account for each agent.
            </p>
          </>
        )}
        {setup && choice && (
          <>
            {back(setup.account ? "Your connections" : "Change provider", {
              page: setup.account ? "accounts" : "providers",
            })}
            <form onSubmit={connect}>
              {setup.account ? (
                <p className="connection-intro muted">
                  Update the {choice.company} API key for{" "}
                  <strong>{setup.account.label}</strong>.
                </p>
              ) : (
                <fieldset className="connection-methods" disabled={busy}>
                  <legend>How would you like to connect?</legend>
                  <div>
                    {(["subscription", "api"] as const).map((method) => (
                      <label
                        key={method}
                        className={setup.method === method ? "selected" : ""}
                      >
                        <input
                          type="radio"
                          name="method"
                          aria-label={
                            method === "subscription"
                              ? "Subscription"
                              : "API key"
                          }
                          checked={setup.method === method}
                          onChange={() => {
                            navigate({ ...setup, method });
                          }}
                        />
                        <span>
                          <strong>
                            {method === "subscription"
                              ? "Subscription"
                              : "API key"}
                          </strong>
                          <small>
                            {method === "subscription"
                              ? `Your ${choice.name} plan`
                              : "Billed separately"}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <p className="connection-explainer muted">
                {setup.method === "subscription"
                  ? direct
                    ? `Use the ${choice.name} account already signed in on your remote machine, with its native tools and files. Agents using the same subscription account share a filesystem and can read or modify each other’s files. Your plan’s limits and extra-usage settings apply.`
                    : `Sign in with ${choice.name} through ${choice.runtime}. Each agent gets native coding tools and a workspace that keeps its files between runs. Agents using the same subscription account share a filesystem and can read or modify each other’s files. Your plan’s limits and extra-usage settings apply.`
                  : `${choice.company} API usage is billed separately from ${choice.name} subscriptions.`}
              </p>
              {setup.method === "subscription" && (
                <label>
                  Run on
                  <select
                    aria-label="Run on"
                    value={runtimeHostId}
                    onChange={(e) => setRuntimeHostId(e.target.value)}
                    disabled={busy}
                  >
                    <option value="">Loop server</option>
                    {hosts
                      .filter(
                        (host) =>
                          setup.brand === "chatgpt" ||
                          host.kind !== "codex-app-server",
                      )
                      .map((host) => (
                        <option key={host.id} value={host.id}>
                          {host.name}
                          {host.kind === "codex-app-server"
                            ? " · Codex app-server"
                            : ""}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => setAddingHost(true)}
                  >
                    <Plus size={16} /> Add a remote machine
                  </button>
                  {hostsError && (
                    <small role="alert">
                      Remote machines could not be loaded. Reopen this screen to
                      retry.
                    </small>
                  )}
                </label>
              )}
              {setup.method === "api" && (
                <div className="api-key-field">
                  <label htmlFor={secretId}>{choice.company} API key</label>
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
                      minLength={8}
                      maxLength={4096}
                      placeholder={`Paste your ${choice.company} key`}
                      aria-describedby={secretId + "-status"}
                      disabled={busy}
                    />
                    <button
                      type="button"
                      className="text-button"
                      aria-controls={secretId}
                      onClick={() => setShowSecret(!showSecret)}
                      disabled={busy}
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
                    <span
                      id={secretId + "-status"}
                      className="muted"
                      role="status"
                    >
                      {pasteMessage || "Encrypted and stored on the server."}
                    </span>
                  </div>
                </div>
              )}
              {!setup.account && (
                <details className="connection-options">
                  <summary>
                    Account name <span className="muted">Optional</span>
                  </summary>
                  <label>
                    Account name
                    <input
                      name="label"
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="e.g. Personal or Work"
                      maxLength={80}
                      disabled={busy}
                    />
                  </label>
                </details>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary" disabled={busy}>
                {busy && <LoaderCircle size={17} className="spin" />}
                {busy
                  ? "Connecting…"
                  : setup.method === "subscription"
                    ? direct
                      ? `Connect remote ${providers[setup.brand].name}`
                      : `Continue with ${choice.name}`
                    : setup.account
                      ? "Save API key"
                      : `Connect ${choice.name}`}
              </button>
            </form>
          </>
        )}
        {signing && (
          <>
            {back("Your connections", { page: "accounts" })}
            <div className="connection-identity connection-signin-identity">
              <ProviderMark brand={signing.brand} />
              <div>
                <strong>{providers[signing.brand].name} subscription</strong>
                <p className="muted">
                  {signing.label} ·{" "}
                  {signing.runtimeHostId
                    ? hosts.find((h) => h.id === signing.runtimeHostId)?.name ||
                      "Remote machine"
                    : "Loop server"}
                </p>
              </div>
            </div>
            {(polling || busy) &&
              (login?.login ? (
                <div className="connection-signin-steps">
                  <p>
                    Continue on {providers[signing.brand].name} to authorize
                    your account.
                  </p>
                  {login.login.code && (
                    <div className="connection-device-code">
                      <span>
                        Enter this code on {providers[signing.brand].name}
                      </span>
                      <strong>{login.login.code}</strong>
                    </div>
                  )}
                  <a
                    className="primary connection-full"
                    href={login.login.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open {providers[signing.brand].name} sign-in{" "}
                    <ArrowUpRight size={18} />
                  </a>
                  {login.login.acceptsCode && (
                    <form onSubmit={code}>
                      <label>
                        One-time sign-in code
                        <input
                          name="code"
                          autoComplete="off"
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          required
                          maxLength={4096}
                          placeholder={`Paste the code from ${providers[signing.brand].name}`}
                          disabled={busy}
                        />
                      </label>
                      <p className="connection-explainer muted">
                        After signing in, copy the code back here to finish
                        connecting.
                      </p>
                      <button disabled={busy} className="primary">
                        {busy ? "Checking…" : "Complete sign-in"}
                      </button>
                    </form>
                  )}
                  <p className="connection-waiting" role="status">
                    <LoaderCircle size={15} className="spin" /> Waiting for{" "}
                    {providers[signing.brand].name}…
                  </p>
                </div>
              ) : (
                <p className="connection-waiting" role="status">
                  <LoaderCircle size={17} className="spin" />
                  {hostAccount(signing.runtimeKind)
                    ? `Checking remote ${providers[signing.brand].name}…`
                    : `Opening ${providers[signing.brand].name} sign-in…`}
                </p>
              ))}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {!polling && !busy && (
              <button
                className="primary connection-full"
                onClick={() =>
                  perform((ticket) => retrySignIn(signing, ticket))
                }
              >
                {hostAccount(signing.runtimeKind)
                  ? "Check connection again"
                  : "Try sign-in again"}
              </button>
            )}
            <div className="connection-signin-footer">
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setPolling(false);
                  void perform(async (ticket) => {
                    try {
                      await subscriptionAction(signing.id, "cancel");
                      await refresh(ticket);
                      if (current(ticket)) navigate({ page: "accounts" });
                    } catch (e) {
                      if (current(ticket)) setPolling(true);
                      throw e;
                    }
                  });
                }}
              >
                {hostAccount(signing.runtimeKind)
                  ? "Back to connections"
                  : "Cancel sign-in"}
              </button>
              {polling && (
                <small className="muted">
                  {login?.expiresAt
                    ? `Expires at ${new Date(login.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. `
                    : ""}
                  You can close this and continue from Your connections.
                </small>
              )}
            </div>
          </>
        )}
        {screen.page === "connected" && (
          <div className="connection-success">
            <span className="connection-success-mark">
              <Check size={26} />
            </span>
            <p>
              <strong>{screen.account.label}</strong> is ready to use.
            </p>
            <p className="muted">
              Choose this account when creating an agent.
              {screen.account.method === "subscription"
                ? " Past conversations can be imported separately."
                : " API usage is billed separately."}
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary connection-full"
              onClick={onClose}
              disabled={busy}
            >
              Done
            </button>
            <button
              className="text-button"
              onClick={() => navigate({ page: "accounts" })}
              disabled={busy}
            >
              Your connections
            </button>
          </div>
        )}
        {(screen.page === "accounts" || screen.page === "providers") &&
          error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
      </div>
      {addingHost && (
        <RuntimeHosts
          initialKind={
            setup?.brand === "claude" ? "native-host" : "codex-app-server"
          }
          onClose={() => setAddingHost(false)}
          onAdded={(host) => {
            setHosts((previous) => [...previous, host]);
            setRuntimeHostId(host.id);
            setHostsError("");
            setAddingHost(false);
          }}
        />
      )}
    </Sheet>
  );
}

export function Connections(props: Parameters<typeof ServerConnections>[0]) {
  return capabilities.nativeHarnesses ? (
    <NativeConnections {...props} />
  ) : (
    <ServerConnections {...props} />
  );
}
