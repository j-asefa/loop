import {
  EnvironmentRuntimeCard,
  managedRuntimeName,
} from "./EnvironmentRuntimes";
import { useEffect, useRef, useState } from "react";
import { Box, Monitor, TriangleAlert } from "lucide-react";
import { api, parse } from "./api";
import { RuntimeSignIn } from "./RuntimeSignIn";
import { Sheet } from "./components";
import { capabilities } from "./capabilities";
import { SettingsEmpty, SettingsList, SettingsRow } from "./SettingsUI";
import type { Folder } from "../shared/types";
import type { Connection } from "../shared/types";

const runtimes = [
  { flavor: "codex", label: "Codex · ChatGPT" },
  { flavor: "claude", label: "Claude Code · Claude" },
  { flavor: "opencode", label: "OpenCode · ChatGPT" },
  { flavor: "pi", label: "Pi · Existing billing" },
] as const;

export function ExecutionEnvironments({
  folders,
  connections,
  initialEnvironmentId = "",
  onClose,
  onChange,
  onLegacy,
}: {
  folders: Folder[];
  connections: Connection[];
  initialEnvironmentId?: string;
  onClose: () => void;
  onChange: () => Promise<void>;
  onLegacy: () => void;
}) {
  const [items, setItems] = useState<any[]>([]),
    [help, setHelp] = useState(""),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [flavor, setFlavor] = useState("codex"),
    [signingIn, setSigningIn] = useState(false),
    [project, setProject] = useState(""),
    [path, setPath] = useState(""),
    [repository, setRepository] = useState(""),
    [mappings, setMappings] = useState<any[]>([]);
  const loadRevision = useRef(0);
  const generation = items.find((item) => item.id === selected)?.generation;
  const load = async () => {
    const revision = ++loadRevision.current;
    const rows = await api("/environments");
    if (revision !== loadRevision.current) return;
    setItems(rows);
    setSelected(
      (s) =>
        s ||
        rows.find((row: any) => row.id === initialEnvironmentId)?.id ||
        rows[0]?.id ||
        "",
    );
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    const t = setInterval(() => void load().catch(() => {}), 10000);
    return () => {
      loadRevision.current++;
      clearInterval(t);
    };
  }, []);
  // Messages belong to the chosen environment; a runner reconnect (new
  // generation) reloads its mappings but keeps an unverified result visible.
  useEffect(() => {
    setError("");
    setNotice("");
  }, [selected]);
  useEffect(() => {
    let current = true;
    setMappings([]);
    if (selected) {
      void api("/environments/" + selected + "/projects")
        .then((value) => {
          if (current) setMappings(value);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    }
    return () => {
      current = false;
    };
  }, [selected, generation]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const env = items.find((i) => i.id === selected),
    health = parse<any>(env?.health, {});
  const connected = (runtime: string) =>
    connections.some((connection) => {
      const metadata = parse<any>(connection.metadata, {});
      return (
        connection.status === "connected" &&
        metadata.backend === "hapi" &&
        metadata.environmentId === selected &&
        metadata.flavor === runtime
      );
    });
  async function verifySelected() {
    await act(async () => {
      await api(`/environments/${selected}/provider/${flavor}/verify`, {});
      setNotice(
        `${managedRuntimeName(flavor)} is ready on ${env.name}. Choose ${env.name} under Run on when creating an agent.`,
      );
      setSigningIn(false);
      await onChange();
    });
  }
  return (
    <Sheet
      className="settings-sheet"
      title="Execution environments"
      onClose={onClose}
    >
      <div className="native-settings">
        <p className="settings-intro">Choose where your agents run.</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {!items.length && (
          <>
            <SettingsEmpty icon={Monitor} title="No environment connected yet">
              Connect a HAPI environment to run harness agents.
            </SettingsEmpty>
            <SettingsList>
              <SettingsRow
                icon={Box}
                title="Add Docker execution"
                description="Start Loop with --execution both"
                onClick={() => setHelp(help === "docker" ? "" : "docker")}
              />
              <SettingsRow
                icon={TriangleAlert}
                title="Environment not appearing?"
                description="Check runtime setup for progress or setup errors"
                onClick={() => setHelp(help === "setup" ? "" : "setup")}
              />
            </SettingsList>
            {help === "docker" && (
              <div className="settings-card">
                <p className="field-hint">
                  Restart Loop with <code>--execution both</code> to run agents
                  in Docker alongside the Loop server.
                </p>
              </div>
            )}
            {help === "setup" && (
              <div className="settings-card">
                <p className="field-hint">
                  A managed environment appears here once its Runner connects
                  and authenticates. Until then, check runtime setup for
                  HAPI preparation progress or setup errors.
                </p>
              </div>
            )}
          </>
        )}
        {items.length > 0 && (
          <div
            className="environment-picker"
            role="group"
            aria-label="Execution environment"
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={selected === item.id}
                className={selected === item.id ? "selected" : ""}
                disabled={busy}
                onClick={() => {
                  setSelected(item.id);
                  setSigningIn(false);
                }}
              >
                <strong>{item.name}</strong>
                <small>{item.state}</small>
              </button>
            ))}
          </div>
        )}
        {env && (
          <>
            <div className="settings-card">
              <strong>{env.name}</strong>
              <p>
                {env.state} · Accounts and project paths belong to this
                environment.
              </p>
            </div>
            <h3>Provider connections</h3>
            <div className="environment-provider-list">
              {runtimes.map((runtime) => (
                <div className="environment-provider" key={runtime.flavor}>
                  <div>
                    <strong>{runtime.label}</strong>
                    <small>
                      {connected(runtime.flavor)
                        ? env.state === "online"
                          ? "Connected"
                          : "Saved · environment offline"
                        : "Not connected"}
                    </small>
                  </div>
                  <button
                    type="button"
                    disabled={
                      busy || env.state !== "online" || !!env.revoked_at
                    }
                    onClick={() => {
                      setFlavor(runtime.flavor);
                      setSigningIn(true);
                    }}
                  >
                    {connected(runtime.flavor) ? "Manage" : "Connect"}
                  </button>
                </div>
              ))}
            </div>
            {signingIn && (
              <Sheet
                className="settings-sheet"
                title={managedRuntimeName(flavor)}
                onClose={() => setSigningIn(false)}
              >
                <RuntimeSignIn
                  key={`${selected}:${flavor}:${env.generation}:${env.state}:${env.revoked_at}`}
                  base={`/environments/${selected}/provider/${flavor}`}
                  backend="environment"
                  location={env.name}
                  name={flavor}
                  label={managedRuntimeName(flavor)}
                  signedIn={connected(flavor)}
                  enabled={
                    connected(flavor) &&
                    env.state === "online" &&
                    !env.revoked_at
                  }
                  enabling={busy}
                  onStateChange={(_name, state) => {
                    if (state === "starting" || state === "waiting")
                      setError("");
                  }}
                  onClose={() => setSigningIn(false)}
                  enableAction={
                    <>
                      <button
                        type="button"
                        className="btn primary"
                        disabled={busy || env.state !== "online"}
                        onClick={() => void verifySelected()}
                      >
                        {busy ? "Connecting…" : "Use in Loop"}
                      </button>
                      {error && (
                        <div className="settings-error" role="alert">
                          <strong>Connection not verified</strong>
                          <p>{error}</p>
                        </div>
                      )}
                    </>
                  }
                />
              </Sheet>
            )}
            <h3>Project directories</h3>
            {mappings.map((m) => (
              <p className="settings-card" key={m.project_id}>
                {folders.find((f) => f.id === m.project_id)?.name}:{" "}
                <code>{m.canonical_path}</code>
              </p>
            ))}
            <details className="settings-details">
              <summary>Map or clone a project</summary>
              <p className="field-hint">
                Choose an existing directory or explicitly clone a repository
                here. Project roots do not restrict shell access.
              </p>
              <label>
                Project
                <select
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                >
                  <option value="">Choose a project</option>
                  {folders
                    .filter((f) => f.kind === "project")
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Existing directory
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/workspaces/my-project"
                />
              </label>
              <button
                disabled={busy || !project || !path || env.state !== "online"}
                onClick={() =>
                  void act(async () => {
                    await api(
                      "/environments/" + selected + "/projects",
                      { projectId: project, path },
                      "PUT",
                    );
                    setMappings(
                      await api("/environments/" + selected + "/projects"),
                    );
                  })
                }
              >
                Map directory
              </button>
              <label>
                Repository HTTPS URL
                <input
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                  placeholder="https://github.com/owner/repository.git"
                />
              </label>
              <button
                disabled={
                  busy || !project || !repository || env.state !== "online"
                }
                onClick={() =>
                  void act(async () => {
                    await api("/environments/" + selected + "/projects/clone", {
                      projectId: project,
                      repository,
                      directory: project,
                    });
                    setMappings(
                      await api("/environments/" + selected + "/projects"),
                    );
                  })
                }
              >
                Clone into this environment
              </button>
            </details>
            <details className="settings-details">
              <summary>Environment details</summary>
              <p>
                Instance: <code>{env.instance_id}</code>
              </p>
              <p className="field-hint">
                {env.last_seen
                  ? "Last checked " + new Date(env.last_seen).toLocaleString()
                  : "Awaiting authenticated Runner connection"}{" "}
                · Capacity {env.capacity} resident sessions
              </p>
              <button
                type="button"
                disabled={busy || !!env.revoked_at}
                onClick={() =>
                  void act(async () => {
                    await api("/environments/" + selected + "/refresh", {});
                  })
                }
              >
                Refresh environment
              </button>
              <EnvironmentRuntimeCard environment={env} />
              <pre>{JSON.stringify(health.versions || {}, null, 2)}</pre>
              <p>
                Revocation immediately blocks further access. A partitioned
                process may continue until its stop is acknowledged.
              </p>
              <button
                disabled={busy || !!env.revoked_at}
                onClick={() =>
                  void act(async () => {
                    await api("/environments/" + selected + "/revoke", {});
                    setNotice(
                      "Environment revoked. Any in-flight stop remains pending native confirmation.",
                    );
                  })
                }
              >
                Revoke environment
              </button>
            </details>
          </>
        )}
        {capabilities.runtimeHosts && (
          <button className="secondary" onClick={onLegacy}>
            Existing runtime connections
          </button>
        )}
      </div>
    </Sheet>
  );
}
