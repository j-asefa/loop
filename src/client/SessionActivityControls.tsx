import {
  NativeGenerationId,
  SessionSettingId,
} from "../shared/contract-ids.js";
import { ExecutionCommandId } from "../shared/contract-ids.js";
import { ConversationId } from "../shared/contract-ids.js";
import { literalEntry } from "./textEntry";
import { performStoredEffect, UncertainEffect } from "./pendingCommands";
import { viewGeneration, viewOwner } from "./viewCache";
import { workspaceApi } from "../shared/workspace-api";
import type { SessionControls } from "../shared/session-controls";
import { listenWorkspaceChanges } from "./workspace-changes";
import {
  useSourceOperation,
  useSourceId,
  useSourceRoute,
  useProjectionRoute,
} from "./SourceContext";
import { useEffect, useRef, useState } from "react";
import type {
  ActivityCapabilities,
  SettingValue,
  ActivityRecord,
} from "../shared/agent-activities";
import { Sheet } from "./components";
type Controls = Pick<SessionControls, "state" | "settings" | "capabilities"> & {
  generation?: string | null;
  readOnly?: boolean;
};
export function SessionActivityControls({
  conversationId: rawConversationId,
  recorded,
}: {
  conversationId: string;
  recorded?: {
    settings?: ActivityRecord;
    capabilities?: ActivityCapabilities;
    capabilityGeneration?: string;
  };
}) {
  const conversationId = ConversationId.parse(rawConversationId);
  const call = useSourceRoute();
  const unavailable = useSourceOperation(workspaceApi.setting);
  const sourceId = useSourceId();
  const [open, setOpen] = useState(false);
  const read = useProjectionRoute({
    key: JSON.stringify([open, conversationId]),
  });
  const [data, setData] = useState<Controls>();
  const [pending, setPending] = useState<{ id: string; value: SettingValue }>();
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [failedChange, setFailedChange] = useState<{
    id: string;
    value: SettingValue;
    inspected?: boolean;
    supersede?: () => Promise<void>;
  }>();
  const [inspecting, setInspecting] = useState(false);
  const epoch = useRef(0),
    ticket = useRef(0),
    writing = useRef(false);
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
    if (writing.current || !open) return;
    const own = epoch.current,
      request = ++ticket.current;
    try {
      const response = await read(workspaceApi.session, {
        params: { id: conversationId },
      });
      const next: Controls =
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
    return undefined;
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
    void refresh();
    const update = () => void refresh();
    const stopChanges = listenWorkspaceChanges(
      "activities",
      update,
      sourceId,
      conversationId,
    );
    return () => {
      epoch.current++;
      stopChanges();
    };
  }, [open, conversationId, sourceId, read]);
  async function inspect() {
    const failure = failedChange,
      own = epoch.current;
    setInspecting(true);
    try {
      const next = await refresh();
      if (next && own === epoch.current)
        setFailedChange((current) =>
          current === failure && current
            ? { ...current, inspected: true }
            : current,
        );
    } finally {
      if (own === epoch.current) setInspecting(false);
    }
  }
  async function change(id: string, value: SettingValue, newAttempt = false) {
    if (
      unavailable ||
      !data ||
      data.readOnly ||
      !data.generation ||
      writing.current ||
      (newAttempt && !failedChange?.inspected)
    )
      return;
    const own = epoch.current,
      owner = viewOwner(),
      ownerGeneration = viewGeneration(),
      previous = failedChange;
    const current = () =>
      own === epoch.current &&
      owner === viewOwner() &&
      ownerGeneration === viewGeneration();
    writing.current = true;
    ticket.current++;
    setPending({ id, value });
    setError("");
    setFailedChange(undefined);
    try {
      const setting = SessionSettingId.parse(id);
      const payload = {
        value,
        revision: data.settings.revision,
        generation: NativeGenerationId.parse(data.generation),
      };
      if (!crypto.subtle)
        throw new Error(
          "Cannot protect this change's identity; nothing was sent.",
        );
      // Keep only a fingerprint of free-form values beside the durable receipt.
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      );
      const fingerprint = Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (newAttempt && previous?.supersede) await previous.supersede();
      const next = await performStoredEffect(
        localStorage,
        owner,
        sourceId,
        [
          "native-setting",
          conversationId,
          payload.generation,
          String(payload.revision),
          setting,
          fingerprint,
        ],
        current,
        (commandId) =>
          call(workspaceApi.setting, {
            params: { id: conversationId, setting },
            body: {
              ...payload,
              commandId: ExecutionCommandId.parse(commandId),
            },
          }),
      );
      if (current()) {
        setData(next);
        window.dispatchEvent(new Event("loop-workspace-change"));
      }
    } catch (e) {
      if (current()) {
        setError((e as Error).message);
        setFailedChange({
          id,
          value,
          ...(e instanceof UncertainEffect ? { supersede: e.supersede } : {}),
        });
      }
    } finally {
      if (current()) {
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
              {failedChange.inspected
                ? "Session status is up to date. Apply the setting again if needed."
                : "Refresh session status before applying the setting again."}
              {failedChange.inspected && (
                <button
                  type="button"
                  disabled={
                    !!unavailable ||
                    !!pending ||
                    inspecting ||
                    !data ||
                    data.readOnly ||
                    !data.generation ||
                    data.capabilities.settings.state !== "supported" ||
                    !data.settings.options.find(
                      (option) => option.id === failedChange.id,
                    )?.mutable
                  }
                  onClick={() =>
                    void change(failedChange.id, failedChange.value, true)
                  }
                >
                  Apply setting again
                </button>
              )}
            </p>
          )}
          {unavailable && (
            <p className="field-hint" role="status">
              {unavailable}
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
                          !!unavailable ||
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
                          !!unavailable ||
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
                        {...literalEntry}
                        key={`${data.generation}:${data.settings.revision}:${option.id}`}
                        defaultValue={String(
                          option.requested ?? option.confirmed ?? "",
                        )}
                        disabled={
                          !!unavailable ||
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
