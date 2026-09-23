import { useEffect, useState } from "react";
import { api, parse } from "./api";
import { Sheet } from "./components";
import type { Agent } from "../shared/types";
export type ToolSelection = { connectionId: string; tools: string[] };
export function ToolPicker({
  value,
  onChange,
}: {
  value: ToolSelection[];
  onChange: (v: ToolSelection[]) => void;
}) {
  const [connections, setConnections] = useState<any[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    api<any[]>("/mcp")
      .then((c) => setConnections(c.filter((v) => v.status === "connected")))
      .catch((e) => setError(e.message));
  }, []);
  return (
    <fieldset>
      <legend>Available tools</legend>
      <p className="field-hint">
        Choose the tools this agent may request. Every call still needs your
        approval.
      </p>
      {error && <p className="error">{error}</p>}
      {!connections.length && (
        <p className="muted">
          Connect a server in Settings → Tools & integrations.
        </p>
      )}
      {connections.map((c) => (
        <details key={c.id}>
          <summary>{c.name}</summary>
          {parse<any[]>(c.tools, []).map((t) => (
            <label className="check-row" key={t.name}>
              <input
                type="checkbox"
                checked={
                  !!value
                    .find((v) => v.connectionId === c.id)
                    ?.tools.includes(t.name)
                }
                onChange={(e) => {
                  const selected =
                    value.find((v) => v.connectionId === c.id)?.tools || [];
                  onChange([
                    ...value.filter((v) => v.connectionId !== c.id),
                    {
                      connectionId: c.id,
                      tools: e.target.checked
                        ? [...selected, t.name]
                        : selected.filter((n) => n !== t.name),
                    },
                  ]);
                }}
              />
              <span>
                {t.name}
                <small>{String(t.description || "").slice(0, 130)}</small>
              </span>
            </label>
          ))}
        </details>
      ))}
    </fieldset>
  );
}
export function Tools({
  agents,
  onClose,
}: {
  agents: Agent[];
  onClose: () => void;
}) {
  const [connections, setConnections] = useState<any[]>([]),
    [query, setQuery] = useState(""),
    [catalog, setCatalog] = useState("datadog"),
    [editing, setEditing] = useState<string | null>(null),
    [name, setName] = useState("Datadog"),
    [url, setUrl] = useState("https://mcp.datadoghq.com/v1/mcp"),
    [authType, setAuthType] = useState("oauth"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [agent, setAgent] = useState(agents[0]?.id || ""),
    [grants, setGrants] = useState<ToolSelection[]>([]);
  async function load() {
    setConnections(await api("/mcp"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (agent)
      api<any[]>("/agents/" + agent + "/tools")
        .then((rows) => {
          const grouped: ToolSelection[] = [];
          for (const row of rows) {
            let g = grouped.find((v) => v.connectionId === row.connection_id);
            if (!g) {
              g = { connectionId: row.connection_id, tools: [] };
              grouped.push(g);
            }
            g.tools.push(row.tool);
          }
          setGrants(grouped);
        })
        .catch((e) => setError(e.message));
  }, [agent]);
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
    else setNotice("Connected. Select the tools and agents below.");
  }
  return (
    <Sheet wide title="Tools & integrations" onClose={onClose}>
      <p className="muted">
        Give an agent access to the services you use. Account permissions and
        Loop approvals both apply.
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
          (c.name + " " + c.url).toLowerCase().includes(query.toLowerCase()),
        )
        .map((c) => (
          <section className="connection-card" key={c.id}>
            <h3>
              {c.name} <small>{c.status.replaceAll("_", " ")}</small>
            </h3>
            <p className="field-hint">{c.url}</p>
            <div className="actions">
              <button disabled={busy} onClick={() => action(() => test(c.id))}>
                Test / reconnect
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api(
                      "/mcp/" + c.id,
                      {
                        action: c.status === "disabled" ? "enable" : "disable",
                      },
                      "PATCH",
                    );
                  })
                }
              >
                {c.status === "disabled" ? "Enable" : "Disable"}
              </button>
              <button
                onClick={() => {
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
                {parse<any[]>(c.tools, []).length} tools · resources & prompts
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
          : "Connect a public HTTPS server using Streamable HTTP. Only add publishers you trust. Local stdio servers need an isolated bridge."}
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
            <input type="password" name="token" required autoComplete="off" />
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
      <h3>Agent availability</h3>
      {agents.length ? (
        <>
          <label>
            Agent
            <select value={agent} onChange={(e) => setAgent(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.name}
                </option>
              ))}
            </select>
          </label>
          <ToolPicker
            key={connections.map((c) => c.id + c.status + c.tools).join("")}
            value={grants}
            onChange={setGrants}
          />
          <button
            disabled={busy}
            onClick={() =>
              action(async () => {
                await api("/agents/" + agent + "/tools", grants, "PUT");
                setNotice("Permissions saved for this agent.");
              })
            }
          >
            Save permissions
          </button>
        </>
      ) : (
        <p>
          Create an agent, then choose its tools here or in the creation sheet.
        </p>
      )}
    </Sheet>
  );
}
