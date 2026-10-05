import { useEffect, useState } from "react";
import { HarnessUpgrade } from "./HarnessUpgrade";
import { api } from "./api";

export function managedRuntimeName(flavor: string) {
  return (
    (
      {
        codex: "Codex",
        claude: "Claude Code",
        opencode: "OpenCode",
        pi: "Pi",
      } as Record<string, string>
    )[flavor] ?? flavor
  );
}

type Environment = {
  id: string;
  name: string;
  state: string;
  generation: number;
  revoked_at?: number;
};
type Runtime = {
  flavor: string;
  installed: boolean;
  authentication: "unknown" | "signed_in" | "signed_out";
  billing: string;
  checkedAt: number;
};
type UsageWindow = { usedPercent: number; resetsAt: string | null };
type SubscriptionUsage = {
  codex: {
    status: string;
    observedAt?: string;
    rateLimits?: { primary?: UsageWindow; secondary?: UsageWindow };
    rateLimitsByLimitId?: Record<string, { limitName?: string; primary?: UsageWindow; secondary?: UsageWindow }>;
  };
  claude: { status: string; observedAt?: string; fiveHour?: UsageWindow; sevenDay?: UsageWindow };
};

function WindowUsage({ label, value }: { label: string; value?: UsageWindow | null }) {
  if (!value) return null;
  return <p>{label}: {Math.round(value.usedPercent)}% used{value.resetsAt ? ` · resets ${new Date(value.resetsAt).toLocaleString()}` : ""}</p>;
}

export function EnvironmentRuntimeCard({
  environment,
}: {
  environment: Environment;
}) {
  return (
    <RuntimeCard
      key={`${environment.id}:${environment.generation}:${environment.state}:${environment.revoked_at}`}
      environment={environment}
    />
  );
}
function RuntimeCard({ environment }: { environment: Environment }) {
  const [runtimes, setRuntimes] = useState<Runtime[]>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [usage, setUsage] = useState<SubscriptionUsage>();
  const [usageBusy, setUsageBusy] = useState(false);
  const [usageError, setUsageError] = useState("");
  // Checking is explicit: inspecting a native account can launch a CLI.
  useEffect(() => {
    if (!checking) return;
    let current = true;
    api<{ runtimes: Runtime[] }>(`/environments/${environment.id}/runtimes`)
      .then(
        (value) => {
          if (current) setRuntimes(value.runtimes);
        },
        () => {
          if (current) {
            setRuntimes(undefined);
            setError(
              "Runtime check unavailable. Installation and sign-in are unknown.",
            );
          }
        },
      )
      .finally(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [checking, environment.id]);
  return (
    <section
      className="native-runtime"
      aria-label={`${environment.name} runtimes`}
    >
      <h3>
        {environment.name} · {environment.state}
      </h3>
      <p>Sign-in stays on this environment.</p>
      {!runtimes && <p>Installation and sign-in have not been checked.</p>}
      {runtimes?.map((runtime) => (
        <div key={runtime.flavor}>
          <strong>{managedRuntimeName(runtime.flavor)}</strong>
          <p>
            {runtime.installed
              ? "Executable available"
              : "Executable unavailable"}{" "}
            ·{" "}
            {runtime.authentication === "signed_in"
              ? "Signed in"
              : runtime.authentication === "signed_out"
                ? "Sign-in required"
                : "Sign-in unknown"}
          </p>
          <HarnessUpgrade base={`/environments/${environment.id}/runtimes/${runtime.flavor}/upgrade`}
            label={managedRuntimeName(runtime.flavor)} generation={environment.generation}
            disabled={!runtime.installed || environment.state !== "online" || !!environment.revoked_at} />
          <p>Billing policy: {runtime.billing}</p>
          <small>
            Checked {new Date(runtime.checkedAt).toLocaleString()}.
            Authentication is checked again before use.
          </small>
        </div>
      ))}
      {runtimes?.length === 0 && (
        <p>No supported runtimes configured on this environment.</p>
      )}
      {usage && <div aria-label="Subscription usage">
        <h4>Subscription usage</h4>
        <strong>Codex</strong>
        {usage.codex.status === "live" ? <>
          <WindowUsage label="Primary window" value={usage.codex.rateLimits?.primary} />
          <WindowUsage label="Secondary window" value={usage.codex.rateLimits?.secondary} />
          {Object.entries(usage.codex.rateLimitsByLimitId || {}).map(([id, limit]) =>
            <div key={id}>
              <span>{limit.limitName || id}</span>
              <WindowUsage label="Primary window" value={limit.primary} />
              <WindowUsage label="Secondary window" value={limit.secondary} />
            </div>
          )}
        </> : <p>Unavailable from the signed-in Codex app-server.</p>}
        <strong>Claude Code</strong>
        {usage.claude.status === "cached" ? <>
          <WindowUsage label="Five hours" value={usage.claude.fiveHour} />
          <WindowUsage label="Seven days" value={usage.claude.sevenDay} />
          <small>Last sampled {usage.claude.observedAt ? new Date(usage.claude.observedAt).toLocaleString() : "at an unknown time"} by Claude Code.</small>
        </> : <p>No Claude Code rate-limit sample is available yet.</p>}
      </div>}
      <button
        type="button"
        disabled={usageBusy || environment.state !== "online" || !!environment.revoked_at}
        onClick={() => {
          setUsageBusy(true);
          setUsageError("");
          api<SubscriptionUsage>(`/environments/${environment.id}/subscription-usage`)
            .then(setUsage, () => setUsageError("Subscription usage could not be read."))
            .finally(() => setUsageBusy(false));
        }}
      >{usageBusy ? "Reading usage…" : "Read subscription usage"}</button>
      {usageError && <p role="status">{usageError}</p>}
      <button
        type="button"
        disabled={
          checking || environment.state !== "online" || !!environment.revoked_at
        }
        onClick={() => {
          setError("");
          setRuntimes(undefined);
          setChecking(true);
        }}
      >
        {checking ? "Checking runtimes…" : "Check installation and sign-in"}
      </button>
      {error && <p role="status">{error}</p>}
    </section>
  );
}

export function EnvironmentRuntimes() {
  const [items, setItems] = useState<Environment[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    api<Environment[]>("/environments").then(
      (rows) => {
        if (current) setItems(rows);
      },
      () => {
        if (current) setError("Execution environments could not be loaded.");
      },
    );
    return () => {
      current = false;
    };
  }, []);
  return (
    <details>
      <summary>Managed execution environments</summary>
      {items?.map((environment) => (
        <EnvironmentRuntimeCard
          key={environment.id}
          environment={environment}
        />
      ))}
      {items?.length === 0 && (
        <p>
          No managed environment connected. Runtime setup shows preparation or
          direct fallback.
        </p>
      )}
      {!items && !error && <p>Loading environments…</p>}
      {error && <p role="status">{error}</p>}
      <p>
        Manage environment sign-in in Settings → Execution environments.
        Verified connections appear in the runtime picker.
      </p>
    </details>
  );
}
