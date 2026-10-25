import { workspaceApi } from "../shared/workspace-api";
import { callRoute } from "./workspace-api";
import { executionSourceId } from "./sourceRouting";
import {
  runtimeSetupMessages,
  type RuntimeSetupState,
} from "../shared/runtime-setup";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, parse } from "./api";
import { Sheet } from "./components";
import { ConnectionDetails } from "./ConnectionDetails";
import type { Connection } from "../shared/types";
import { runtimeAuthScope } from "../shared/runtime-auth-scope";
import { HarnessUpgrade } from "./HarnessUpgrade";
import { connectsModelProvider, RuntimeSignIn } from "./RuntimeSignIn";
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
  gemini: "Gemini CLI",
  muse: "Muse Code",
  grok: "Grok Build",
};
// These harnesses cannot attest subscription billing, so setup has no picker.
const existingOnly = (name: string) =>
  name === "gemini" || name === "muse" || name === "grok";
function authBase(runtime: Runtime) {
  return `/workspace/runtimes/${runtime.name}/auth` as const;
}
function authStatus(runtime: Runtime) {
  return api<NativeAuthView>(`${authBase(runtime)}/status`);
}
function matchesRuntime(connection: Connection, runtime: Runtime) {
  return parse<any>(connection.metadata, {}).loopHarness === runtime.name;
}
export function RuntimeSetup({
  onEnabled,
  connections = [],
}: {
  onEnabled: (name: string) => Promise<void>;
  connections?: Connection[];
}) {
  const [discovery, setDiscovery] = useState<Discovery>();
  const [projects, setProjects] = useState<
    { folder_id: string; path: string }[]
  >([]);
  const [project, setProject] = useState("");
  const [billing, setBilling] = useState("subscription");
  const [enabling, setEnabling] = useState<string>();
  const [inspecting, setInspecting] = useState<string>();
  const busy = !!enabling || !!inspecting;
  const [error, setError] = useState("");
  const [enableError, setEnableError] = useState<{
    name: string;
    scope: string;
    message: string;
    inspected?: boolean;
  }>();
  const [signingIn, setSigningIn] = useState<string>();
  const [authStates, setAuthStates] = useState<
    Record<string, SignIn["state"] | undefined>
  >({});
  const authRevision = useRef(0);
  const authAttempts = useRef(new Map<string, string | undefined>());
  const enableCommands = useRef(new Map<string, string>());
  const onAuthState = useCallback(
    (name: string, state: SignIn["state"] | undefined, attemptId?: string) => {
      authRevision.current++;
      authAttempts.current.set(name, attemptId);
      setAuthStates((current) => ({ ...current, [name]: state }));
      // A new login supersedes the previous account's enable/refresh failure.
      // Do not clear on every complete status: verification can still fail
      // independently after authentication succeeds.
      if (state === "starting" || state === "waiting")
        setEnableError((current) =>
          current?.scope === name ? undefined : current,
        );
    },
    [],
  );
  async function refresh() {
    const revision = authRevision.current;
    const [host, workspace] = await Promise.all([
      api<Discovery>("/workspace/runtimes?fresh=1"),
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
        return [runtimeAuthScope(runtime), auth.attempt?.state, auth.attempt?.id] as const;
      }),
    );
    // A sign-in response received during discovery is newer than this snapshot.
    if (revision === authRevision.current) {
      for (const result of states)
        if (result.status === "fulfilled")
          authAttempts.current.set(result.value[0], result.value[2]);
      setAuthStates((current) => ({
        ...current,
        ...Object.fromEntries(
          states.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          ),
        ),
      }));
    }
  }
  async function inspect(runtime: Runtime) {
    const failure = enableError;
    setInspecting(runtime.name);
    setError("");
    try {
      await refresh();
      setEnableError((current) => current === failure && current
        ? { ...current, inspected: true } : current);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInspecting(undefined);
    }
  }
  async function enable(runtime: Runtime, newAttempt = false) {
    setEnabling(runtime.name);
    setEnableError(undefined);
    setError("");
    try {
      const projectId = runtime.enabled
        ? projects.find((p) => p.path === runtime.project)?.folder_id
        : project;
      const selectedBilling = existingOnly(runtime.name) ? "existing" : runtime.billing || billing;
      const commandKey = JSON.stringify([runtime.name, projectId, selectedBilling, runtime.version, authAttempts.current.get(runtimeAuthScope(runtime))]);
      // Only an explicit action after inspection starts a new verification.
      // Ordinary retries keep reconciling the original durable command.
      if (newAttempt) enableCommands.current.delete(commandKey);
      const commandId = enableCommands.current.get(commandKey) || crypto.randomUUID();
      enableCommands.current.set(commandKey, commandId);
      await api(`/workspace/runtimes/${runtime.name}/enable`, {
        projectId,
        billing: selectedBilling,
        commandId,
      });
      enableCommands.current.delete(commandKey);
      const results = await Promise.allSettled([
        onEnabled(runtime.name),
        refresh(),
      ]);
      if (results.some((result) => result.status === "rejected"))
        setError(
          "Runtime enabled, but the screen could not refresh. Check installed runtimes again.",
        );
    } catch (e) {
      setEnableError({
        name: runtime.name,
        scope: runtimeAuthScope(runtime),
        message: (e as Error).message,
      });
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
    ["starting", "waiting"].includes(
      authStates[runtimeAuthScope(runtime)] || "",
    ),
  );
  useEffect(() => {
    if (!authInProgress) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await Promise.allSettled(
        (discovery?.runtimes || [])
          .filter((runtime) =>
            ["starting", "waiting"].includes(
              authStates[runtimeAuthScope(runtime)] || "",
            ),
          )
          .map(async (runtime) => {
            const view = await authStatus(runtime);
            if (!disposed)
              onAuthState(runtimeAuthScope(runtime), view.attempt?.state, view.attempt?.id);
          }),
      );
      if (!disposed) timer = setTimeout(poll, 1200);
    };
    timer = setTimeout(poll, 1200);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [authInProgress, authStates, onAuthState, discovery]);
  const projectFields = (
    <>
      <label>
        Project directory for new runtimes
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          disabled={busy || authInProgress}
        >
          {!projects.length && <option value="">No project directories</option>}
          {projects.map((p) => (
            <option key={p.folder_id} value={p.folder_id}>
              {p.path}
            </option>
          ))}
        </select>
      </label>
      {!projects.length && (
        <p className="field-hint">
          Add a desktop directory in Projects before enabling a runtime.
        </p>
      )}
    </>
  );
  const setupFields = (
    <>
      {projectFields}
      <label>
        Billing policy for new runtimes
        <select
          value={billing}
          onChange={(e) => setBilling(e.target.value)}
          disabled={busy || authInProgress}
        >
          <option value="subscription">
            Require verified native subscription
          </option>
          <option value="existing">
            Use existing native configuration (may incur API charges)
          </option>
        </select>
      </label>
      <p className="field-hint">
        No automatic billing fallback. Pi uses existing billing and may incur
        API charges.
      </p>
    </>
  );
  return (
    <section className="runtime-setup" aria-label="Runtime setup">
      <div className="settings-section-head">
        <h3>{discovery ? discovery.computer : "Checking this computer…"}</h3>
        {discovery && (
          <span className="settings-status">
            {discovery.online ? "Online" : "Offline"}
          </span>
        )}
      </div>
      {discovery?.setup && discovery.setup !== "idle" && (
        <p role="status" className="note">
          {runtimeSetupMessages[discovery.setup]}
        </p>
      )}
      <p className="settings-intro">Use your coding accounts in Loop.</p>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      <div className="settings-card-list">
        {discovery?.runtimes.map((runtime) => {
          const label = labels[runtime.name] || runtime.name;
          const scope = runtimeAuthScope(runtime);
          const open = signingIn === runtime.name;
          const signedIn =
            authStates[scope] === "complete" ||
            runtime.authentication === "signed_in" ||
            // An enabled runtime passed its account check when it was enabled.
            (runtime.enabled && runtime.authentication === "previously_verified");
          const authenticating = ["starting", "waiting"].includes(
            authStates[scope] || "",
          );
          const projectId = runtime.enabled
            ? projects.find((p) => p.path === runtime.project)?.folder_id
            : project;
          // Direct sign-in runs the harness in a project directory.
          const needsProject = !projectId;
          const state = !discovery.online
            ? "Offline"
            : authenticating
              ? "Signing in…"
              : !runtime.available
                ? runtime.installed
                  ? "Unavailable"
                  : "Not installed"
                : runtime.enabled
                  ? "Enabled in Loop"
                  : signedIn
                    ? "Signed in"
                    : "Sign-in needed";
          const enableAction = (
            <>
              <button
                type="button"
                className="primary"
                disabled={
                  busy ||
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
              {enableError?.scope === scope && (
                <div className="settings-error" role="alert">
                  <strong>Connection not verified</strong>
                  <p>{enableError.message}</p>
                  <p>{enableError.inspected
                    ? "Runtime status is up to date. Start a new verification if needed."
                    : "Your sign-in is saved. Check runtime status before starting a new verification."}</p>
                  <button
                    type="button"
                    disabled={busy || authenticating || !projectId || !runtime.available || !discovery.online}
                    onClick={() => void (enableError.inspected ? enable(runtime, true) : inspect(runtime))}
                  >
                    {inspecting === runtime.name ? "Checking…" : enableError.inspected ? "Start new verification" : "Check runtime status"}
                  </button>
                </div>
              )}
            </>
          );
          return (
            <section className="native-runtime settings-card" key={scope}>
              <div className="settings-card-heading">
                <span className="provider-mark" aria-hidden="true">
                  {label[0]}
                </span>
                <div>
                  <h3>{label}</h3>
                  <small>
                    {runtime.billing === "existing" ||
                    runtime.name === "pi" ||
                    existingOnly(runtime.name)
                      ? "Existing billing · may incur API charges"
                      : runtime.billing === "subscription"
                        ? "Native subscription"
                        : "Choose billing during setup"}
                  </small>
                </div>
                <span className="settings-status">{state}</span>
              </div>
              <button
                type="button"
                className="settings-next"
                disabled={
                  busy ||
                  !runtime.installed ||
                  (needsProject && runtime.available && discovery.online)
                }
                onClick={() => setSigningIn(runtime.name)}
                aria-label={
                  !runtime.available || !discovery.online
                    ? `${label} setup details`
                    : signedIn || runtime.enabled
                      ? `Manage ${label} account`
                      : connectsModelProvider(runtime.name)
                        ? `Connect a model provider for ${label}`
                        : `Sign in to ${label}`
                }
              >
                {!runtime.available || !discovery.online
                  ? "Setup details"
                  : signedIn || runtime.enabled
                    ? runtime.enabled
                      ? "Manage account"
                      : "Finish connecting"
                    : connectsModelProvider(runtime.name)
                      ? "Connect a provider"
                      : `Sign in to ${label}`}{" "}
                <span aria-hidden="true">→</span>
              </button>
              {!runtime.available && (
                <p className="field-hint">{runtime.help}</p>
              )}
              {needsProject && runtime.available && discovery.online && (
                <p className="field-hint">
                  {runtime.enabled
                    ? `${label} is bound to a directory that is no longer in Projects. Add it back to manage this account.`
                    : "Add a desktop directory in Projects before signing in."}
                </p>
              )}
              {open && (
                <Sheet
                  className="settings-sheet"
                  title={label}
                  onClose={() => setSigningIn(undefined)}
                >
                  <p className="settings-intro">
                    {discovery.computer} · Native harness
                  </p>
                  {runtime.available && discovery.online ? (
                    <RuntimeSignIn
                      base={authBase(runtime)}
                      backend="direct"
                      location={discovery.computer}
                      key={scope}
                      name={runtime.name}
                      label={label}
                      projectId={projectId}
                      signedIn={signedIn}
                      enabled={runtime.enabled}
                      enabling={busy}
                      connectionSetup={
                        <section className="settings-card">
                          <h3>Connection setup</h3>
                          {runtime.enabled ? (
                            <p>
                              Project:{" "}
                              <code>{runtime.project || "Unknown"}</code>
                            </p>
                          ) : existingOnly(runtime.name) ? (
                            projectFields
                          ) : (
                            setupFields
                          )}
                          {runtime.billing && (
                            <p className="field-hint">
                              Saved billing policy: {runtime.billing}.{" "}
                              {runtime.billing === "existing" &&
                                "Provider charges may apply."}
                            </p>
                          )}
                        </section>
                      }
                      enableAction={enableAction}
                      onStateChange={(_, state, attemptId) => onAuthState(scope, state, attemptId)}
                      onClose={() => {
                        setSigningIn(undefined);
                        void refresh().catch((e) => setError(e.message));
                      }}
                    />
                  ) : (
                    <p>
                      {state}. {runtime.help}
                    </p>
                  )}
                  <details
                    className="settings-details"
                    open={!runtime.available}
                  >
                    <summary>Advanced & installation</summary>
                    {connections
                      .filter((c) => matchesRuntime(c, runtime))
                      .map((c) => (
                        <ConnectionDetails key={c.id} connection={c} />
                      ))}
                    {runtime.version && <p>Version {runtime.version}</p>}
                    <HarnessUpgrade
                      base={`/workspace/runtimes/${runtime.name}/upgrade`}
                      label={label}
                      disabled={
                        busy ||
                        settingUp ||
                        authenticating ||
                        !discovery.online ||
                        !runtime.installed
                      }
                      onComplete={() => {
                        void refresh().catch((e) => setError(e.message));
                      }}
                    />
                    <p className="field-hint">
                      Native tools, instructions and session context stay with
                      this harness. Existing conversations keep their project.
                    </p>
                  </details>
                </Sheet>
              )}
            </section>
          );
        })}
      </div>
      {discovery &&
        connections
          .filter((c) => {
            const metadata = parse<any>(c.metadata, {});
            return (
              metadata.loopHarness &&
              !discovery.runtimes.some((runtime) => matchesRuntime(c, runtime))
            );
          })
          .map((connection) => (
            <details
              className="settings-card settings-details"
              key={connection.id}
            >
              <summary>
                {connection.label} · {connection.status}
              </summary>
              <ConnectionDetails connection={connection} />
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const metadata = parse<any>(connection.metadata, {});
                  setEnabling(connection.id);
                  setError("");
                  try {
                    await callRoute(workspaceApi.connectionRefresh, { params: { id: connection.id }, body: {} }, executionSourceId());
                    await onEnabled(metadata.loopHarness || metadata.flavor);
                  } catch (cause) {
                    setError((cause as Error).message);
                  } finally {
                    setEnabling(undefined);
                  }
                }}
              >
                Refresh account and models
              </button>
            </details>
          ))}
      {!signingIn && (
        <details className="settings-details">
          <summary>Defaults for new harnesses</summary>
          {setupFields}
        </details>
      )}
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => {
          setError("");
          void refresh().catch((e) => setError(e.message));
        }}
      >
        Check installed runtimes again
      </button>
    </section>
  );
}
