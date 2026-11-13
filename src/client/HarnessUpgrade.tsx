import { ExecutionCommandId } from "../shared/contract-ids.js";
import { useEffect, useState, useRef } from "react";
import {
  workspaceApi,
  type RouteInput,
  type RouteResponse,
} from "../shared/workspace-api";
import { callRoute, readRoute } from "./api";
import { performStoredEffect, settleStoredEffect } from "./pendingCommands";
import { useSourceId } from "./SourceContext";
import { viewGeneration, viewOwner } from "./viewCache";
type UpgradeView = RouteResponse<typeof workspaceApi.runtimeUpgrade>;
type Target = {
  runtime: RouteInput<typeof workspaceApi.runtimeUpgrade>["params"]["name"];
};

type Props = Target & {
  label: string;
  generation?: number;
  disabled?: boolean;
  onComplete?: () => void;
};
export function HarnessUpgrade(props: Props) {
  const sourceId = useSourceId();
  return (
    <HarnessUpgradeControls
      key={`${sourceId}:${props.runtime}:${props.generation}:${viewGeneration()}`}
      {...props}
      sourceId={sourceId}
    />
  );
}
function HarnessUpgradeControls({
  runtime,
  label,
  generation,
  disabled,
  onComplete,
  sourceId,
}: Props & { sourceId: string }) {
  const owner = viewOwner();
  const epoch = viewGeneration();
  const mounted = useRef(false);
  const canStart = useRef(!disabled);
  canStart.current = !disabled;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () =>
    mounted.current && owner === viewOwner() && epoch === viewGeneration();
  const [upgrade, setUpgrade] = useState<UpgradeView["upgrade"]>();
  const [availability, setAvailability] =
    useState<Pick<UpgradeView, "canUpgrade" | "upgradeHelp">>();
  const [release, setRelease] = useState<UpgradeView>();
  const [checkingRelease, setCheckingRelease] = useState(false);
  const releaseRequested = useRef(false);
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
    if (disabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const check = !releaseRequested.current;
      if (check) setCheckingRelease(true);
      try {
        const value = await readRoute(
          workspaceApi.runtimeUpgrade,
          { params: { name: runtime }, query: check ? { check: "1" } : {} },
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
        if (check) {
          releaseRequested.current = true;
          setRelease(value);
        }
        setError("");
        if (value.upgrade?.state === "running") timer = setTimeout(poll, 1500);
      } catch {
        if (current)
          setError(
            "Upgrade status unavailable. Check status before starting another upgrade.",
          );
      } finally {
        if (current) setCheckingRelease(false);
      }
    }
    void poll();
    return () => {
      current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [runtime, sourceId, checking, disabled]);
  useEffect(() => {
    if (upgrade?.state === "complete") {
      releaseRequested.current = false;
      setChecking((n) => n + 1);
      onComplete?.();
    }
    // A settled upgrade has consumed its command id; a fresh start later must
    // get a new one rather than dedupe onto the finished installer.
    if (upgrade?.state === "complete" || upgrade?.state === "failed")
      void settleStoredEffect(
        localStorage,
        owner,
        sourceId,
        ["runtime-upgrade", runtime],
        { commandId: upgrade.commandId },
      );
    // Refresh once per confirmed operation, not on every parent's render.
  }, [upgrade?.commandId, upgrade?.state]);
  return (
    <div aria-label={`${label} updates`}>
      {release?.latestVersion && (
        <p role="status">
          {release.updateAvailable
            ? `Update available: ${release.installedVersion} → ${release.latestVersion}`
            : release.updateAvailable === false
              ? `No newer release found: ${release.installedVersion}`
              : `Latest release: ${release.latestVersion}`}
        </p>
      )}
      {release?.checkedAt && (
        <p className="field-hint">
          Checked {new Date(release.checkedAt).toLocaleTimeString()}. Checks are
          cached for five minutes.
        </p>
      )}
      {release?.checkHelp && <p className="note">{release.checkHelp}</p>}
      {availability?.canUpgrade !== false && (
        <button
          type="button"
          className="text-button"
          disabled={
            disabled ||
            checkingRelease ||
            sending ||
            upgrade?.state === "running" ||
            upgrade?.state === "unconfirmed" ||
            upgrade?.state === "restart-required"
          }
          onClick={() => {
            releaseRequested.current = false;
            setChecking((n) => n + 1);
          }}
        >
          {checkingRelease ? "Checking for updates…" : "Check for updates"}
        </button>
      )}
      <button
        type="button"
        className="text-button"
        disabled={
          disabled ||
          !availability?.canUpgrade ||
          sending ||
          checkingRelease ||
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
            const value = await performStoredEffect(
              localStorage,
              owner,
              sourceId,
              ["runtime-upgrade", runtime],
              () => current() && canStart.current,
              (commandId) =>
                callRoute(
                  workspaceApi.runtimeUpgradeStart,
                  {
                    params: { name: runtime },
                    body: { commandId: ExecutionCommandId.parse(commandId) },
                  },
                  sourceId,
                ),
            );
            if (!current()) return;
            setUpgrade(value.upgrade);
            setRelease(undefined);
          } catch (e) {
            if (current()) setError((e as Error).message);
          } finally {
            if (current()) {
              setSending(false);
              setChecking((n) => n + 1);
            }
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
      {availability?.canUpgrade && (
        <p className="field-hint">
          Finish active runs and sign-in before upgrading. The installer checks
          the latest release again when you upgrade.
        </p>
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
