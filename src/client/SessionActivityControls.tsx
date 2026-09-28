import { useEffect, useRef, useState } from "react";
import type {
  ActivityCapabilities,
  SettingsData,
  SettingValue,
  ActivityRecord,
} from "../agent-activities";
import { api } from "./api";
import { Sheet } from "./components";
type Controls = {
  readOnly?: boolean;
  state?: string;
  generation?: string;
  settings: SettingsData;
  capabilities: ActivityCapabilities;
};
export function SessionActivityControls({
  conversationId,
  recorded,
}: {
  conversationId: string;
  recorded?: {
    settings?: ActivityRecord;
    capabilities?: ActivityCapabilities;
    capabilityGeneration?: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Controls>();
  const [pending, setPending] = useState<{ id: string; value: SettingValue }>();
  const [error, setError] = useState("");
  const epoch = useRef(0),
    ticket = useRef(0),
    writing = useRef(false);
  const path = `/conversations/${encodeURIComponent(conversationId)}/settings`;
  const saved = useRef(recorded);
  saved.current = recorded;
  function readOnlySnapshot(): Controls | undefined {
    const record = saved.current?.settings;
    const capabilities = saved.current?.capabilities;
    if (
      record?.kind !== "settings" ||
      !capabilities ||
      record.generation !== saved.current?.capabilityGeneration
    )
      return;
    return {
      readOnly: true,
      generation: record.generation,
      capabilities,
      settings: {
        ...record.data,
        options: record.data.options.map((option) => ({
          ...option,
          mutable: false,
          reason:
            "Recorded settings. Reconnect the native session to change them.",
        })),
      },
    };
  }
  async function refresh() {
    if (writing.current) return;
    const own = epoch.current,
      request = ++ticket.current;
    try {
      const response = await api<Controls>(path);
      const next =
        response.state !== "disconnected" &&
        response.capabilities.settings.state === "supported"
          ? response
          : readOnlySnapshot() || { ...response, readOnly: true };
      if (own === epoch.current && request === ticket.current)
        setData((old) =>
          old &&
          !old.readOnly &&
          !next.readOnly &&
          old.generation === next.generation &&
          old.settings.revision > next.settings.revision
            ? old
            : next,
        );
    } catch (e) {
      if (own === epoch.current && request === ticket.current) {
        const snapshot = readOnlySnapshot();
        if (snapshot) {
          setData(snapshot);
          setError("");
        } else {
          setData(undefined);
          setError((e as Error).message);
        }
      }
    }
  }
  useEffect(() => {
    epoch.current++;
    setData(undefined);
    setPending(undefined);
    setError("");
    writing.current = false;
    if (!open) return;
    void refresh();
    const update = () => void refresh();
    const timer = setInterval(update, 3000);
    window.addEventListener("loop-workspace-change", update);
    return () => {
      epoch.current++;
      clearInterval(timer);
      window.removeEventListener("loop-workspace-change", update);
    };
  }, [open, conversationId]);
  async function change(id: string, value: SettingValue) {
    if (!data || data.readOnly || !data.generation || writing.current) return;
    const own = epoch.current;
    writing.current = true;
    ticket.current++;
    setPending({ id, value });
    setError("");
    try {
      const next = await api<Controls>(
        `${path}/${encodeURIComponent(id)}`,
        {
          value,
          revision: data.settings.revision,
          generation: data.generation,
        },
        "PATCH",
      );
      if (own === epoch.current) {
        setData(next);
        window.dispatchEvent(new Event("loop-workspace-change"));
      }
    } catch (e) {
      if (own === epoch.current) setError((e as Error).message);
    } finally {
      if (own === epoch.current) {
        writing.current = false;
        setPending(undefined);
        void refresh();
      }
    }
  }
  return (
    <>
      <button className="text-button" onClick={() => setOpen(true)}>
        Session settings
      </button>
      {open && (
        <Sheet title="Session settings" onClose={() => setOpen(false)}>
          <p className="note">
            {data?.readOnly
              ? "Recorded session settings. Reconnect to discover current controls."
              : "Confirmed values come from the running session. A request is not effective until the runtime confirms it."}
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {!data && !error && (
            <p role="status">Discovering session controls…</p>
          )}
          {data && (
            <>
              <p className="note">
                {data.capabilities.settings.state} ·{" "}
                {data.capabilities.settings.source}
                {data.capabilities.settings.reason
                  ? ` · ${data.capabilities.settings.reason}`
                  : ""}
              </p>
              {data.settings.options.map((option) => (
                <section className="activity-panel" key={option.id}>
                  <label>
                    {option.label || option.id}
                    {option.type === "select" ? (
                      <select
                        aria-label={option.label || option.id}
                        disabled={
                          data.readOnly ||
                          !!pending ||
                          !option.mutable ||
                          data.capabilities.settings.state !== "supported"
                        }
                        value={
                          option.confirmed === undefined
                            ? ""
                            : String(option.confirmed)
                        }
                        onChange={(e) => void change(option.id, e.target.value)}
                      >
                        <option value="" disabled>
                          Not confirmed
                        </option>
                        {option.confirmed !== undefined &&
                          !option.choices?.some(
                            (c) => c.value === String(option.confirmed),
                          ) && (
                            <option value={String(option.confirmed)}>
                              {String(option.confirmed)}
                            </option>
                          )}
                        {option.choices?.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    ) : option.type === "boolean" ? (
                      <input
                        type="checkbox"
                        checked={option.confirmed === true}
                        disabled={
                          data.readOnly ||
                          !!pending ||
                          !option.mutable ||
                          data.capabilities.settings.state !== "supported"
                        }
                        onChange={(e) =>
                          void change(option.id, e.target.checked)
                        }
                      />
                    ) : (
                      <input
                        key={`${data.generation}:${data.settings.revision}:${option.id}`}
                        defaultValue={String(option.confirmed ?? "")}
                        disabled={
                          data.readOnly ||
                          !!pending ||
                          !option.mutable ||
                          data.capabilities.settings.state !== "supported"
                        }
                        onBlur={(e) => {
                          const requested = e.target.value;
                          const confirmed = String(option.confirmed ?? "");
                          // Rejection before adapter dispatch may leave the revision unchanged.
                          e.target.value = confirmed;
                          if (requested !== confirmed)
                            void change(option.id, requested);
                        }}
                      />
                    )}
                  </label>
                  <p>
                    Confirmed:{" "}
                    {option.confirmed === undefined
                      ? "Not reported"
                      : String(option.confirmed)}
                  </p>
                  {(pending?.id === option.id ||
                    option.requested != null) && (
                    <p role="status">
                      Requested:{" "}
                      {String(
                        pending?.id === option.id
                          ? pending.value
                          : option.requested,
                      )}{" "}
                      · awaiting confirmation
                    </p>
                  )}
                  {option.rejected && (
                    <p role="alert">Rejected: {option.rejected}</p>
                  )}
                  <p className="note">
                    {option.application || "Application timing not reported"} ·{" "}
                    {option.provenance || data.capabilities.settings.source}
                    {option.reason ? ` · ${option.reason}` : ""}
                  </p>
                  {option.description && <p>{option.description}</p>}
                </section>
              ))}
              {!data.settings.options.length && (
                <p>No session options reported.</p>
              )}
            </>
          )}
          <button
            disabled={!!pending}
            onClick={() => {
              setError("");
              void refresh();
            }}
          >
            Refresh session
          </button>
        </Sheet>
      )}
    </>
  );
}
