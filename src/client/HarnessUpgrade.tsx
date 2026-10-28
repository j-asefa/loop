import { useEffect, useState } from "react";
import {
  workspaceApi,
  type RouteInput,
  type RouteResponse,
} from "../shared/workspace-api";
import { callRoute, readRoute } from "./workspace-api";
import { useSourceId } from "./SourceContext";
type UpgradeView = RouteResponse<typeof workspaceApi.runtimeUpgrade>;
type Target = {
  runtime: RouteInput<typeof workspaceApi.runtimeUpgrade>["params"]["name"];
};

export function HarnessUpgrade({
  runtime,
  label,
  generation,
  disabled,
  onComplete,
}: Target & {
  label: string;
  generation?: number;
  disabled?: boolean;
  onComplete?: () => void;
}) {
  const sourceId = useSourceId();
  const [upgrade, setUpgrade] = useState<UpgradeView["upgrade"]>();
  const [availability, setAvailability] =
    useState<Pick<UpgradeView, "canUpgrade" | "upgradeHelp">>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(0);
  const [confirmedStopped, setConfirmedStopped] = useState(false);
  useEffect(
    () => setConfirmedStopped(false),
    [runtime, generation, upgrade?.commandId],
  );
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await readRoute(
          workspaceApi.runtimeUpgrade,
          { params: { name: runtime } },
          sourceId,
          controller.signal,
          () =>
            setError(
              "Upgrade status unavailable. Check status before starting another upgrade.",
            ),
        );
        if (!current) return;
        setUpgrade(value.upgrade);
        setAvailability(value);
        setError("");
        if (value.upgrade?.state === "running") timer = setTimeout(poll, 1500);
      } catch {
        if (current)
          setError(
            "Upgrade status unavailable. Check status before starting another upgrade.",
          );
      }
    }
    void poll();
    return () => {
      current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [runtime, sourceId, checking]);
  useEffect(() => {
    if (upgrade?.state === "complete") onComplete?.();
    // Refresh once per confirmed operation, not on every parent's render.
  }, [upgrade?.commandId, upgrade?.state]);
  return (
    <div>
      <button
        type="button"
        className="text-button"
        disabled={
          disabled ||
          !availability?.canUpgrade ||
          sending ||
          upgrade === undefined ||
          upgrade?.state === "running" ||
          upgrade?.state === "unconfirmed" ||
          upgrade?.state === "restart-required" ||
          !!error
        }
        onClick={async () => {
          setSending(true);
          setError("");
          try {
            const commandId = crypto.randomUUID();
            const value = await callRoute(
              workspaceApi.runtimeUpgradeStart,
              { params: { name: runtime }, body: { commandId } },
              sourceId,
            );
            setUpgrade(value.upgrade);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setSending(false);
            setChecking((n) => n + 1);
          }
        }}
      >
        {sending || upgrade?.state === "running"
          ? `Upgrading ${label}…`
          : `Upgrade ${label}`}
      </button>
      {availability?.upgradeHelp && (
        <p className="note">{availability.upgradeHelp}</p>
      )}
      {upgrade && (
        <p role="status">
          {upgrade.message}
          {(upgrade.state === "complete" || upgrade.state === "failed") && (
            <>
              {" "}
              <button
                type="button"
                className="text-button"
                disabled={sending}
                onClick={async () => {
                  setSending(true);
                  setError("");
                  try {
                    await callRoute(
                      workspaceApi.runtimeUpgradeDismiss,
                      { params: { name: runtime } },
                      sourceId,
                    );
                    setUpgrade(null);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setSending(false);
                  }
                }}
              >
                Dismiss
              </button>
            </>
          )}
        </p>
      )}
      {upgrade?.state === "unconfirmed" && (
        <div>
          <label>
            <input
              type="checkbox"
              checked={confirmedStopped}
              onChange={(e) => setConfirmedStopped(e.target.checked)}
            />
            I stopped remaining installer processes and checked this
            installation on the computer.
          </label>
          <button
            type="button"
            disabled={!confirmedStopped || sending}
            onClick={async () => {
              setSending(true);
              try {
                const body = {
                  confirmedStopped: true as const,
                  commandId: upgrade.commandId,
                };
                const value = await callRoute(
                  workspaceApi.runtimeUpgradeRecover,
                  { params: { name: runtime }, body },
                  sourceId,
                );
                setUpgrade(value.upgrade);
                setConfirmedStopped(false);
                setError("");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSending(false);
              }
            }}
          >
            Confirm recovery
          </button>
        </div>
      )}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button
            type="button"
            onClick={() => {
              setError("");
              setChecking((n) => n + 1);
            }}
          >
            Check upgrade status
          </button>
        </>
      )}
    </div>
  );
}
