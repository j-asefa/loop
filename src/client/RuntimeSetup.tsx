import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { RuntimeSignIn } from "./RuntimeSignIn";
import type { NativeAuthView, SignIn } from "../shared/native-auth";

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
  const [enabling, setEnabling] = useState<string>();
  const busy = !!enabling;
  const [error, setError] = useState("");
  const [enableError, setEnableError] = useState<{
    name: string;
    message: string;
  }>();
  const [signingIn, setSigningIn] = useState<string>();
  const [authStates, setAuthStates] = useState<
    Record<string, SignIn["state"] | undefined>
  >({});
  const authRevision = useRef(0);
  const onAuthState = useCallback(
    (name: string, state: SignIn["state"] | undefined) => {
      authRevision.current++;
      setAuthStates((current) => ({ ...current, [name]: state }));
    },
    [],
  );
  async function refresh() {
    const revision = authRevision.current;
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
    // Read existing attempts without starting a harness or another sign-in.
    const states = await Promise.allSettled(
      host.runtimes.map(async (runtime) => {
        const auth = await api<NativeAuthView>(
          `/workspace/runtimes/${runtime.name}/auth/status`,
        );
        return [runtime.name, auth.attempt?.state] as const;
      }),
    );
    // A sign-in response received during discovery is newer than this snapshot.
    if (revision === authRevision.current)
      setAuthStates((current) => ({
        ...current,
        ...Object.fromEntries(
          states.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          ),
        ),
      }));
  }
  async function enable(runtime: Runtime) {
    setEnabling(runtime.name);
    setEnableError(undefined);
    setError("");
    try {
      const projectId = runtime.enabled
        ? projects.find((p) => p.path === runtime.project)?.folder_id
        : project;
      await api(`/workspace/runtimes/${runtime.name}/enable`, {
        projectId,
        billing: runtime.billing || billing,
      });
      setSigningIn(undefined);
      const results = await Promise.allSettled([
        onEnabled(runtime.name),
        refresh(),
      ]);
      if (results.some((result) => result.status === "rejected"))
        setError(
          "Runtime enabled, but the screen could not refresh. Check installed runtimes again.",
        );
    } catch (e) {
      setEnableError({ name: runtime.name, message: (e as Error).message });
    } finally {
      setEnabling(undefined);
    }
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  const authInProgress = Object.values(authStates).some(
    (state) => state === "starting" || state === "waiting",
  );
  useEffect(() => {
    if (!authInProgress) return;
    const timer = setInterval(() => {
      void Promise.allSettled(
        Object.entries(authStates)
          .filter(([, state]) => state === "starting" || state === "waiting")
          .map(async ([name]) => {
            const view = await api<NativeAuthView>(
              `/workspace/runtimes/${name}/auth/status`,
            );
            onAuthState(name, view.attempt?.state);
          }),
      );
    }, 1200);
    return () => clearInterval(timer);
  }, [authInProgress, authStates, onAuthState]);
  return (
    <section className="native-decision" aria-label="Runtime setup">
      <h3>
        {discovery
          ? `Computer: ${discovery.computer} · ${discovery.online ? "online" : "offline"}`
          : "Checking this computer…"}
      </h3>
      <p>
        Use the accounts already on this computer, or sign in below. Enable a
        harness to make its models available in Loop.
      </p>
      <label>
        Project directory for new runtimes
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          disabled={busy || !!signingIn || authInProgress}
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
        No automatic billing fallback. OpenCode and API accounts require
        explicitly choosing existing configuration. Enabled runtimes keep their
        saved billing policy.
      </p>
      {discovery?.runtimes.map((runtime) => {
        const label = labels[runtime.name];
        const open = signingIn === runtime.name;
        const signedIn = authStates[runtime.name] === "complete";
        const authenticating = ["starting", "waiting"].includes(
          authStates[runtime.name] || "",
        );
        const projectId = runtime.enabled
          ? projects.find((p) => p.path === runtime.project)?.folder_id
          : project;
        const enableAction = (
          <>
            <button
              type="button"
              className="btn primary"
              disabled={
                busy ||
                (!!signingIn && !open) ||
                (open && !signedIn) ||
                authenticating ||
                !projectId ||
                !runtime.available ||
                !discovery.online
              }
              onClick={() => void enable(runtime)}
            >
              {enabling === runtime.name
                ? runtime.enabled
                  ? "Refreshing…"
                  : "Enabling…"
                : `${runtime.enabled ? "Refresh" : "Enable"} ${label}`}
            </button>
            {enableError?.name === runtime.name && (
              <p className="error" role="alert">
                {enableError.message}
              </p>
            )}
          </>
        );
        return (
          <div key={runtime.name} className="native-runtime">
            <p className="native-runtime-title">
              <strong>{label}</strong>
              <span
                className={`native-runtime-state${signedIn || runtime.enabled ? " connected" : ""}`}
              >
                {authenticating
                  ? "Signing in…"
                  : runtime.enabled
                    ? "Enabled in Loop"
                    : signedIn
                      ? "Signed in"
                      : runtime.available
                        ? "Installed"
                        : runtime.installed
                          ? "Unavailable"
                          : "Not installed"}
              </span>
            </p>
            {!runtime.available && <p>{runtime.help}</p>}
            {runtime.enabled && (
              <p className="note">
                Bound project: {runtime.project || "unknown"}. Billing:{" "}
                {runtime.billing || "unknown"}.
              </p>
            )}
            {open && (
              <RuntimeSignIn
                key={runtime.name + projectId}
                name={runtime.name}
                label={label}
                projectId={projectId!}
                signedIn={signedIn}
                enabled={runtime.enabled}
                enabling={busy}
                enableAction={enableAction}
                onStateChange={onAuthState}
                onClose={() => {
                  setSigningIn(undefined);
                  void refresh().catch((e) => setError(e.message));
                }}
              />
            )}
            {!open && (
              <div className="native-runtime-actions">
                {enableAction}
                <button
                  type="button"
                  className="text-button"
                  disabled={
                    busy ||
                    !projectId ||
                    !runtime.available ||
                    !discovery.online
                  }
                  onClick={() => setSigningIn(runtime.name)}
                  aria-label={
                    signedIn || runtime.enabled
                      ? `Manage ${label} account`
                      : undefined
                  }
                >
                  {signedIn || runtime.enabled
                    ? "Manage account"
                    : `Sign in to ${label}`}
                </button>
              </div>
            )}
          </div>
        );
      })}
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
