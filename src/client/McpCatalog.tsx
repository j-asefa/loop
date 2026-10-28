import { useSourceRoute, useProjectionRoute } from "./SourceContext";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { parse } from "./api";
import { catalogResults } from "./catalogSearch";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
type CatalogEntry = RouteResponse<
  typeof workspaceApi.mcpCatalog
>["entries"][number];

const setupLabels = {
  none: "No credentials listed",
  oauth: "Sign in",
  bearer: "API key",
  query: "API key",
  env: "Account details",
  "oauth-app": "App setup",
};
export function McpCatalog({
  connections,
  hosts,
  onInstalled,
}: {
  connections: RouteResponse<typeof workspaceApi.mcpList>;
  hosts: { id: string; name: string }[];
  onInstalled: () => Promise<void>;
}) {
  const call = useSourceRoute(),
    read = useProjectionRoute();
  const [catalog, setCatalog] =
      useState<RouteResponse<typeof workspaceApi.mcpCatalog>>(),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState("All"),
    [noAccount, setNoAccount] = useState(false),
    [host, setHost] = useState(""),
    [expanded, setExpanded] = useState<string>(),
    [busy, setBusy] = useState<string>(),
    [loadError, setLoadError] = useState(""),
    [feedback, setFeedback] = useState<
      Record<string, { message: string; error: boolean }>
    >({});
  const installing = useRef(false);
  async function load() {
    setLoadError("");
    try {
      setCatalog(await read(workspaceApi.mcpCatalog, {}));
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function connection(entry: CatalogEntry) {
    return (
      connections.find(
        (c) => parse<any>(c.metadata, {}).catalogId === entry.id,
      ) ||
      connections.find(
        (c) =>
          entry.serverUrl &&
          c.url.replace(/\/$/, "") === entry.serverUrl.replace(/\/$/, "") &&
          c.status !== "disconnected",
      )
    );
  }
  async function install(
    entry: CatalogEntry,
    values: Record<string, string> = {},
  ) {
    if (installing.current) return;
    installing.current = true;
    setBusy(entry.id);
    setFeedback((f) => ({ ...f, [entry.id]: { message: "", error: false } }));
    try {
      const result = await call(workspaceApi.mcpCatalogInstall, {
        params: { id: entry.id },
        body: {
          values,
          runtimeHostId:
            entry.transport === "stdio" ? host || undefined : undefined,
        },
      });
      setExpanded(undefined);
      await onInstalled();
      if ("authorizationUrl" in result && result.authorizationUrl) {
        location.assign(result.authorizationUrl);
        return;
      }
      setFeedback((f) => ({
        ...f,
        [entry.id]: {
          message:
            "error" in result
              ? result.error
              : `Installed · ${result.tools} tools available to all agents.`,
          error: result.status !== "connected",
        },
      }));
    } catch (e) {
      setFeedback((f) => ({
        ...f,
        [entry.id]: { message: (e as Error).message, error: true },
      }));
    } finally {
      installing.current = false;
      setBusy(undefined);
    }
  }
  if (loadError)
    return (
      <div role="alert">
        <p className="error">{loadError}</p>
        <button onClick={() => void load()}>Retry loading catalog</button>
      </div>
    );
  if (!catalog) return <p role="status">Loading tool catalog…</p>;
  const categories = [
    "All",
    ...new Set(catalog.entries.map((e) => e.category)),
  ];
  const entries = catalogResults(catalog.entries, query, category, noAccount);
  return (
    <section aria-label="MCP catalog">
      <label className="catalog-search">
        <span className="sr-only">Search tools</span>
        <Search size={17} aria-hidden="true" />
        <input
          type="search"
          placeholder="GitHub, search, databases…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="catalog-options">
        <label className="catalog-category">
          <span className="sr-only">Category</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {categories.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="catalog-checkbox catalog-filter-chip">
          <input
            type="checkbox"
            checked={noAccount}
            onChange={(e) => setNoAccount(e.target.checked)}
          />
          No credentials listed
        </label>
      </div>
      {hosts.length > 0 && (
        <details className="mcp-import">
          <summary>Where to run command tools</summary>
          <label>
            Runtime machine
            <select value={host} onChange={(e) => setHost(e.target.value)}>
              <option value="">Loop server</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <p className="field-hint">
            Applies to new command tool installations. Hosted integrations run
            with their provider.
          </p>
        </details>
      )}
      <p className="field-hint" role="status">
        {entries.length} tools {query.trim() ? "found" : "available"}
      </p>
      {!entries.length && (
        <p>No matching tools. Try another search or category.</p>
      )}
      <div className="catalog-grid">
        {entries.map((entry) => {
          const existing = connection(entry),
            installed = existing?.status === "connected";
          const needsInputs =
            entry.inputs.length > 0 &&
            (!existing || existing.status === "disconnected");
          const message = feedback[entry.id];
          return (
            <article
              className="catalog-card"
              key={entry.id}
              aria-label={entry.name}
            >
              <div className="catalog-card-title">
                <div>
                  <h4>{entry.name}</h4>
                  <p className="field-hint">{entry.publisher}</p>
                </div>
                <span
                  className={
                    "catalog-badge" + (installed ? " catalog-badge-on" : "")
                  }
                >
                  {installed ? "Installed" : setupLabels[entry.auth]}
                </span>
              </div>
              <p className="catalog-card-description">{entry.description}</p>
              <details className="settings-details">
                <summary>Setup details</summary>
                {entry.note && <p className="field-hint">{entry.note}</p>}
                <a href={entry.source} target="_blank" rel="noreferrer">
                  Setup guide<span className="sr-only"> for {entry.name}</span>
                </a>
              </details>
              {message?.message && (
                <p
                  className={message.error ? "error" : "note"}
                  role={message.error ? "alert" : "status"}
                >
                  {message.message}
                </p>
              )}
              {expanded === entry.id ? (
                <form
                  key={entry.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const values = Object.fromEntries(
                      entry.inputs.map((input) => [
                        input.key,
                        String(new FormData(form).get(input.key) || ""),
                      ]),
                    );
                    void install(entry, values);
                    form.reset();
                  }}
                >
                  {entry.auth === "oauth-app" && (
                    <label>
                      OAuth callback URL
                      <input
                        readOnly
                        value={catalog.oauthRedirectUrl}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                    </label>
                  )}
                  {entry.inputs.map((input, i) => (
                    <label key={input.key}>
                      {input.label}
                      <input
                        name={input.key}
                        type={input.secret ? "password" : "text"}
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus={i === 0}
                        required
                        maxLength={10000}
                        disabled={!!busy}
                      />
                    </label>
                  ))}
                  <div className="actions">
                    <button className="primary" disabled={!!busy}>
                      {busy === entry.id ? "Connecting…" : "Install & connect"}
                    </button>
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => setExpanded(undefined)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className="actions catalog-install">
                  <button
                    className={installed ? "" : "secondary"}
                    aria-label={
                      installed
                        ? `${entry.name} installed`
                        : `Install ${entry.name}`
                    }
                    disabled={installed || !!busy}
                    onClick={() =>
                      needsInputs ? setExpanded(entry.id) : void install(entry)
                    }
                  >
                    {busy === entry.id
                      ? "Connecting…"
                      : installed
                        ? "Installed"
                        : existing?.status === "disabled"
                          ? "Enable"
                          : existing?.status === "needs_auth"
                            ? "Retry connection"
                            : "Install"}
                  </button>
                  {existing && entry.inputs.length > 0 && (
                    <button
                      disabled={!!busy}
                      onClick={() => setExpanded(entry.id)}
                    >
                      Edit setup
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
