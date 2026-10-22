import { useSourceApi, useSourceCapabilities } from "./SourceContext";
import { useEffect, useRef, useState, type RefObject } from "react";
import { parse, clearAuthorization, apiInWorkspace } from "./api";
import { RichText } from "./components";
import type { Request } from "../protocol";
import { Check, X } from "lucide-react";
import { SessionActivityControls } from "./SessionActivityControls";
import { Tools } from "./Tools";
import { ConnectionNotice, setConnection } from "./ConnectionNotice";
import { codexToolApproval } from "../shared/codex-approval";
import { watchWorkspaceEvents } from "./workspace-events";
import { capabilities } from "./capabilities";
import { executionSourceId, sourceApiPathAt } from "./sourceRouting";
import {
  BuildIdentity,
  browserNeedsReload,
  runningBuild,
} from "../shared/build";

export function WorkspaceConnection({
  owner,
  sources,
  stopRef,
}: {
  owner: string;
  sources: { id: string }[];
  stopRef: RefObject<() => void>;
}) {
  const [status, setStatus] = useState("Connecting to workspace…");
  const sourceKey = JSON.stringify(
    [...new Set(["", executionSourceId(), ...sources.map((s) => s.id)])].sort(),
  );
  const reconcileSources = useRef<(sources: string[]) => void>(() => {});
  // Subscription lifetime and build identity belong to the signed-in owner.
  // Discovery changes are reconciled below without restarting healthy peers.
  useEffect(() => {
    let build = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastRefresh = 0;
    const pending = new Set<string>();
    // Streaming tokens can produce many committed events. Reconcile views
    // immediately after idle, then at most every 1.8 seconds while busy.
    // Retain every source and the trailing change without flooding HTTP reads.
    const changed = (source: string) => {
      pending.add(source);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        lastRefresh = Date.now();
        const sources = [...pending];
        pending.clear();
        window.dispatchEvent(
          new CustomEvent("loop-workspace-change", { detail: { sources } }),
        );
      }, Math.max(0, 1800 - (Date.now() - lastRefresh)));
    };
    const stops = new Map<string, () => void>();
    const subscribe = (sourceId: string) => {
      const path =
        !sourceId && (capabilities.pairedDevices || executionSourceId())
          ? "/ws"
          : sourceApiPathAt("/api/events/ws", sourceId);
      const url = new URL(path, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      return watchWorkspaceEvents({
        url,
        read: (after, signal) =>
          apiInWorkspace(
            "/events?after=" + after,
            sourceId,
            undefined,
            undefined,
            signal,
          ),
        changed: () => changed(sourceId),
        ...(!sourceId
          ? {
              connected: (connected: boolean) => {
                setStatus(
                  connected
                    ? "Connected to workspace"
                    : "Loop is reconnecting… Work continues.",
                );
                setConnection({ reconnecting: !connected });
              },
              expired: () => {
                clearAuthorization();
                window.dispatchEvent(new Event("loop-auth-expired"));
              },
              frame: (m: import("./workspace-events").WorkspaceFrame) => {
                if (m.type !== "reset" || typeof m.build !== "string") return;
                const identity = BuildIdentity.safeParse(m.buildIdentity);
                const updated = identity.success
                  ? browserNeedsReload(runningBuild, identity.data)
                  : null;
                if (updated === false || (!build && updated === null))
                  build = m.build;
                if (updated !== null) setConnection({ updated });
                else if (m.build !== build) setConnection({ updated: true });
              },
            }
          : {}),
      });
    };
    const reconcile = (sources: string[]) => {
      const wanted = new Set(sources);
      for (const [source, stop] of stops) {
        if (wanted.has(source)) continue;
        stop();
        stops.delete(source);
        pending.delete(source);
      }
      for (const source of wanted)
        if (!stops.has(source)) stops.set(source, subscribe(source));
      if (!pending.size) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    reconcileSources.current = reconcile;
    const stop = () => {
      clearTimeout(timer);
      stops.forEach((stop) => stop());
      stops.clear();
      pending.clear();
      if (reconcileSources.current === reconcile)
        reconcileSources.current = () => {};
    };
    stopRef.current = stop;
    return () => {
      stop();
      if (stopRef.current === stop) stopRef.current = () => {};
    };
  }, [owner]);
  useEffect(() => {
    reconcileSources.current(JSON.parse(sourceKey));
  }, [owner, sourceKey]);
  return (
    <p className="workspace-connection" role="status">
      {status}
    </p>
  );
}
type Decision = {
  id: string;
  conversation_id: string;
  name: string;
  request: string;
  state: string;
};
export function NativeDecisions({
  conversation,
  onConversation,
}: {
  conversation?: string;
  onConversation?: (id: string) => void;
}) {
  const api = useSourceApi();
  const capabilities = useSourceCapabilities();
  const [items, setItems] = useState<Decision[]>([]);
  useEffect(() => {
    if (!capabilities.nativeHarnesses) return;
    let stopped = false;
    const load = () => {
      void api<Decision[]>(
        "/native/decisions" +
          (conversation ? "?conversation=" + conversation : ""),
      )
        .then((x) => {
          if (!stopped) setItems(x);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 3000);
    window.addEventListener("loop-workspace-change", load);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("loop-workspace-change", load);
    };
  }, [conversation]);
  if (!items.length) return null;
  const cards = items.map((item) => (
    <DecisionCard key={item.id} item={item} onConversation={onConversation} />
  ));
  return conversation ? (
    <div className="native-decisions">{cards}</div>
  ) : (
    <>{cards}</>
  );
}
function DecisionCard({
  item,
  onConversation,
}: {
  item: Decision;
  onConversation?: (id: string) => void;
}) {
  const api = useSourceApi();
  const request = parse<Request>(item.request, {} as Request);
  const structured = parse<any>(request.detail, null);
  const toolApproval = codexToolApproval(structured);
  // Claude nests the shell command in its tool input.
  const command = structured?.command ?? structured?.input?.command;
  const detail = command
    ? typeof command === "string"
      ? command
      : JSON.stringify(command)
    : request.detail;
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  const lock = useRef(false);
  const [toolSettings, setToolSettings] = useState(false);
  async function answer(value: Record<string, unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const storage = "loop-decision-" + item.id;
    // Retain the receipt identity across reloads, never secret question answers.
    const signature = JSON.stringify(value);
    const bytes = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(signature),
      ),
    );
    const digest = Array.from(bytes)
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    const old = parse<any>(sessionStorage.getItem(storage) || "", {});
    const commandId =
      old.digest === digest ? old.commandId : crypto.randomUUID();
    sessionStorage.setItem(storage, JSON.stringify({ commandId, digest }));
    try {
      const r = await api("/native/decisions/" + item.id, {
        commandId,
        answer: value,
      });
      if (r.state !== "resolved")
        throw new Error(
          "Decision delivery is uncertain. Inspect the native session before sending another decision.",
        );
      setDone(true);
      window.dispatchEvent(new Event("loop-workspace-change"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  if (done) return null;
  return (
    <section className="native-decision">
      <h3>{request.title}</h3>
      <p>
        @{item.name || "agent"} · Native {request.kind}
      </p>
      {onConversation && (
        <button
          className="text-button"
          onClick={() => onConversation(item.conversation_id)}
        >
          Open owning conversation
        </button>
      )}
      <div
        className="native-decision-detail"
        role="region"
        aria-label="Request details"
        tabIndex={0}
      >
        {toolApproval ? (
          <>
            <p>
              {toolApproval.server}
              {toolApproval.tool ? ` · ${toolApproval.tool}` : ""}
            </p>
            <RichText content={toolApproval.message} />
            {toolApproval.arguments !== undefined && (
              <>
                <h4>Tool arguments</h4>
                <pre>{JSON.stringify(toolApproval.arguments, null, 2)}</pre>
              </>
            )}
          </>
        ) : structured && !command ? (
          // Structured requests are data, not Markdown: indented JSON would
          // otherwise become unwrapped code blocks.
          <pre>{JSON.stringify(structured, null, 2)}</pre>
        ) : (
          <RichText content={detail || ""} />
        )}
      </div>
      {(command || toolApproval) && (
        <details>
          <summary>Native request details</summary>
          <pre>{JSON.stringify(structured, null, 2)}</pre>
        </details>
      )}
      {item.state !== "pending" ? (
        <p className="note">
          Decision delivery is {item.state}. It will not be sent again
          automatically.
        </p>
      ) : request.kind === "approval" ? (
        <>
          <div
            className="native-approval-actions"
            role="group"
            aria-label="Approval decision"
          >
            {request.choices?.map((choice) => {
              const allow = ["allow", "accept", "once", "confirm"].includes(
                choice,
              );
              const deny = ["deny", "reject", "decline", "cancel"].includes(
                choice,
              );
              return (
                <button
                  key={choice}
                  className={allow ? "primary" : "secondary"}
                  data-decision={allow ? "allow" : deny ? "deny" : "other"}
                  disabled={busy}
                  onClick={() => void answer({ choice })}
                >
                  {allow ? (
                    <Check size={20} aria-hidden="true" />
                  ) : deny ? (
                    <X size={20} aria-hidden="true" />
                  ) : null}
                  {choice.charAt(0).toUpperCase() + choice.slice(1)}
                </button>
              );
            })}
          </div>
          <details className="native-approval-settings">
            <summary>Fewer approval prompts</summary>
            <p className="field-hint">
              Set Agent tool calls to Never ask in Permissions and your agents
              run shell commands, file edits and other native tools without
              stopping, from their next turn. This request still needs a
              decision.
            </p>
            <button
              className="text-button"
              onClick={() => setToolSettings(true)}
            >
              Permissions
            </button>
            <p className="field-hint">
              To change only this session, use the harness’s permission mode
              below. Changes apply after the harness confirms them.
            </p>
            <SessionActivityControls conversationId={item.conversation_id} />
          </details>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void answer(
              Object.fromEntries(
                (request.questions || []).map((q) => [
                  q.id,
                  answers[q.id] || [],
                ]),
              ),
            );
          }}
        >
          {request.questions?.map((q) => (
            <fieldset key={q.id}>
              <legend>{q.title}</legend>
              {q.options?.map((option) => (
                <label className="native-question-option" key={option}>
                  <input
                    type={q.multiple ? "checkbox" : "radio"}
                    name={item.id + q.id}
                    checked={answers[q.id]?.includes(option) || false}
                    onChange={(e) =>
                      setAnswers((old) => ({
                        ...old,
                        [q.id]: q.multiple
                          ? e.target.checked
                            ? [...(old[q.id] || []), option]
                            : (old[q.id] || []).filter((v) => v !== option)
                          : [option],
                      }))
                    }
                  />
                  <span>{option}</span>
                </label>
              ))}
              <input
                aria-label={q.title + " response"}
                type={q.secret ? "password" : "text"}
                autoComplete="off"
                placeholder="Your response"
                onChange={(e) =>
                  setAnswers((old) => ({ ...old, [q.id]: [e.target.value] }))
                }
              />
            </fieldset>
          ))}
          <button className="primary" disabled={busy}>
            Send response
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {toolSettings && (
        <Tools
          initialView="permissions"
          onClose={() => setToolSettings(false)}
        />
      )}
    </section>
  );
}
