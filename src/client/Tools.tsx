import { useEffect, useState } from "react";
import { api, parse } from "./api";
import { Sheet } from "./components";
import { McpCatalog } from "./McpCatalog";
export function Tools({
  onClose,
  initialView = "catalog",
}: {
  onClose: () => void;
  initialView?: "catalog" | "permissions";
}) {
  const [connections, setConnections] = useState<any[]>([]),
    [view, setView] = useState<string>(initialView),
    [query, setQuery] = useState(""),
    [catalog, setCatalog] = useState("datadog"),
    [editing, setEditing] = useState<string | null>(null),
    [name, setName] = useState("Datadog"),
    [url, setUrl] = useState("https://mcp.datadoghq.com/v1/mcp"),
    [authType, setAuthType] = useState("oauth"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [approvalMode, setApprovalMode] = useState<"ask" | "allow" | null>(
    null,
  );
  const [configJson, setConfigJson] = useState(""),
    [hosts, setHosts] = useState<any[]>([]),
    [host, setHost] = useState("");
  useEffect(() => {
    void api<any[]>("/runtime-hosts")
      .then((hosts) =>
        setHosts(hosts.filter((h) => !h.kind || h.kind === "broker")),
      )
      .catch((e) => setError(e.message));
  }, []);
  async function load() {
    const [connections, preferences] = await Promise.all([
      api<any[]>("/mcp"),
      api<{ approvalMode: "ask" | "allow" }>("/mcp/preferences"),
    ]);
    setConnections(connections);
    setApprovalMode(preferences.approvalMode);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function action(fn: () => Promise<void>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function test(id: string) {
    const result = await api("/mcp/" + id + "/test", {});
    if (result.authorizationUrl) location.assign(result.authorizationUrl);
    else setNotice("Connected. Available to all agents in your workspace.");
  }
  return (
    <Sheet wide title="Tools & integrations" onClose={onClose}>
      <p className="muted">
        Install once for your whole workspace. Connected MCPs are available to
        all your current and future agents.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}
      <div className="actions tools-views" role="group" aria-label="Tools view">
        <button
          aria-pressed={view === "catalog"}
          onClick={() => setView("catalog")}
        >
          Catalog
        </button>
        <button
          aria-pressed={view === "installed"}
          onClick={() => setView("installed")}
        >
          Installed (
          {connections.filter((c) => c.status !== "disconnected").length})
        </button>
        <button
          aria-pressed={view === "custom"}
          onClick={() => setView("custom")}
        >
          Custom
        </button>
        <button
          aria-pressed={view === "permissions"}
          onClick={() => setView("permissions")}
        >
          Permissions
        </button>
      </div>
      {view === "permissions" && (
        <section className="tool-approval-preferences">
          <label>
            Tool approvals
            <select
              aria-label="Tool approvals"
              value={approvalMode || "ask"}
              disabled={busy || !approvalMode}
              onChange={(e) => {
                const mode = e.target.value as "ask" | "allow";
                void action(async () => {
                  const result = await api(
                    "/mcp/preferences",
                    { approvalMode: mode },
                    "PUT",
                  );
                  setApprovalMode(result.approvalMode);
                  setNotice(
                    mode === "allow"
                      ? `Connected tools can run automatically.${result.resumed ? ` ${result.resumed} waiting ${result.resumed === 1 ? "task has" : "tasks have"} resumed.` : ""}`
                      : "New tool calls will ask for your approval.",
                  );
                });
              }}
            >
              <option value="ask">Ask every time</option>
              <option value="allow">Allow connected tools</option>
            </select>
          </label>
          <p className="field-hint">
            {approvalMode === "allow"
              ? "All your agents can use connected MCP tools without stopping for approval. Your GitHub connection also enables Git and gh for coding and reviews on the Loop server. Calls stay in the conversation history."
              : "Choose Allow connected tools to stop repeated approval prompts for all your agents and resume waiting tool calls."}
          </p>
          <p className="field-hint">
            Allow connected tools also gives managed coding agents your
            connected GitHub token in their shell environment, with its full
            permissions. Shell commands can read and transmit that token; output
            redaction does not prevent this. Enable it only for agents and
            content you trust. Agents using the same subscription account share
            a filesystem and can read or modify each other’s workspaces.
          </p>
          <p className="field-hint">
            Managed coding runs stop after 60 minutes without provider output,
            including during silent builds or CI waits. Saved partial work
            remains available to inspect before retrying.
          </p>
        </section>
      )}
      {view === "catalog" && (
        <McpCatalog
          connections={connections}
          hosts={hosts}
          onInstalled={load}
        />
      )}
      {view === "custom" && (
        <details className="mcp-import">
          <summary>Paste MCP JSON configuration</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const result = await api<any[]>("/mcp/install", {
                  config: configJson,
                  runtimeHostId: host || undefined,
                });
                setNotice(
                  result
                    .map(
                      (r) =>
                        r.name +
                        ": " +
                        (r.error || "connected · " + r.tools + " tools"),
                    )
                    .join("\n"),
                );
                if (result.every((r) => r.status === "connected"))
                  setConfigJson("");
              });
            }}
          >
            <label>
              MCP configuration
              <textarea
                aria-label="MCP configuration"
                rows={10}
                value={configJson}
                onChange={(e) => setConfigJson(e.target.value)}
                placeholder={
                  '{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } } }'
                }
                required
                spellCheck={false}
              />
            </label>
            <label>
              Run command servers on
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
              Supports command, args and env, or HTTPS url and headers. Command
              servers run in isolated containers. Connected tools are
              immediately available to all your agents.
            </p>
            <button className="primary" disabled={busy || !configJson.trim()}>
              {busy ? "Installing…" : "Install configuration"}
            </button>
          </form>
        </details>
      )}
      {view === "installed" && (
        <>
          {connections.length === 0 && (
            <p>
              No tools installed yet. Browse the catalog to connect your first
              integration.
            </p>
          )}
          <label>
            Find connections
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Datadog or server name"
            />
          </label>
          {connections
            .filter((c) =>
              (c.name + " " + c.url)
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((c) => (
              <section className="connection-card" key={c.id}>
                <h3>
                  {c.name} <small>{c.status.replaceAll("_", " ")}</small>
                </h3>
                <p className="field-hint">{c.url}</p>
                <p className="field-hint">
                  {c.status === "connected"
                    ? `Available to all agents · ${approvalMode === "allow" ? "Allowed automatically" : "Ask every time"}`
                    : "Unavailable to all agents until connected"}
                </p>
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() => action(() => test(c.id))}
                  >
                    Test / reconnect
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await api(
                          "/mcp/" + c.id,
                          {
                            action:
                              c.status === "disabled" ? "enable" : "disable",
                          },
                          "PATCH",
                        );
                      })
                    }
                  >
                    {c.status === "disabled" ? "Enable" : "Disable"}
                  </button>
                  <button
                    disabled={
                      parse<any>(c.metadata, {}).transport === "stdio" ||
                      c.authType === "query"
                    }
                    title={
                      c.authType === "query"
                        ? "Use Edit setup in Catalog to update this key"
                        : undefined
                    }
                    onClick={() => {
                      setView("custom");
                      setEditing(c.id);
                      setName(c.name);
                      setUrl(c.url);
                      setAuthType(c.authType);
                    }}
                  >
                    Replace credentials
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await api(
                          "/mcp/" + c.id,
                          { action: "disconnect" },
                          "PATCH",
                        );
                      })
                    }
                  >
                    Disconnect
                  </button>
                </div>
                <details>
                  <summary>
                    {parse<any[]>(c.tools, []).length} tools · resources &
                    prompts
                  </summary>
                  <pre className="code-artifact">
                    {JSON.stringify(
                      {
                        tools: parse(c.tools, []),
                        resources: parse<any>(c.metadata, {}).resources,
                        prompts: parse<any>(c.metadata, {}).prompts,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </section>
            ))}
        </>
      )}
      {view === "custom" && (
        <>
          <h3>{editing ? "Reconnect account" : "Add tools"}</h3>
          <div className="actions">
            <button
              onClick={() => {
                setEditing(null);
                setCatalog("datadog");
                setName("Datadog");
                setUrl("https://mcp.datadoghq.com/v1/mcp");
                setAuthType("oauth");
              }}
            >
              Datadog
            </button>
            <button
              onClick={() => {
                setEditing(null);
                setCatalog("custom");
                setName("");
                setUrl("");
                setAuthType("none");
              }}
            >
              Add server URL
            </button>
          </div>
          <p className="field-hint">
            {catalog === "datadog"
              ? "Published by Datadog. Query metrics, logs and services accessible to your account. A Datadog account is required. The default address is US1; use the endpoint for your region."
              : "Connect a public HTTPS server using Streamable HTTP. Only add publishers you trust. For command-based servers, paste MCP JSON above."}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action(async () => {
                const auth =
                  authType === "bearer"
                    ? { type: "bearer", token: f.get("token") }
                    : authType === "datadog"
                      ? {
                          type: "headers",
                          headers: {
                            DD_API_KEY: f.get("apiKey"),
                            DD_APPLICATION_KEY: f.get("appKey"),
                          },
                        }
                      : authType === "headers"
                        ? {
                            type: "headers",
                            headers: JSON.parse(String(f.get("headers"))),
                          }
                        : { type: authType };
                let c;
                if (editing) {
                  c = await api(
                    "/mcp/" + editing,
                    { action: "credentials", auth },
                    "PATCH",
                  );
                } else c = await api("/mcp", { name, url, auth });
                setEditing(null);
                await test(c.id);
                setView("installed");
              });
            }}
          >
            <label>
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={!!editing}
              />
            </label>
            <label>
              Server address
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                disabled={!!editing}
              />
            </label>
            <label>
              Authentication
              <select
                value={authType}
                onChange={(e) => setAuthType(e.target.value)}
              >
                <option value="oauth">Sign in with OAuth</option>
                <option value="bearer">Bearer token / PAT</option>
                <option value="datadog">Datadog API + application keys</option>
                <option value="headers">Custom authentication headers</option>
                <option value="none">No authentication</option>
              </select>
            </label>
            {authType === "bearer" && (
              <label>
                Token
                <input
                  type="password"
                  name="token"
                  required
                  autoComplete="off"
                />
              </label>
            )}
            {authType === "datadog" && (
              <>
                <label>
                  API key
                  <input
                    type="password"
                    name="apiKey"
                    required
                    autoComplete="off"
                  />
                </label>
                <label>
                  Application key
                  <input
                    type="password"
                    name="appKey"
                    required
                    autoComplete="off"
                  />
                </label>
              </>
            )}
            {authType === "headers" && (
              <label>
                Headers JSON
                <textarea
                  name="headers"
                  required
                  placeholder={'{"X-API-Key":"…"}'}
                />
              </label>
            )}
            <button className="primary" disabled={busy}>
              {busy ? "Connecting…" : "Connect & test"}
            </button>
          </form>
        </>
      )}
    </Sheet>
  );
}
