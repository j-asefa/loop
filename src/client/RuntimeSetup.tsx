import { useEffect, useState } from "react";
import { api } from "./api";

type Runtime = {
  name: string;
  installed: boolean;
  available: boolean;
  enabled: boolean;
  version?: string;
  help: string;
  authentication: string;
  billing?: string;
  project?: string;
};
type Discovery = { computer: string; online: boolean; runtimes: Runtime[] };
const labels: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi",
  opencode: "OpenCode",
};
export function RuntimeSetup({
  onEnabled,
}: {
  onEnabled: (name: string) => Promise<void>;
}) {
  const [discovery, setDiscovery] = useState<Discovery>();
  const [projects, setProjects] = useState<
    { folder_id: string; path: string }[]
  >([]);
  const [project, setProject] = useState("");
  const [billing, setBilling] = useState("subscription");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    const [host, workspace] = await Promise.all([
      api<Discovery>("/workspace/runtimes"),
      api<{ projectPaths: { folder_id: string; path: string }[] }>(
        "/workspace",
      ),
    ]);
    setDiscovery(host);
    setProjects(workspace.projectPaths);
    setProject(
      (current) => current || workspace.projectPaths[0]?.folder_id || "",
    );
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  return (
    <section className="native-decision" aria-label="Runtime setup">
      <h3>
        {discovery
          ? `Computer: ${discovery.computer} · ${discovery.online ? "online" : "offline"}`
          : "Checking this computer…"}
      </h3>
      <p>
        Choose an installed runtime. Sign in with its CLI on this computer
        first. Authentication is checked when enabling; pairing does not install
        or sign in to agents.
      </p>
      <label>
        Project directory for new runtimes
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          disabled={busy}
        >
          {projects.map((p) => (
            <option key={p.folder_id} value={p.folder_id}>
              {p.path}
            </option>
          ))}
        </select>
      </label>
      {!projects.length && (
        <p>Add a desktop directory in Projects before enabling a runtime.</p>
      )}
      <label>
        Billing policy for new runtimes
        <select
          value={billing}
          onChange={(e) => setBilling(e.target.value)}
          disabled={busy}
        >
          <option value="subscription">
            Require verified native subscription
          </option>
          <option value="existing">
            Use existing native configuration (may incur API charges)
          </option>
        </select>
      </label>
      <p className="note">
        No automatic billing fallback. Claude and OpenCode may require
        explicitly choosing existing configuration. Enabled runtimes keep their
        saved billing policy.
      </p>
      {discovery?.runtimes.map((runtime) => (
        <div key={runtime.name}>
          <strong>{labels[runtime.name]}</strong> —{" "}
          {runtime.enabled
            ? "enabled"
            : runtime.available
              ? "installed; authentication unknown"
              : runtime.installed
                ? "unavailable"
                : "not installed"}
          {!runtime.available && <p>{runtime.help}</p>}
          {runtime.enabled && (
            <p className="note">
              Bound project: {runtime.project || "unknown"}. Billing:{" "}
              {runtime.billing || "unknown"}.
            </p>
          )}
          <button
            type="button"
            disabled={
              busy ||
              !project ||
              !runtime.available ||
              !discovery.online ||
              (runtime.enabled &&
                !projects.some((p) => p.path === runtime.project))
            }
            onClick={async () => {
              setBusy(true);
              setError("");
              let enabled = false;
              try {
                const projectId = runtime.enabled
                  ? projects.find((p) => p.path === runtime.project)?.folder_id
                  : project;
                await api(`/workspace/runtimes/${runtime.name}/enable`, {
                  projectId,
                  billing: runtime.billing || billing,
                });
                enabled = true;
                const results = await Promise.allSettled([
                  onEnabled(runtime.name),
                  refresh(),
                ]);
                if (results.some((result) => result.status === "rejected"))
                  setError(
                    "Runtime enabled, but the screen could not refresh. Check installed runtimes again.",
                  );
              } catch (e) {
                if (!enabled) setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {runtime.enabled ? "Refresh" : "Enable"} {labels[runtime.name]}
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setError("");
          void refresh().catch((e) => setError(e.message));
        }}
      >
        Check installed runtimes again
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
