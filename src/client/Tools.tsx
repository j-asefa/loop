import { literalEntry } from "./textEntry";
import { useSourceRoute, useProjectionRoute } from "./SourceContext";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { parse } from "./json";
import { Sheet } from "./components";
import { SettingsNote } from "./SettingsUI";
import { McpCatalog } from "./McpCatalog";
import {
  PERMISSION_MODES,
  type PermissionMode,
} from "../shared/permission-modes";
export function Tools({
  onClose,
  initialView = "catalog",
}: {
  onClose: () => void;
  initialView?: "catalog" | "permissions";
}) {
  const call = useSourceRoute(),
    readRoute = useProjectionRoute();
  const [connections, setConnections] = useState<
      RouteResponse<typeof workspaceApi.mcpList>
    >([]),
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
  const [agentMode, setAgentMode] = useState<PermissionMode | null>(null);
  const [configJson, setConfigJson] = useState("");
  const [nativeCandidates, setNativeCandidates] = useState<
    RouteResponse<typeof workspaceApi.mcpNativeCandidates>
  >([]);
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const [connectionsReady, setConnectionsReady] = useState(false);
  async function read(key: string, fn: () => Promise<void>) {
    try {
      await fn();
      setReadErrors((old) => ({ ...old, [key]: "" }));
    } catch (e) {
      setReadErrors((old) => ({ ...old, [key]: (e as Error).message }));
    }
  }
  async function loadConnections() {
    await read("tools", async () => {
      setConnections(await readRoute(workspaceApi.mcpList, {}));
      setConnectionsReady(true);
    });
  }
  async function loadPreferences() {
    await read("permissions", async () => {
      const preferences = await readRoute(workspaceApi.mcpPreferences, {});
      setApprovalMode(preferences.approvalMode);
      setAgentMode(preferences.agentPermissionMode);
    });
  }
  async function loadCandidates() {
    await read("imports", async () => {
      setNativeCandidates(
        await readRoute(workspaceApi.mcpNativeCandidates, {}),
      );
    });
  }
  async function load() {
    await Promise.all([loadConnections(), loadPreferences()]);
  }
  useEffect(() => {
    void load();
    void loadCandidates();
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
    const result = await call(workspaceApi.mcpTest, {
      params: { id },
      body: {},
    });
    if ("authorizationUrl" in result && result.authorizationUrl)
      location.assign(result.authorizationUrl);
    else setNotice("Connected. Available to all agents in your workspace.");
  }
  return (
    <Sheet
      wide
      className="settings-sheet"
      title="Tools & integrations"
      onClose={onClose}
    >
      <p className="settings-intro">
        Shared tools for your workspace’s agents.
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
          {connectionsReady
            ? connections.filter((c) => c.status !== "disconnected").length
            : "…"}
          )
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
      {(
        [
          [
            "tools",
            "Installed tools",
            ["catalog", "installed"],
            loadConnections,
          ],
          ["permissions", "Permissions", ["permissions"], loadPreferences],
          ["imports", "Harness integrations", ["installed"], loadCandidates],
        ] as const
      ).map(
        ([key, label, views, retry]) =>
          readErrors[key] &&
          (views as readonly string[]).includes(view) && (
            <div className="settings-error" role="alert" key={key}>
              <strong>{label} couldn’t be refreshed</strong>
              <p>{readErrors[key]}</p>
              <button
                type="button"
                className="secondary"
                onClick={() => void retry()}
              >
                Retry {label.toLowerCase()}
              </button>
            </div>
          ),
      )}
      {view === "permissions" && (
        <section className="tool-approval-preferences">
          <label>
            Agent tool calls
            <select
              aria-label="Agent tool calls"
              value={agentMode || "default"}
              disabled={busy || !agentMode}
              onChange={(e) => {
                const mode = e.target.value as PermissionMode;
                void action(async () => {
                  const result = await call(workspaceApi.mcpPreferencesUpdate, {
                    body: { agentPermissionMode: mode },
                  });
                  setAgentMode(result.agentPermissionMode);
                  setNotice(
                    "Agents use this from their next turn. Requests already waiting still need a decision.",
                  );
                });
              }}
            >
              {PERMISSION_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
          <p className="field-hint">
            {
              PERMISSION_MODES.find(
                (mode) => mode.value === (agentMode || "default"),
              )!.description
            }{" "}
            Questions always wait for your answer.
          </p>
          <label>
            Connected MCP tools
            <select
              aria-label="Tool approvals"
              value={approvalMode || "ask"}
              disabled={busy || !approvalMode}
              onChange={(e) => {
                const mode = e.target.value as "ask" | "allow";
                void action(async () => {
                  const result = await call(workspaceApi.mcpPreferencesUpdate, {
                    body: { approvalMode: mode },
                  });
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
              ? "Connected tools can run automatically. Connected GitHub tools still ask before merging. Calls stay in conversation history."
              : "Ask before each connected tool call. Allowing tools also resumes waiting MCP requests."}
          </p>
          <SettingsNote
            icon={TriangleAlert}
            tone="attention"
            title="Connected GitHub tools always ask before merging"
          >
            That approval cannot be turned off for connected tool calls,
            whatever you choose above. Shell commands are a separate path: an
            agent that can run them holds your connected GitHub token and can
            merge with it, without asking.
          </SettingsNote>
          <details className="settings-details">
            <summary>What allowing tools gives an agent</summary>
            <p className="field-hint">
              Allow connected tools also gives managed coding agents your
              connected GitHub token in their shell environment, with its full
              permissions. Shell commands can read and transmit that token, and
              can call GitHub with it directly, including merging a pull
              request, without passing through the approval above; output
              redaction does not prevent this. Enable it only for agents and
              content you trust. Agents using the same subscription account
              share a filesystem and can read or modify each other’s workspaces.
            </p>
          </details>
          <details className="settings-details">
            <summary>Run limits</summary>
            <p className="field-hint">
              Managed coding runs stop after 60 minutes without provider output,
              including during silent builds or CI waits. Saved partial work
              remains available to inspect before retrying.
            </p>
          </details>
        </section>
      )}
      {view === "catalog" && (
        <McpCatalog connections={connections} onInstalled={load} />
      )}
      {view === "installed" && nativeCandidates.length > 0 && (
        <section className="tool-sharing">
          <h3>Import from installed harnesses</h3>
          <p className="field-hint">
            Choose a server to make it available to all Loop agents. Its
            configuration is read on this source; credentials stay on this
            backend and are never sent to your browser.
          </p>
          {nativeCandidates.map((candidate) => (
            <div className="tool-sharing-source" key={candidate.id}>
              <span>
                {candidate.provider} · {candidate.name}
              </span>
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const result = await call(workspaceApi.mcpNativeImport, {
                      params: { id: candidate.id },
                      body: {},
                    });
                    setNotice(
                      result[0]?.status === "connected"
                        ? `${candidate.name} is available to Loop agents.`
                        : `${candidate.name} was saved. Test or reconnect it in Installed tools.`,
                    );
                  })
                }
              >
                Import
              </button>
            </div>
          ))}
        </section>
      )}
      {view === "custom" && (
        <details className="mcp-import">
          <summary>Paste MCP JSON configuration</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const result = await call(workspaceApi.mcpInstall, {
                  body: { config: configJson },
                });
                setNotice(
                  result
                    .map(
                      (r) =>
                        r.name +
                        ": " +
                        ("error" in r
                          ? r.error
                          : "connected · " + r.tools + " tools"),
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
                {...literalEntry}
                aria-label="MCP configuration"
                rows={10}
                value={configJson}
                onChange={(e) => setConfigJson(e.target.value)}
                placeholder={
                  '{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } } }'
                }
                required
              />
            </label>
            <p className="field-hint">
              Supports command, args and env, or HTTPS url and headers. Command
              servers run on this computer. Connected tools are immediately
              available to all your agents.
            </p>
            <button className="primary" disabled={busy || !configJson.trim()}>
              {busy ? "Installing…" : "Install configuration"}
            </button>
          </form>
        </details>
      )}
      {view === "installed" && (
        <>
          {connectionsReady && connections.length === 0 && (
            <p>
              No tools installed yet. Browse the catalog to connect your first
              integration.
            </p>
          )}
          <label>
            Find connections
            <input
              {...literalEntry}
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
              <section className="connection-card settings-card" key={c.id}>
                <h3>
                  {c.name} <small>{c.status.replaceAll("_", " ")}</small>
                </h3>
                <details className="settings-details">
                  <summary>Manage {c.name}</summary>
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
                          await call(workspaceApi.mcpUpdate, {
                            params: { id: c.id },
                            body: {
                              action:
                                c.status === "disabled" ? "enable" : "disable",
                            },
                          });
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
                          await call(workspaceApi.mcpUpdate, {
                            params: { id: c.id },
                            body: { action: "disconnect" },
                          });
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
                const auth = workspaceApi.mcpCreate.body.shape.auth.parse(
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
                        : { type: authType },
                );
                let c;
                if (editing) {
                  c = await call(workspaceApi.mcpUpdate, {
                    params: { id: editing },
                    body: { action: "credentials", auth },
                  });
                } else
                  c = await call(workspaceApi.mcpCreate, {
                    body: { name, url, auth },
                  });
                setEditing(null);
                await test(c.id);
                setView("installed");
              });
            }}
          >
            <label>
              Name
              <input
                {...literalEntry}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={!!editing}
              />
            </label>
            <label>
              Server address
              <input
                {...literalEntry}
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
                  {...literalEntry}
                  type="password"
                  name="token"
                  required
                />
              </label>
            )}
            {authType === "datadog" && (
              <>
                <label>
                  API key
                  <input
                    {...literalEntry}
                    type="password"
                    name="apiKey"
                    required
                  />
                </label>
                <label>
                  Application key
                  <input
                    {...literalEntry}
                    type="password"
                    name="appKey"
                    required
                  />
                </label>
              </>
            )}
            {authType === "headers" && (
              <label>
                Headers JSON
                <textarea
                  {...literalEntry}
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
