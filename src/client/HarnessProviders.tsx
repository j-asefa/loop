import { ExecutionCommandId } from "../shared/contract-ids.js";
import { NativeProviderId, AuthMethodId } from "../shared/contract-ids.js";
import { ProjectId, parseId } from "../shared/contract-ids.js";
import { harnesses, type ManagedHarness as Harness } from "../shared/harnesses";
import { literalEntry } from "./textEntry";
import { useEffect, useRef, useState } from "react";
import { CircleCheck } from "lucide-react";
import { workspaceApi } from "../shared/workspace-api";
import type { NativeProviderView } from "../shared/native-providers";
import { useSourceId, useProjectionRoute } from "./SourceContext";
import { callRoute } from "./api";
import { performStoredEffect, UncertainEffect } from "./pendingCommands";
import { EffectRecovery } from "./EffectRecovery";
import { viewGeneration, viewOwner } from "./viewCache";
import { RuntimeSignIn } from "./RuntimeSignIn";

type Target = { name: Harness; label: string; projectId: string };
type Provider = NativeProviderView["providers"][number];

export function HarnessProviders({
  runtime,
  projectId,
  location,
  targets,
  onChange,
}: {
  runtime: Harness;
  projectId: string;
  location: string;
  targets: Target[];
  onChange(): Promise<void>;
}) {
  const sourceId = useSourceId();
  const read = useProjectionRoute();
  const [view, setView] = useState<NativeProviderView>();
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState("");
  const [method, setMethod] = useState("");
  const [secret, setSecret] = useState("");
  const [also, setAlso] = useState<Harness[]>([]);
  const [login, setLogin] = useState<{ provider: string; method: string }>();
  const [removing, setRemoving] = useState<Provider>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [inspect, setInspect] = useState(false);
  const [recoveries, setRecoveries] = useState<
    { scope: string; label: string; failure: UncertainEffect; key: string }[]
  >([]);
  const mounted = useRef(true);
  const owner = viewOwner();
  const generation = viewGeneration();
  const context = JSON.stringify([sourceId, runtime, projectId, generation]);
  const activeContext = useRef(context);
  activeContext.current = context;
  const current = () =>
    mounted.current &&
    activeContext.current === context &&
    generation === viewGeneration();
  const command = async <T,>(
    target: string[],
    dispatch: (id: ExecutionCommandId) => Promise<T>,
  ) => {
    const scope = JSON.stringify(target);
    try {
      const result = await performStoredEffect(
        localStorage,
        owner,
        sourceId,
        target,
        current,
        (id) => dispatch(ExecutionCommandId.parse(id)),
      );
      if (current())
        setRecoveries((previous) =>
          previous.filter((entry) => entry.scope !== scope),
        );
      return result;
    } catch (error) {
      if (current())
        setRecoveries((previous) => [
          ...previous.filter((entry) => entry.scope !== scope),
          ...(error instanceof UncertainEffect
            ? [
                {
                  scope,
                  key: crypto.randomUUID(),
                  label: `${harnesses[target[1] as Harness].label}: ${target[0] === "provider-key" ? `save ${target[3]} credential` : target[0] === "provider-remove" ? `remove ${target[3]} credential` : "refresh providers"}`,
                  failure: error,
                },
              ]
            : []),
        ]);
      throw error;
    }
  };
  const selected = view?.providers.find((p) => p.id === provider);
  const selectedMethod = selected?.methods.find((m) => m.id === method);
  const modelCount =
    view?.models.filter((m) => m.id !== "native-default").length || 0;
  const affected = (id: string) =>
    view?.agents.filter(
      (a) => a.model === "native-default" || a.model.startsWith(id + "/"),
    ) || [];
  const catalog = (name: Harness, project: string) =>
    read(workspaceApi.runtimeProviders, {
      params: { name },
      query: { projectId: parseId(ProjectId, project) },
    });
  async function load() {
    const next = await catalog(runtime, projectId);
    if (current()) setView(next);
    return next;
  }
  useEffect(() => {
    mounted.current = true;
    void load().catch(() => {
      if (current())
        setError("Could not load providers. Refresh to try again.");
    });
    return () => {
      mounted.current = false;
    };
  }, [runtime, projectId, sourceId]);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function refresh(useProviderBilling = false) {
    setLogin(undefined);
    setRefreshing(true);
    await perform(async () => {
      const next = await command(
        ["provider-refresh", runtime, projectId, String(useProviderBilling)],
        (commandId) =>
          callRoute(
            workspaceApi.runtimeProviderRefresh,
            {
              params: { name: runtime },
              body: {
                projectId: parseId(ProjectId, projectId),
                useProviderBilling,
                commandId,
              },
            },
            sourceId,
          ),
      );
      if (current()) {
        setView(next);
        setInspect(false);
      }
      if (current()) await onChange();
      if (current() && next.enabled && !next.syncError)
        setNotice(`${harnesses[runtime].label} refreshed successfully.`);
    });
    if (current()) setRefreshing(false);
  }
  function choose(p: Provider) {
    setProvider(p.id);
    setMethod(p.methods[0]?.id || "");
    setSecret("");
    setAlso([]);
    setAdding(true);
    setRemoving(undefined);
    setResults([]);
  }
  async function saveKey() {
    const key = secret;
    setSecret("");
    setResults([]);
    await perform(async () => {
      const fingerprint = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(key.trim()),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const outcomes: string[] = [];
      let failed = false;
      for (const target of [
        { name: runtime, projectId, label: harnesses[runtime].label },
        ...targets.filter((t) => also.includes(t.name)),
      ]) {
        try {
          const targetView =
            target.name === runtime
              ? view!
              : await catalog(target.name, target.projectId);
          const methods =
            targetView.providers
              .find((p) => p.id === provider)
              ?.methods.filter((m) => m.type === "api") || [];
          const targetMethod =
            target.name === runtime
              ? method
              : methods.find((m) => m.label === selectedMethod?.label)?.id ||
                (methods.length === 1 ? methods[0].id : undefined);
          if (!targetMethod)
            throw new Error(
              "Choose this provider’s API-key method in its own provider list.",
            );
          const next = await command(
            [
              "provider-key",
              target.name,
              target.projectId,
              provider,
              targetMethod,
              fingerprint,
            ],
            (commandId) =>
              callRoute(
                workspaceApi.runtimeProviderKey,
                {
                  params: { name: target.name },
                  body: {
                    projectId: parseId(ProjectId, target.projectId),
                    provider: NativeProviderId.parse(provider),
                    method: AuthMethodId.parse(targetMethod),
                    secret: key,
                    commandId,
                  },
                },
                sourceId,
              ),
          );
          outcomes.push(
            `${target.label}: key saved. ${next.syncError || (next.billing === "subscription" ? "Models refreshed under the saved subscription-only restriction." : "Models refreshed.")}`,
          );
          if (current() && target.name === runtime) setView(next);
        } catch (e) {
          failed = true;
          outcomes.push(
            `${target.label}: change unconfirmed. ${(e as Error).message}`,
          );
        }
        if (current()) setResults([...outcomes]);
      }
      if (current()) {
        setInspect(failed);
        if (!failed) setAdding(false);
      }
      if (current()) await onChange();
    });
  }
  if (login)
    return (
      <>
        <button
          type="button"
          className="text-button"
          onClick={() => setLogin(undefined)}
        >
          Back to providers
        </button>
        <RuntimeSignIn
          runtime={runtime}
          backend="direct"
          name={runtime}
          label={harnesses[runtime].label}
          location={location}
          projectId={projectId}
          initialProvider={login.provider}
          initialMethod={login.method}
          signedIn={false}
          enabled={view?.enabled || false}
          enabling={busy}
          enableAction={null}
          onStateChange={() => {}}
          onClose={() => setLogin(undefined)}
          onAuthenticated={() => {
            setLogin(undefined);
            void perform(async () => {
              await load();
              if (current()) await onChange();
            });
          }}
        />
      </>
    );
  return (
    <section
      className="harness-providers"
      aria-label={`${harnesses[runtime].label} providers`}
    >
      {!view && !error && <p role="status">Loading providers and models…</p>}
      {view?.billing === "subscription" && (
        <div className="settings-card">
          <p>
            This harness has a saved subscription-only restriction. API-key
            models remain excluded until you change it.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh(true)}
          >
            Use provider billing (API charges may apply)
          </button>
        </div>
      )}
      {view && (
        <>
          <div
            className={`harness-connection-status${view.enabled && !view.syncError ? " connected" : ""}`}
            role="status"
          >
            <h3>
              {view.enabled && !view.syncError && (
                <CircleCheck size={22} aria-hidden="true" />
              )}
              {harnesses[runtime].label} is{" "}
              {view.enabled ? "enabled" : "not enabled"} in Loop
            </h3>
            <p>
              {modelCount} {modelCount === 1 ? "model" : "models"} found.
            </p>
            {view.enabled && !view.syncError && (
              <p>
                You can choose {harnesses[runtime].label} when creating an
                agent.
              </p>
            )}
          </div>
          <p className="field-hint">
            Models checked {new Date(view.updatedAt).toLocaleTimeString()}.
            Model access and billing depend on your provider account.
          </p>
          {view.syncError && (
            <p className="settings-error" role="alert">
              {view.syncError}
            </p>
          )}
          {view.providers
            .filter((p) => p.configured)
            .map((p) => {
              const models = view.models.filter((m) =>
                m.id.startsWith(p.id + "/"),
              );
              return (
                <section
                  className="settings-card"
                  key={p.id}
                  aria-label={`${p.name} provider`}
                >
                  <div className="settings-card-heading">
                    <div>
                      <h3>{p.name}</h3>
                    </div>
                    <span className="settings-status connected">
                      Configured
                    </span>
                  </div>
                  <p>
                    Provider configured
                    {p.credentialType
                      ? ` · ${p.credentialType === "api" ? "API key" : "Provider sign-in"}`
                      : ""}
                    {p.source && p.source !== "unknown" ? ` · ${p.source}` : ""}
                  </p>
                  <details>
                    <summary>{models.length} models</summary>
                    <ul>
                      {models.map((m) => (
                        <li key={m.id}>
                          {m.name} <small>{m.id}</small>
                        </li>
                      ))}
                    </ul>
                  </details>
                  <div className="harness-provider-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => choose(p)}
                    >
                      Replace credential or reconnect
                    </button>
                    {p.removable && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          setRemoving(p);
                          setAdding(false);
                        }}
                      >
                        Remove saved credential
                      </button>
                    )}
                  </div>
                  {(p.source === "environment" ||
                    p.source === "configuration") && (
                    <p className="field-hint">
                      Managed in the harness environment or configuration. A
                      saved key follows the harness’s credential precedence.
                    </p>
                  )}
                </section>
              );
            })}
          {!view.providers.some((p) => p.configured) && (
            <p>No model provider credentials are configured.</p>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              const first =
                view.providers.find((p) => !p.configured) || view.providers[0];
              if (first) choose(first);
            }}
          >
            Add provider
          </button>
        </>
      )}
      {removing && (
        <section
          className="settings-card"
          aria-label="Remove provider credential"
        >
          <h3>
            Remove {removing.name} credential from {harnesses[runtime].label}?
          </h3>
          <p>
            Agents using this provider:{" "}
            {affected(removing.id)
              .map((a) => a.name)
              .join(", ") || "None"}
            .
          </p>
          <p>
            Other saved providers remain configured. Environment or
            configuration credentials may still be available. Review them before
            enabling this harness again.
          </p>
          <button
            disabled={busy || inspect}
            onClick={() =>
              void perform(async () => {
                setInspect(true);
                const next = await command(
                  ["provider-remove", runtime, projectId, removing.id],
                  (commandId) =>
                    callRoute(
                      workspaceApi.runtimeProviderRemove,
                      {
                        params: { name: runtime },
                        body: {
                          projectId: parseId(ProjectId, projectId),
                          provider: removing.id,
                          commandId,
                        },
                      },
                      sourceId,
                    ),
                );
                if (current()) {
                  setView(next);
                  setRemoving(undefined);
                  setInspect(false);
                }
                if (current()) await onChange();
              })
            }
          >
            Confirm removal
          </button>
          <button disabled={busy} onClick={() => setRemoving(undefined)}>
            Cancel
          </button>
        </section>
      )}
      {adding && view && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (selectedMethod?.type === "api") void saveKey();
            else setLogin({ provider, method });
          }}
        >
          <label>
            Provider
            <select
              aria-label="Model provider"
              value={provider}
              disabled={busy}
              onChange={(e) => {
                const p = view.providers.find((p) => p.id === e.target.value);
                if (p) choose(p);
              }}
            >
              {view.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Authentication
            <select
              value={method}
              disabled={busy}
              onChange={(e) => {
                setMethod(e.target.value);
                setSecret("");
              }}
            >
              {selected?.methods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {selected?.configured && (
            <p>
              Replacing this credential affects:{" "}
              {affected(provider)
                .map((a) => a.name)
                .join(", ") || "No existing agents"}
              .
            </p>
          )}
          {selectedMethod?.type === "api" && (
            <>
              <label>
                API key
                <input
                  {...literalEntry}
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  disabled={busy}
                  required
                />
              </label>
              <p className="field-hint">
                Saved by {harnesses[runtime].label} on {location}. API usage is
                billed by the provider.
              </p>
              {targets
                .filter((t) => t.name !== runtime)
                .map((t) => (
                  <label key={t.name}>
                    <input
                      type="checkbox"
                      checked={also.includes(t.name)}
                      disabled={busy}
                      onChange={(e) =>
                        setAlso(
                          e.target.checked
                            ? [...also, t.name]
                            : also.filter((n) => n !== t.name),
                        )
                      }
                    />
                    Also save this key in {t.label} on {location}
                  </label>
                ))}
            </>
          )}
          <button
            className="primary"
            disabled={
              busy ||
              inspect ||
              !selectedMethod ||
              (selectedMethod.type === "api" && !secret.trim())
            }
          >
            {selectedMethod?.type === "api"
              ? "Save key and refresh models"
              : "Continue provider sign-in"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setAdding(false);
              setSecret("");
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {!!results.length && (
        <ul role="status">
          {results.map((result, i) => (
            <li key={i}>{result}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {recoveries.map(({ label, failure, key }) => (
        <div key={key}>
          <h3>{label}</h3>
          <EffectRecovery
            failure={failure}
            onReady={() => {
              if (!current()) return;
              setRecoveries((previous) =>
                previous.filter((entry) => entry.failure !== failure),
              );
              setInspect(false);
              setNotice(
                "No new command was sent. Use the action again when you are ready.",
              );
            }}
          />
        </div>
      ))}
      {inspect && (
        <p>
          Refresh provider status before starting another credential change. An
          unconfirmed change is never submitted again automatically.
        </p>
      )}
      <div className="harness-provider-actions">
        <button
          type="button"
          className={view?.enabled ? "secondary" : "primary"}
          disabled={busy || inspect || !view}
          onClick={() => void refresh()}
        >
          {refreshing
            ? "Refreshing…"
            : `${view?.enabled ? "Refresh" : "Enable"} ${harnesses[runtime].label}`}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await load();
              for (const t of targets.filter((t) => also.includes(t.name)))
                await catalog(t.name, t.projectId);
              if (current()) setInspect(false);
              if (current()) setNotice("Provider status checked.");
            })
          }
        >
          Refresh provider status
        </button>
      </div>
      <div className="harness-refresh-confirmation" role="status">
        {notice && <p>{notice}</p>}
      </div>
      <p className="field-hint">Provider credentials stay on {location}.</p>
    </section>
  );
}
