import {
  runtimeSetupMessages,
  type RuntimeSetupState,
} from "../shared/runtime-setup";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { runtimeAuthScope } from "../shared/runtime-auth-scope";
import { HarnessUpgrade } from "./HarnessUpgrade";
import { RuntimeSignIn } from "./RuntimeSignIn";
import type { NativeAuthView, SignIn } from "../shared/native-auth";

type Runtime = {
  name: string;
  backend?: "hapi" | "direct";
  environmentId?: string;
  generation?: number;
  installed: boolean;
  available: boolean;
  enabled: boolean;
  version?: string;
  help: string;
  authentication: string;
  billing?: string;
  project?: string;
};
type Discovery = {
  computer: string;
  online: boolean;
  setup?: RuntimeSetupState;
  runtimes: Runtime[];
};
const labels: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi",
  opencode: "OpenCode",
};
function authBase(runtime: Runtime) {
  return runtime.backend === "hapi"
    ? `/environments/${encodeURIComponent(runtime.environmentId!)}/provider/${runtime.name}`
    : `/workspace/runtimes/${runtime.name}/auth`;
}
function authStatus(runtime: Runtime) {
  return api<NativeAuthView>(`${authBase(runtime)}/status`, runtime.backend === "hapi" ? {} : undefined);
}
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
        const auth = await authStatus(runtime);
        return [runtimeAuthScope(runtime), auth.attempt?.state] as const;
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
      const projectId = runtime.enabled && runtime.backend !== "hapi"
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
  const settingUp =
    discovery?.setup === "preparing" || discovery?.setup === "starting";
  useEffect(() => {
    if (!settingUp) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const host = await api<Discovery>("/workspace/runtimes");
        if (!disposed) setDiscovery(host);
      } catch {
        // Preserve the last status; the explicit refresh can report errors.
      } finally {
        if (!disposed) timer = setTimeout(poll, 2500);
      }
    };
    timer = setTimeout(poll, 2500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [settingUp]);
  const authInProgress = discovery?.runtimes.some((runtime) =>
    ["starting", "waiting"].includes(authStates[runtimeAuthScope(runtime)] || ""),
  );
  useEffect(() => {
    if (!authInProgress) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await Promise.allSettled(
        (discovery?.runtimes || [])
          .filter((runtime) => ["starting", "waiting"].includes(authStates[runtimeAuthScope(runtime)] || ""))
          .map(async (runtime) => {
            const view = await authStatus(runtime);
            if (!disposed) onAuthState(runtimeAuthScope(runtime), view.attempt?.state);
          }),
      );
      if (!disposed) timer = setTimeout(poll, 1200);
    };
    timer = setTimeout(poll, 1200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [authInProgress, authStates, onAuthState, discovery]);
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
      {discovery?.setup && discovery.setup !== "idle" && (
        <p role="status">{runtimeSetupMessages[discovery.setup]}</p>
      )}
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
        No automatic billing fallback. Managed Codex, Claude Code and OpenCode
        require native subscription sign-in. Pi uses existing billing and may
        incur API charges. Direct runtimes use the selected or saved policy.
      </p>
      {discovery?.runtimes.map((runtime) => {
        const label = labels[runtime.name];
        const scope = runtimeAuthScope(runtime);
        const open = signingIn === runtime.name;
        const signedIn = authStates[scope] === "complete" || runtime.authentication === "signed_in";
        const authenticating = ["starting", "waiting"].includes(
          authStates[scope] || "",
        );
        const projectId = runtime.enabled && runtime.backend !== "hapi"
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
            {runtime.version && <p className="note">Version {runtime.version}</p>}
            <HarnessUpgrade
              base={runtime.backend === "hapi"
                ? `/environments/${runtime.environmentId}/runtimes/${runtime.name}/upgrade`
                : `/workspace/runtimes/${runtime.name}/upgrade`}
              label={label} generation={runtime.backend === "hapi" ? runtime.generation : undefined}
              disabled={busy || settingUp || authenticating || !!signingIn || !runtime.installed}
              onComplete={() => { void refresh().catch((e) => setError(e.message)); }}
            />
            {!runtime.available && <p>{runtime.help}</p>}
            {(runtime.enabled || runtime.backend === "hapi") && (
              <p className="note">
                {runtime.backend === "hapi" ? "Managed runner" : `Bound project: ${runtime.project || "unknown"}`}. Billing:{" "}
                {runtime.billing || "unknown"}.
              </p>
            )}
            {open && (
              <RuntimeSignIn
                base={authBase(runtime)}
                backend={runtime.backend === "hapi" ? "environment" : "direct"}
                location="this computer"
                key={scope + projectId}
                name={runtime.name}
                label={label}
                projectId={projectId!}
                signedIn={signedIn}
                enabled={runtime.enabled}
                enabling={busy}
                enableAction={enableAction}
                onStateChange={(_, state) => onAuthState(scope, state)}
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
