import {
  EnvironmentRuntimeCard,
  managedRuntimeName,
} from "./EnvironmentRuntimes";
import { useEffect, useState } from "react";
import { api, parse } from "./api";
import { RuntimeSignIn } from "./RuntimeSignIn";
import { Sheet } from "./components";
import type { Folder } from "../shared/types";

export function ExecutionEnvironments({
  folders,
  onClose,
  onChange,
  onLegacy,
}: {
  folders: Folder[];
  onClose: () => void;
  onChange: () => void;
  onLegacy: () => void;
}) {
  const [items, setItems] = useState<any[]>([]),
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
  const load = async () => {
    const rows = await api("/environments");
    setItems(rows);
    setSelected((s) => s || rows[0]?.id || "");
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    const t = setInterval(() => void load().catch(() => {}), 10000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let current = true;
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
  }, [selected]);
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
  return (
    <Sheet title="Execution environments" onClose={onClose}>
      <div className="native-settings">
        <p>
          Run Codex, Claude Code, OpenCode and Pi on your laptop or in Docker. Your
          conversations and uploaded files remain available when an environment
          is offline.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {!items.length && (
          <p>
            No managed execution environment is connected yet. Check runtime
            setup for preparation progress or direct fallback. To add Docker
            execution, start Loop with --execution both.
          </p>
        )}
        {items.length > 0 && (
          <label>
            Environment
            <select
              aria-label="Environment"
              disabled={busy}
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setSigningIn(false);
              }}
            >
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} · {i.state}
                </option>
              ))}
            </select>
          </label>
        )}
        {env && (
          <>
            <p>
              <strong>{env.name}</strong> · {env.state} · {env.instance_id}
              <br />
              <small>
                {env.last_seen
                  ? "Last checked " + new Date(env.last_seen).toLocaleString()
                  : "Awaiting authenticated Runner connection"}{" "}
                · Capacity {env.capacity} resident sessions
              </small>
            </p>
            <button
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
            <h3>Provider sign-in</h3>
            <p>
              Sign-in is saved in this execution environment. Codex and OpenCode
              require ChatGPT authentication; API fallback is disabled. Pi uses its
              existing provider billing and may incur API charges.
            </p>
            <label>
              Native runtime
              <select
                aria-label="Native runtime"
                disabled={busy}
                value={flavor}
                onChange={(e) => {
                  setFlavor(e.target.value);
                  setSigningIn(false);
                }}
              >
                <option value="codex">Codex · ChatGPT</option>
                <option value="claude">Claude Code · Claude</option>
                <option value="opencode">OpenCode · ChatGPT</option>
                <option value="pi">Pi · Existing billing</option>
              </select>
            </label>
            <button
              disabled={busy || env.state !== "online"}
              onClick={() => setSigningIn(true)}
            >
              Manage sign-in
            </button>
            {signingIn && (
              <RuntimeSignIn
                key={`${selected}:${env.generation}:${env.state}:${env.revoked_at}`}
                base={`/environments/${selected}/provider/${flavor}`}
                backend="environment"
                location={env.name}
                name={flavor}
                label={managedRuntimeName(flavor)}
                signedIn={false}
                enabled={false}
                enabling={busy}
                onStateChange={() => {}}
                onClose={() => setSigningIn(false)}
                enableAction={
                  <button
                    disabled={busy || env.state !== "online"}
                    onClick={() =>
                      void act(async () => {
                        await api(
                          `/environments/${selected}/provider/${flavor}/verify`,
                          {},
                        );
                        setNotice(
                          "Provider verified in this environment. Its connection is available when creating an agent.",
                        );
                        setSigningIn(false);
                        onChange();
                      })
                    }
                  >
                    Verify connection
                  </button>
                }
              />
            )}
            <h3>Project directories</h3>
            <p>
              Map an existing directory or explicitly clone a repository into
              this environment. Starting roots do not restrict every shell
              command.
            </p>
            {mappings.map((m) => (
              <p key={m.project_id}>
                {folders.find((f) => f.id === m.project_id)?.name}:{" "}
                <code>{m.canonical_path}</code>
              </p>
            ))}
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
            <details>
              <summary>Environment details</summary>
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
        <button onClick={onLegacy}>Existing runtime connections</button>
      </div>
    </Sheet>
  );
}
