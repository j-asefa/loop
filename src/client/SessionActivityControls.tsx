import { listenWorkspaceChanges } from "./workspace-changes";
import { useSourceId, useSourceApi, useSourceRead } from "./SourceContext";
import { surfaceFallback } from "./workspace-projections";
import { useEffect, useRef, useState } from "react";
import type {
  ActivityCapabilities,
  SettingsData,
  SettingValue,
  ActivityRecord,
} from "../agent-activities";
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
  const api = useSourceApi();
  const read = useSourceRead();
  const readController = useRef<AbortController | null>(null);
  const sourceId = useSourceId();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Controls>();
  const [pending, setPending] = useState<{ id: string; value: SettingValue }>();
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [failedChange, setFailedChange] = useState<{ id: string; value: SettingValue; inspected?: boolean }>();
  const [inspecting, setInspecting] = useState(false);
  const epoch = useRef(0),
    ticket = useRef(0),
    writing = useRef(false);
  const path = `/conversations/${encodeURIComponent(conversationId)}/settings`;
  const saved = useRef(recorded);
  const commands = useRef(new Map<string, string>());
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
    const controller = readController.current;
    if (writing.current || !controller || controller.signal.aborted) return;
    const own = epoch.current,
      request = ++ticket.current;
    try {
      const response = await read<Controls>(path, controller.signal);
      const next =
        response.state !== "disconnected" &&
        response.capabilities.settings.state === "supported"
          ? response
          : readOnlySnapshot() || { ...response, readOnly: true };
      if (own === epoch.current && request === ticket.current) {
        setReadError("");
        setData((old) =>
          old &&
          !old.readOnly &&
          !next.readOnly &&
          old.generation === next.generation &&
          old.settings.revision > next.settings.revision
            ? old
            : next,
        );
        return next;
      }
    } catch (e) {
      if (own === epoch.current && request === ticket.current) {
        const snapshot = readOnlySnapshot();
        if (snapshot) {
          setData(snapshot);
          setReadError("");
        } else {
          setData((old) => (old ? { ...old, readOnly: true } : undefined));
          setReadError((e as Error).message);
        }
      }
    }
  }
  useEffect(() => {
    epoch.current++;
    setData(undefined);
    setPending(undefined);
    setError("");
    setReadError("");
    setFailedChange(undefined);
    setInspecting(false);
    writing.current = false;
    if (!open) return;
    const controller = new AbortController();
    readController.current = controller;
    void refresh();
    const update = () => void refresh();
    const stopFallback = surfaceFallback([sourceId], "workspace", 3000, update);
    const stopChanges = listenWorkspaceChanges("activities", update, sourceId, conversationId);
    return () => {
      epoch.current++;
      controller.abort();
      readController.current = null;
      stopFallback();
      stopChanges();
    };
  }, [open, conversationId, sourceId, read]);
  async function inspect() {
    const failure = failedChange, own = epoch.current;
    setInspecting(true);
    try {
      const next = await refresh();
      if (next && own === epoch.current)
        setFailedChange(current => current === failure && current ? { ...current, inspected: true } : current);
    } finally {
      if (own === epoch.current) setInspecting(false);
    }
  }
  async function change(id: string, value: SettingValue, newAttempt = false) {
    if (!data || data.readOnly || !data.generation || writing.current) return;
    const own = epoch.current;
    writing.current = true;
    ticket.current++;
    setPending({ id, value });
    setError("");
    setFailedChange(undefined);
    const commandKey = JSON.stringify([sourceId, conversationId, data.generation, data.settings.revision, id, value]);
    if (newAttempt) commands.current.delete(commandKey);
    const commandId = commands.current.get(commandKey) || crypto.randomUUID();
    commands.current.set(commandKey, commandId);
    try {
      const next = await api<Controls>(
        `${path}/${encodeURIComponent(id)}`,
        {
          value,
          revision: data.settings.revision,
          generation: data.generation,
          commandId,
        },
        "PATCH",
      );
      if (own === epoch.current) {
        commands.current.delete(commandKey);
        setData(next);
        window.dispatchEvent(new Event("loop-workspace-change"));
      }
    } catch (e) {
      if (own === epoch.current) {
        setError((e as Error).message);
        setFailedChange({ id, value });
      }
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
        <Sheet
          className="settings-sheet"
          title="Session settings"
          onClose={() => setOpen(false)}
        >
          <p className="note">
            {data?.readOnly
              ? "Recorded session settings. Reconnect to discover current controls."
              : "Confirmed values come from the running session. A request is not effective until the runtime confirms it."}
          </p>
          {(error || readError) && (
            <p role="alert" className="error">
              {error || readError}
            </p>
          )}
          {failedChange && (
            <p className="note">
              {failedChange.inspected ? "Session status is up to date. Apply the setting again if needed." : "Refresh session status before applying the setting again."}
              {failedChange.inspected && (
                <button
                  type="button"
                  disabled={!!pending || inspecting || !data || data.readOnly || !data.generation || data.capabilities.settings.state !== "supported" || !data.settings.options.find(option => option.id === failedChange.id)?.mutable}
                  onClick={() => void change(failedChange.id, failedChange.value, true)}
                >Apply setting again</button>
              )}
            </p>
          )}
          {!data && !error && !readError && (
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
                        value={String(
                          pending?.id === option.id
                            ? pending.value
                            : (option.requested ?? option.confirmed ?? ""),
                        )}
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
                        defaultValue={String(
                          option.requested ?? option.confirmed ?? "",
                        )}
                        disabled={
                          data.readOnly ||
                          !!pending ||
                          !option.mutable ||
                          data.capabilities.settings.state !== "supported"
                        }
                        onBlur={(e) => {
                          const requested = e.target.value;
                          const displayed = String(
                            option.requested ?? option.confirmed ?? "",
                          );
                          // Rejection before adapter dispatch may leave the revision unchanged.
                          e.target.value = displayed;
                          if (requested !== displayed)
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
                  {(pending?.id === option.id || option.requested != null) && (
                    <p role="status">
                      {option.application === "new-session"
                        ? "Launch value: "
                        : "Requested: "}
                      {String(
                        pending?.id === option.id
                          ? pending.value
                          : option.requested,
                      )}{" "}
                      {option.application === "new-session"
                        ? " · set when this session started"
                        : option.application === "next-turn"
                          ? " · applies on the next turn"
                          : data.readOnly
                            ? " · session disconnected before confirmation"
                            : " · awaiting confirmation"}
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
            disabled={!!pending || inspecting}
            onClick={() => {
              if (failedChange) void inspect();
              else {
                setError("");
                void refresh();
              }
            }}
          >
            Refresh session
          </button>
        </Sheet>
      )}
    </>
  );
}
