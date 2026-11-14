import { literalEntry, proseEntry } from "./textEntry";
import { workspaceApi } from "../shared/workspace-api";
import { useSourceRoute } from "./SourceContext";
import { ConnectionDetails } from "./ConnectionDetails";
import { RuntimeSetup } from "./RuntimeSetup";
import { useState } from "react";
import { parse } from "./json";
import { Sheet, Badge } from "./components";
import type { Connection } from "../shared/types";
export function NativeConnections({
  connections,
  onChange,
  onClose,
}: {
  connections: Connection[];
  onChange: () => Promise<void>;
  onClose: () => void;
}) {
  const route = useSourceRoute();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [apiForm, setApiForm] = useState(false);
  const [tab, setTab] = useState<"harnesses" | "api">("harnesses");
  return (
    <Sheet
      className="settings-sheet"
      title="Provider connections"
      onClose={onClose}
    >
      {connections.some((c) => c.status !== "connected") && (
        <section aria-label="Connections needing attention">
          <h3>Needs attention</h3>
          <p className="note">
            These saved connections are not marked connected. Refresh to check
            their current status, then open the relevant tab to reconnect.
          </p>
          {connections
            .filter((c) => c.status !== "connected")
            .map((connection) => {
              const harness = parse<{ loopHarness?: string }>(
                connection.metadata,
                {},
              ).loopHarness;
              return (
                <section key={connection.id} className="native-decision">
                  <h4>{connection.label}</h4>
                  <p>{connection.status.replaceAll("_", " ")}</p>
                  <button
                    type="button"
                    onClick={() => setTab(harness ? "harnesses" : "api")}
                  >
                    {harness ? "Open Harnesses" : "Open Loop runtime API"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await route(workspaceApi.connectionRefresh, {
                          params: { id: connection.id },
                          body: {},
                        });
                        await onChange();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Refresh {connection.label}
                  </button>
                </section>
              );
            })}
        </section>
      )}
      <div
        className="drawer-segmented"
        role="group"
        aria-label="Connection type"
      >
        <button
          type="button"
          aria-pressed={tab === "harnesses"}
          onClick={() => setTab("harnesses")}
        >
          Harnesses
        </button>
        <button
          type="button"
          aria-pressed={tab === "api"}
          onClick={() => setTab("api")}
        >
          Loop runtime API
        </button>
      </div>
      {tab === "harnesses" && (
        <RuntimeSetup onEnabled={onChange} connections={connections} />
      )}
      {tab === "api" && (
        <>
          <p className="settings-intro">
            Provider keys for Loop’s own agent runtime. API charges apply.
          </p>
          {connections
            .filter((c) => {
              const m = parse<{ loopHarness?: string }>(c.metadata, {});
              return !m.loopHarness;
            })
            .map((c) => (
              <section key={c.id} className="native-decision">
                <h3>{c.label}</h3>
                <Badge provider={c.provider} />
                <ConnectionDetails connection={c} />
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await route(workspaceApi.connectionRefresh, {
                        params: { id: c.id },
                        body: {},
                      });
                      await onChange();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Refresh account and models
                </button>
              </section>
            ))}
          <button className="text-button" onClick={() => setApiForm(!apiForm)}>
            Connect an API key for Loop's own agent runtime
          </button>
          {apiForm && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget,
                  data = new FormData(form);
                setBusy(true);
                setError("");
                try {
                  const provider = data.get("provider");
                  if (provider !== "openai" && provider !== "anthropic")
                    throw new Error("Select an API provider");
                  await route(workspaceApi.connectionCreate, {
                    body: {
                      provider,
                      label: String(data.get("label") || ""),
                      secret: String(data.get("secret") || ""),
                    },
                  });
                  form.reset();
                  setApiForm(false);
                  await onChange();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p className="note">
                This explicitly uses API billing and Loop's own agent runtime.
                It does not inherit a desktop harness session.
              </p>
              <label>
                Provider
                <select name="provider">
                  <option value="openai">OpenAI API</option>
                  <option value="anthropic">Anthropic API</option>
                </select>
              </label>
              <label>
                Label
                <input {...proseEntry} name="label" required maxLength={80} />
              </label>
              <label>
                API key
                <input
                  {...literalEntry}
                  type="password"
                  name="secret"
                  required
                />
              </label>
              <button className="primary" disabled={busy}>
                Connect API key
              </button>
            </form>
          )}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
