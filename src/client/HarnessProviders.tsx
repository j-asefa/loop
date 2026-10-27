import { useEffect, useRef, useState } from "react";
import { workspaceApi } from "../shared/workspace-api";
import type { NativeProviderView } from "../shared/native-providers";
import { useSourceId, useProjectionRoute } from "./SourceContext";
import { callRoute } from "./workspace-api";
import { RuntimeSignIn } from "./RuntimeSignIn";

type Harness = "pi" | "opencode";
type Target = { name: Harness; label: string; projectId: string };
type Provider = NativeProviderView["providers"][number];
const labels = { pi: "Pi", opencode: "OpenCode" };

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
  const [results, setResults] = useState<string[]>([]);
  const [inspect, setInspect] = useState(false);
  const mounted = useRef(true);
  const selected = view?.providers.find((p) => p.id === provider);
  const selectedMethod = selected?.methods.find((m) => m.id === method);
  const affected = (id: string) =>
    view?.agents.filter(
      (a) => a.model === "native-default" || a.model.startsWith(id + "/"),
    ) || [];
  const catalog = (name: Harness, project: string) =>
    read(workspaceApi.runtimeProviders, {
      params: { name },
      query: { projectId: project },
    });
  async function load() {
    const next = await catalog(runtime, projectId);
    if (mounted.current) setView(next);
    return next;
  }
  useEffect(() => {
    mounted.current = true;
    void load().catch(() => {
      if (mounted.current)
        setError("Could not load providers. Refresh to try again.");
    });
    return () => {
      mounted.current = false;
    };
  }, [runtime, projectId, sourceId]);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function refresh(useProviderBilling = false) {
    setLogin(undefined);
    await perform(async () => {
      const next = await callRoute(
        workspaceApi.runtimeProviderRefresh,
        {
          params: { name: runtime },
          body: {
            projectId,
            useProviderBilling,
            commandId: crypto.randomUUID(),
          },
        },
        sourceId,
      );
      if (mounted.current) {
        setView(next);
        setInspect(false);
      }
      await onChange();
    });
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
      const outcomes: string[] = [];
      let failed = false;
      // Each native credential store gets a separate durable command. A partial
      // success is displayed as such, and no failed/uncertain write is replayed.
      for (const target of [
        { name: runtime, projectId, label: labels[runtime] },
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
          const next = await callRoute(
            workspaceApi.runtimeProviderKey,
            {
              params: { name: target.name },
              body: {
                projectId: target.projectId,
                provider,
                method: targetMethod,
                secret: key,
                commandId: crypto.randomUUID(),
              },
            },
            sourceId,
          );
          outcomes.push(
            `${target.label}: key saved. ${next.syncError || (next.billing === "subscription" ? "Models refreshed under the saved subscription-only restriction." : "Models refreshed.")}`,
          );
          if (mounted.current && target.name === runtime) setView(next);
        } catch (e) {
          failed = true;
          outcomes.push(
            `${target.label}: change unconfirmed. ${(e as Error).message}`,
          );
        }
        if (mounted.current) setResults([...outcomes]);
      }
      if (mounted.current) {
        setInspect(failed);
        if (!failed) setAdding(false);
      }
      await onChange();
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
          label={labels[runtime]}
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
              await onChange();
            });
          }}
        />
      </>
    );
  return (
    <section aria-label={`${labels[runtime]} providers`}>
      <p>
        {labels[runtime]} saves provider credentials on {location}. Provider
        billing and account limits apply.
      </p>
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
          <p className="field-hint">
            {view.enabled ? "Enabled in Loop" : "Not enabled in Loop"} · Catalog
            checked {new Date(view.updatedAt).toLocaleTimeString()}. Model
            discovery does not verify account entitlement.
          </p>
          {view.syncError && <p role="status">{view.syncError}</p>}
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
                  <h3>{p.name}</h3>
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
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => choose(p)}
                  >
                    Replace credential or reconnect
                  </button>
                  {p.removable && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setRemoving(p);
                        setAdding(false);
                      }}
                    >
                      Remove saved credential
                    </button>
                  )}
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
            Remove {removing.name} credential from {labels[runtime]}?
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
                const next = await callRoute(
                  workspaceApi.runtimeProviderRemove,
                  {
                    params: { name: runtime },
                    body: {
                      projectId,
                      provider: removing.id,
                      commandId: crypto.randomUUID(),
                    },
                  },
                  sourceId,
                );
                if (mounted.current) {
                  setView(next);
                  setRemoving(undefined);
                  setInspect(false);
                }
                await onChange();
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
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  disabled={busy}
                  required
                />
              </label>
              <p className="field-hint">
                Saved by {labels[runtime]} on {location}. API usage is billed by
                the provider.
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
      {inspect && (
        <p>
          Refresh provider status before starting another credential change. An
          unconfirmed change is never submitted again automatically.
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void perform(async () => {
            await load();
            for (const t of targets.filter((t) => also.includes(t.name)))
              await catalog(t.name, t.projectId);
            if (mounted.current) setInspect(false);
          })
        }
      >
        Refresh provider status
      </button>
      <button
        type="button"
        disabled={busy || inspect || !view}
        onClick={() => void refresh()}
      >
        Refresh models and enable {labels[runtime]}
      </button>
    </section>
  );
}
