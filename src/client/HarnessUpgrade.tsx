import { useEffect, useState } from "react";
import { api } from "./api";
import type { Upgrade } from "../harness-upgrades";

export function HarnessUpgrade({
  base,
  label,
  generation,
  disabled,
  onComplete,
}: {
  base: string;
  label: string;
  generation?: number;
  disabled?: boolean;
  onComplete?: () => void;
}) {
  const [upgrade, setUpgrade] = useState<Upgrade | null>();
  const [availability, setAvailability] = useState<{
    canUpgrade: boolean;
    upgradeHelp: string;
  }>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(0);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await api<{
          upgrade: Upgrade | null;
          canUpgrade: boolean;
          upgradeHelp: string;
        }>(base);
        if (!current) return;
        setUpgrade(value.upgrade);
        setAvailability(value);
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
      clearTimeout(timer);
    };
  }, [base, checking]);
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
          !!error
        }
        onClick={async () => {
          setSending(true);
          setError("");
          try {
            const value = await api<{ upgrade: Upgrade }>(base, {
              commandId: crypto.randomUUID(),
              ...(generation === undefined ? {} : { generation }),
            });
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
          {upgrade.state !== "running" && (
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
                    await api(base, undefined, "DELETE");
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
