import { harnesses, isManagedHarness } from "../shared/harnesses";
import { useProjectionRoute } from "./SourceContext";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { callRoute } from "./workspace-api";
import { executionSourceId } from "./sourceRouting";
import { runtimeSetupMessages } from "../shared/runtime-setup";
import { useCallback, useEffect, useRef, useState } from "react";
import { parse } from "./api";
import { Sheet } from "./components";
import { ConnectionDetails } from "./ConnectionDetails";
import type { Connection } from "../shared/types";
import { runtimeAuthScope } from "../shared/runtime-auth-scope";
import { HarnessUpgrade } from "./HarnessUpgrade";
import { RuntimeSignIn } from "./RuntimeSignIn";
import { HarnessProviders } from "./HarnessProviders";
import { performStoredEffect, UncertainEffect } from "./pendingCommands";
import { viewOwner, viewGeneration } from "./viewCache";
type SignIn = NonNullable<
  RouteResponse<typeof workspaceApi.runtimeAuthStatus>["attempt"]
>;

type Discovery = RouteResponse<typeof workspaceApi.runtimeList>;
type Runtime = Discovery["runtimes"][number];
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
  const read = useProjectionRoute();
  const owner = viewOwner();
  const generation = viewGeneration();
  const source = executionSourceId();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () =>
    mounted.current &&
    owner === viewOwner() &&
    generation === viewGeneration() &&
    source === executionSourceId();
  const [discovery, setDiscovery] = useState<Discovery>();
  const [projects, setProjects] = useState<
    RouteResponse<typeof workspaceApi.workspace>["projectPaths"]
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
    failure?: UncertainEffect;
    target?: string;
  }>();
  const [signingIn, setSigningIn] = useState<string>();
  const [authStates, setAuthStates] = useState<
    Record<string, SignIn["state"] | undefined>
  >({});
  const authRevision = useRef(0);
  const authAttempts = useRef(new Map<string, string | undefined>());
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
      read(workspaceApi.runtimeList, { query: { fresh: "1" } }),
      read(workspaceApi.workspace, {}),
    ]);
    setDiscovery(host);
    setProjects(workspace.projectPaths);
    setProject(
      (current) => current || workspace.projectPaths[0]?.folder_id || "",
    );
    // Read existing attempts without starting a harness or another sign-in.
    const states = await Promise.allSettled(
      host.runtimes.map(async (runtime) => {
        const auth = await read(workspaceApi.runtimeAuthStatus, {
          params: { name: runtime.name },
        });
        return [
          runtimeAuthScope(runtime),
          auth.attempt?.state,
          auth.attempt?.id,
        ] as const;
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
      setEnableError((current) =>
        current === failure && current
          ? { ...current, inspected: true }
          : current,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInspecting(undefined);
    }
  }
  async function enable(runtime: Runtime, newAttempt = false) {
    const previousFailure = enableError;
    let target: string | undefined;
    let superseding: UncertainEffect | undefined;
    setEnabling(runtime.name);
    setEnableError(undefined);
    setError("");
    try {
      const projectId = runtime.project
        ? projects.find((p) => p.path === runtime.project)?.folder_id
        : project;
      const selectedBilling =
        runtime.billing ||
        (harnesses[runtime.name].billing.default === "existing"
          ? "existing"
          : billing);
      const commandKey = JSON.stringify([
        runtime.name,
        projectId,
        selectedBilling,
        runtime.version,
        authAttempts.current.get(runtimeAuthScope(runtime)),
      ]);
      target = commandKey;
      if (newAttempt && previousFailure?.target === commandKey) {
        superseding = previousFailure.failure;
        await superseding?.supersede();
        superseding = undefined;
      }
      await performStoredEffect(
        localStorage,
        owner,
        source,
        ["runtime-enable", commandKey],
        current,
        (commandId) =>
          callRoute(
            workspaceApi.runtimeEnable,
            {
              params: { name: runtime.name },
              body: {
                projectId: projectId || "",
                billing:
                  workspaceApi.runtimeEnable.body.shape.billing.parse(
                    selectedBilling,
                  ),
                commandId,
              },
            },
            source,
          ),
        (error, recovering) => {
          const outcome = (error as { executionOutcome?: string } | null)
            ?.executionOutcome;
          // Access checks can refuse recovery before the authority reads its
          // receipt. Such a refusal cannot settle an earlier uncertain command.
          return (
            outcome === "completed" || (!recovering && outcome === "refused")
          );
        },
      );
      if (!current()) return;
      const results = await Promise.allSettled([
        onEnabled(runtime.name),
        refresh(),
      ]);
      if (current() && results.some((result) => result.status === "rejected"))
        setError(
          "Runtime enabled, but the screen could not refresh. Check installed runtimes again.",
        );
    } catch (e) {
      if (!current()) return;
      setEnableError({
        name: runtime.name,
        scope: runtimeAuthScope(runtime),
        message: (e as Error).message,
        failure: e instanceof UncertainEffect ? e : superseding,
        target,
      });
    } finally {
      if (mounted.current) setEnabling(undefined);
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
        const host = await read(workspaceApi.runtimeList, {});
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
            const view = await read(workspaceApi.runtimeAuthStatus, {
              params: { name: runtime.name },
            });
            if (!disposed)
              onAuthState(
                runtimeAuthScope(runtime),
                view.attempt?.state,
                view.attempt?.id,
              );
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
          const label = harnesses[runtime.name].label;
          const scope = runtimeAuthScope(runtime);
          const open = signingIn === runtime.name;
          const signedIn =
            authStates[scope] === "complete" ||
            runtime.authentication === "signed_in" ||
            // An enabled runtime passed its account check when it was enabled.
            (runtime.enabled &&
              runtime.authentication === "previously_verified");
          const authenticating = ["starting", "waiting"].includes(
            authStates[scope] || "",
          );
          // A disconnected harness still owns its saved project binding.
          // Keep provider outcomes mounted while discovery updates its status.
          const projectId = runtime.project
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
                  <p>
                    {enableError.inspected
                      ? "Runtime status is up to date. Start a new verification if needed."
                      : "Check runtime status before starting a new verification."}
                  </p>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      authenticating ||
                      !projectId ||
                      !runtime.available ||
                      !discovery.online
                    }
                    onClick={() =>
                      void (enableError.inspected
                        ? enable(runtime, true)
                        : inspect(runtime))
                    }
                  >
                    {inspecting === runtime.name
                      ? "Checking…"
                      : enableError.inspected
                        ? "Start new verification"
                        : "Check runtime status"}
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
                    {isManagedHarness(runtime.name)
                      ? "Model providers managed by the harness"
                      : runtime.billing === "existing" ||
                          harnesses[runtime.name].billing.default === "existing"
                        ? "Existing billing · may incur API charges"
                        : runtime.billing === "subscription"
                          ? "Native subscription"
                          : "Choose billing during setup"}
                  </small>
                </div>
                <span
                  className={`settings-status${state === "Enabled in Loop" ? " connected" : ""}`}
                >
                  {state}
                </span>
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
                    : isManagedHarness(runtime.name)
                      ? `Manage ${label} providers`
                      : signedIn || runtime.enabled
                        ? `Manage ${label} account`
                        : isManagedHarness(runtime.name)
                          ? `Connect a model provider for ${label}`
                          : `Sign in to ${label}`
                }
              >
                {!runtime.available || !discovery.online
                  ? "Setup details"
                  : isManagedHarness(runtime.name)
                    ? "Manage providers"
                    : signedIn || runtime.enabled
                      ? runtime.enabled
                        ? "Manage account"
                        : "Finish connecting"
                      : isManagedHarness(runtime.name)
                        ? "Connect a provider"
                        : `Sign in to ${label}`}{" "}
                <span aria-hidden="true">→</span>
              </button>
              {!runtime.available && (
                <p className="field-hint">{runtime.help}</p>
              )}
              {needsProject && runtime.available && discovery.online && (
                <p className="field-hint">
                  {runtime.project
                    ? `${label} is bound to a directory that is no longer in Projects. Add it back to manage this account.`
                    : "Add a desktop directory in Projects before signing in."}
                </p>
              )}
              <p className="field-hint">
                {discovery.computer}
                {runtime.version ? ` · Version ${runtime.version}` : ""}
              </p>
              {runtime.installed && (
                <HarnessUpgrade
                  key={scope}
                  runtime={runtime.name}
                  label={label}
                  disabled={
                    busy || settingUp || authenticating || !discovery.online
                  }
                  onComplete={() => {
                    void refresh().catch((e) => setError(e.message));
                  }}
                />
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
                  {runtime.available &&
                  discovery.online &&
                  isManagedHarness(runtime.name) ? (
                    <HarnessProviders
                      key={`${executionSourceId()}:${runtime.name}:${projectId}`}
                      runtime={runtime.name}
                      projectId={projectId || ""}
                      location={discovery.computer}
                      targets={discovery.runtimes.flatMap((r) => {
                        if (
                          !isManagedHarness(r.name) ||
                          !r.available ||
                          r.name === runtime.name
                        )
                          return [];
                        const id = r.project
                          ? projects.find((p) => p.path === r.project)
                              ?.folder_id
                          : project;
                        return id
                          ? [
                              {
                                name: r.name,
                                label: harnesses[r.name].label,
                                projectId: id,
                              },
                            ]
                          : [];
                      })}
                      onChange={async () => {
                        await onEnabled(runtime.name);
                        await refresh();
                      }}
                    />
                  ) : runtime.available && discovery.online ? (
                    <RuntimeSignIn
                      runtime={runtime.name}
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
                          ) : harnesses[runtime.name].billing.default ===
                            "existing" ? (
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
                          {runtime.name === "antigravity" && (
                            <p className="field-hint">
                              Antigravity uses its native permissions. Headless
                              runs cannot ask for approvals in Loop; allow the
                              tools you need in Antigravity settings. Loop
                              workspace tools and team delegation are
                              unavailable.
                            </p>
                          )}
                        </section>
                      }
                      enableAction={enableAction}
                      onStateChange={(_, state, attemptId) =>
                        onAuthState(scope, state, attemptId)
                      }
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
                    await callRoute(
                      workspaceApi.connectionRefresh,
                      { params: { id: connection.id }, body: {} },
                      executionSourceId(),
                    );
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
