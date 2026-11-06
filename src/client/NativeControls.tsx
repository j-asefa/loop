import { literalEntry, proseEntry } from "./textEntry";
import { readRoute } from "./workspace-api";
import { workspaceApi, type NativeDecision as Decision, type RouteInput } from "../shared/workspace-api";
import { viewOwner, viewGeneration } from "./viewCache";
import { useSourceOperation, useSourceId, useSourceRoute, useProjectionRoute } from "./SourceContext";
import { useEffect, useRef, useState, type RefObject } from "react";
import { parse, clearAuthorization, isExecutionRefused } from "./api";
import type { Request } from "../protocol";
import { Check, X } from "lucide-react";
import { SessionActivityControls } from "./SessionActivityControls";
import { Tools } from "./Tools";
import { ConnectionNotice, setConnection } from "./ConnectionNotice";
import { NativeRequestDetails } from "./NativeRequestDetails";
import { watchWorkspaceEvents } from "./workspace-events";
import { publishProjectionFrame, forgetProjectionSource, surfaceFallback } from "./workspace-projections";
import { WorkspaceChangeQueue, listenWorkspaceChanges } from "./workspace-changes";
import { PARTIAL_WORKSPACE_CAPABILITIES, type WorkspaceEvent } from "../shared/workspace-events";
import { capabilities } from "./capabilities";
import { multiplexWorkspaceSocket } from "./workspace-multiplex";
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
    const pending = new WorkspaceChangeQueue();
    // Streaming tokens can produce many committed events. Reconcile views
    // immediately after idle. Broad invalidations refresh every collection:
    // allow three seconds between them so two tabs leave room under the owner
    // request limit. Scoped changes retain two seconds; projected rows publish
    // directly below. Retain every source and the trailing change.
    const changed = (source: string, events?: readonly WorkspaceEvent[]) => {
      pending.add(source, events);
      pending.schedule((detail) => {
        window.dispatchEvent(
          new CustomEvent("loop-workspace-change", { detail }),
        );
      });
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
        url, source: sourceId,
        socket: (url: URL) => multiplexWorkspaceSocket(url, sourceId),
        read: (after, signal) =>
          readRoute(workspaceApi.events, { query: { after } }, sourceId, signal),
        changed: (events) => changed(sourceId, events),
        frame: (m) => {
          publishProjectionFrame(sourceId, m);
          if (m.v === 2 || m.capabilities)
            pending.capabilities.set(sourceId, m.v === 3 ? m.capabilities! : PARTIAL_WORKSPACE_CAPABILITIES);
          if (m.type !== "reset") return;
          if (sourceId || typeof m.build !== "string") return;
          const identity = BuildIdentity.safeParse(m.buildIdentity);
          const updated = identity.success ? browserNeedsReload(runningBuild, identity.data) : null;
          if (updated === false || (!build && updated === null)) build = m.build;
          if (updated !== null) setConnection({ updated });
          else if (m.build !== build) setConnection({ updated: true });
        },
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
        forgetProjectionSource(source);
        pending.delete(source);
      }
      for (const source of wanted)
        if (!stops.has(source)) stops.set(source, subscribe(source));
    };
    reconcileSources.current = reconcile;
    const stop = () => {
      stops.forEach((stop, source) => { stop(); forgetProjectionSource(source); });
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
export function NativeDecisions({
  conversation,
  onConversation,
}: {
  conversation?: string;
  onConversation?: (id: string) => void;
}) {
  const readContract = useProjectionRoute();
  const sourceId = useSourceId();
  const [items, setItems] = useState<Decision[]>([]);
  useEffect(() => {
    let stopped = false, latest = 0;
    const load = () => {
      const request = ++latest;
      void readContract(workspaceApi.nativeDecisions, { query: { conversation } })
        .then((x) => {
          if (!stopped && request === latest) setItems(x);
        })
        .catch(() => {});
    };
    const stopChanges = listenWorkspaceChanges("decisions", load, sourceId, conversation);
    const stopFallback = surfaceFallback([sourceId], "workspace", 3000, load);
    load();
    return () => {
      stopped = true;
      stopFallback();
      stopChanges();
    };
  }, [conversation, sourceId]);
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
function QuestionResponse({
  title,
  secret,
  onChange,
}: {
  title: string;
  secret?: boolean;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resize = () => {
      element.style.height = "auto";
      element.style.height = element.scrollHeight + "px";
    };
    resize();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        resize();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const props = {
    "aria-label": title + " response",
    placeholder: "Your response",
  };
  return secret ? (
    <input {...literalEntry} {...props} type="password" onChange={(e) => onChange(e.target.value)} />
  ) : (
    <textarea
      {...proseEntry}
      {...props}
      ref={ref}
      className="native-question-response"
      rows={1}
      onChange={(e) => {
        e.target.style.height = "auto";
        e.target.style.height = e.target.scrollHeight + "px";
        onChange(e.target.value);
      }}
    />
  );
}
function DecisionCard({
  item,
  onConversation,
}: {
  item: Decision;
  onConversation?: (id: string) => void;
}) {
  const call = useSourceRoute();
  const sourceId = useSourceId();
  const unavailable = useSourceOperation(workspaceApi.nativeAnswer);
  const request = parse<Request>(item.request, {} as Request);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  const lock = useRef(false);
  const [toolSettings, setToolSettings] = useState(false);
  async function answer(value: RouteInput<typeof workspaceApi.nativeAnswer>["body"]["answer"]) {
    if (lock.current || unavailable) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const owner = viewOwner(), generation = viewGeneration();
    const storage = "loop-decision-" + JSON.stringify([owner, sourceId, item.id]);
    try {
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
      if (generation !== viewGeneration() || owner !== viewOwner())
        throw new Error("This workspace session changed. Reopen the owning conversation.");
      const old = parse<any>(sessionStorage.getItem(storage) || "", {});
      const commandId =
        old.digest === digest ? old.commandId : crypto.randomUUID();
      sessionStorage.setItem(storage, JSON.stringify({ commandId, digest }));
      const r = await call(workspaceApi.nativeAnswer, { params: { id: item.id }, body: {
        commandId,
        answer: value,
      } });
      if (r.state !== "resolved")
        throw new Error(
          "Decision delivery is uncertain. Inspect the native session before sending another decision.",
        );
      setDone(true);
      window.dispatchEvent(new Event("loop-workspace-change"));
    } catch (e) {
      if (isExecutionRefused(e) && owner === viewOwner() && generation === viewGeneration()) {
        try { sessionStorage.removeItem(storage); } catch { /* Retaining a refused ID is safe. */ }
      }
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
      <NativeRequestDetails request={request} />
      {request.completionUrl?.startsWith("https://") && (
        <p><a href={request.completionUrl} target="_blank" rel="noopener noreferrer">Open completion page</a></p>
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
                  disabled={busy || !!unavailable}
                  onClick={() => void answer({ choice })}
                >
                  {allow ? (
                    <Check size={20} aria-hidden="true" />
                  ) : deny ? (
                    <X size={20} aria-hidden="true" />
                  ) : null}
                  {request.completionUrl && choice === "accept" ? "Completed" : choice.charAt(0).toUpperCase() + choice.slice(1)}
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
            <fieldset key={q.id} disabled={!!unavailable}>
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
              <QuestionResponse
                title={q.title}
                secret={q.secret}
                onChange={(value) =>
                  setAnswers((old) => ({ ...old, [q.id]: [value] }))
                }
              />
            </fieldset>
          ))}
          <button className="primary" disabled={busy || !!unavailable}>
            Send response
          </button>
        </form>
      )}
      {unavailable && <p className="field-hint" role="status">{unavailable}</p>}
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
