import { useSourceApi, useSourceCapabilities } from "./SourceContext";
import { useEffect, useRef, useState } from "react";
import { parse, clearAuthorization } from "./api";
import { RichText } from "./components";
import type { Request } from "../protocol";
import { Check, X } from "lucide-react";
import { SessionActivityControls } from "./SessionActivityControls";
import { Tools } from "./Tools";
import { ConnectionNotice, setConnection } from "./ConnectionNotice";
import { codexToolApproval } from "../shared/codex-approval";

export function WorkspaceConnection() {
  const [status, setStatus] = useState("Connecting to desktop…");
  useEffect(() => {
    let socket: WebSocket,
      stopped = false,
      timer: ReturnType<typeof setTimeout>,
      attempt = 0;
    let epoch = "",
      cursor = 0,
      // Assets this page loaded with; a restarted Loop may serve newer ones.
      build = "";
    const connect = () => {
      const url = new URL("/ws", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("epoch", epoch);
      url.searchParams.set("cursor", String(cursor));
      socket = new WebSocket(url);
      socket.onopen = () => {
        attempt = 0;
        setStatus("Connected to desktop");
        setConnection({ reconnecting: false });
      };
      socket.onmessage = (event) => {
        try {
          const m = JSON.parse(event.data);
          if (
            m.v !== 2 ||
            !["reset", "events"].includes(m.type) ||
            !Number.isSafeInteger(m.cursor)
          )
            return;
          epoch = m.epoch;
          cursor = m.cursor;
          if (m.type === "reset" && typeof m.build === "string") {
            if (!build) build = m.build;
            else if (m.build !== build) setConnection({ updated: true });
          }
          window.dispatchEvent(
            new CustomEvent("loop-workspace-change", { detail: m.type }),
          );
        } catch {
          socket.close();
        }
      };
      socket.onclose = (event) => {
        if (stopped) return;
        if (event.code === 4003) {
          clearAuthorization();
          window.dispatchEvent(new Event("loop-auth-expired"));
          return;
        }
        setStatus("Loop is reconnecting… Desktop work continues.");
        setConnection({ reconnecting: true });
        timer = setTimeout(
          connect,
          Math.min(15000, 500 * 2 ** Math.min(attempt++, 5)) +
            Math.random() * 250,
        );
      };
      socket.onerror = () => socket.close();
    };
    connect();
    const restarting = () => {
      if (socket.readyState === WebSocket.OPEN) return;
      setStatus("Loop is reconnecting… Desktop work continues.");
      setConnection({ reconnecting: true });
    };
    window.addEventListener("loop-reconnecting", restarting);
    const wake = () => {
      if (socket.readyState === WebSocket.CLOSED) {
        clearTimeout(timer);
        connect();
      }
    };
    window.addEventListener("online", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket.close();
      window.removeEventListener("online", wake);
      window.removeEventListener("loop-reconnecting", restarting);
    };
  }, []);
  return (
    <>
      <p className="workspace-connection" role="status">
        {status}
      </p>
      <ConnectionNotice />
    </>
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
  return (
    <>
      {items.map((item) => (
        <DecisionCard
          key={item.id}
          item={item}
          onConversation={onConversation}
        />
      ))}
    </>
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
                <label key={option}>
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
                  {option}
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
