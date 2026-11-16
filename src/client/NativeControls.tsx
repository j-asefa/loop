import { ErrorNotice } from "./ErrorNotice";
import { emitClientEvent } from "./clientEvents";
import { ExecutionCommandId } from "../shared/contract-ids.js";
import { ConversationId, parseId } from "../shared/contract-ids.js";
import { literalEntry, proseEntry } from "./textEntry";
import { AutofillBoundary } from "./AutofillBoundary";

import { CollectionReadNotice, useProjectionQuery } from "./CollectionRead";
import { storedCommandAt } from "./pendingCommandStorage";
import {
  workspaceApi,
  type NativeDecision as Decision,
  type RouteInput,
} from "../shared/workspace-api";
import { viewOwner, viewGeneration } from "./viewCache";
import {
  useSourceOperation,
  useSourceId,
  useSourceRoute,
} from "./SourceContext";
import { useEffect, useRef, useState } from "react";
import { parse } from "./json";
import { isExecutionRefused } from "./api";
import type { Request } from "../shared/protocol";
import { Check, X } from "lucide-react";
import { SessionActivityControls } from "./SessionActivityControls";
import { Tools } from "./Tools";

import { NativeRequestDetails } from "./NativeRequestDetails";

export function NativeDecisions({
  conversation,
  onConversation,
}: {
  conversation?: string;
  onConversation?: (id: string) => void;
}) {
  const sourceId = useSourceId();
  const query = useProjectionQuery(
    workspaceApi.nativeDecisions,
    { query: { conversation: parseId(ConversationId, conversation) } },
    { source: sourceId, conversation, collections: ["decisions"] },
  );
  const items = query.data ?? [];
  const notice = <CollectionReadNotice {...query} />;
  if (!items.length) return notice;
  const cards = items.map((item) => (
    <DecisionCard key={item.id} item={item} onConversation={onConversation} />
  ));
  return conversation ? (
    <div className="native-decisions">
      {notice}
      {cards}
    </div>
  ) : (
    <>
      {notice}
      {cards}
    </>
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
    <input
      {...literalEntry}
      {...props}
      type="password"
      onChange={(e) => onChange(e.target.value)}
    />
  ) : (
    <AutofillBoundary>
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
    </AutofillBoundary>
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
  async function answer(
    value: RouteInput<typeof workspaceApi.nativeAnswer>["body"]["answer"],
  ) {
    if (lock.current || unavailable) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const owner = viewOwner(),
      generation = viewGeneration();
    const storage =
      "loop-decision-" + JSON.stringify([owner, sourceId, item.id]);
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
        throw new Error(
          "This workspace session changed. Reopen the owning conversation.",
        );
      const empty = { commandId: "", digest: "" };
      const slot = storedCommandAt(sessionStorage, storage, (raw) =>
        parse<typeof empty>(raw, empty),
      );
      const saved = slot.read();
      const old = saved === undefined ? empty : saved;
      const commandId =
        old.digest === digest ? old.commandId : crypto.randomUUID();
      slot.write({ commandId, digest });
      const r = await call(workspaceApi.nativeAnswer, {
        params: { id: item.id },
        body: {
          commandId: ExecutionCommandId.parse(commandId),
          answer: value,
        },
      });
      if (r.state !== "resolved")
        throw new Error(
          "Decision delivery is uncertain. Inspect the native session before sending another decision.",
        );
      setDone(true);
      emitClientEvent("loop-workspace-change", undefined);
    } catch (e) {
      if (
        isExecutionRefused(e) &&
        owner === viewOwner() &&
        generation === viewGeneration()
      ) {
        try {
          storedCommandAt(sessionStorage, storage).remove();
        } catch {
          /* Retaining a refused ID is safe. */
        }
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
        <p>
          <a
            href={request.completionUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open completion page
          </a>
        </p>
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
                  {request.completionUrl && choice === "accept"
                    ? "Completed"
                    : choice.charAt(0).toUpperCase() + choice.slice(1)}
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
      {unavailable && (
        <p className="field-hint" role="status">
          {unavailable}
        </p>
      )}
      {error && <ErrorNotice role="alert">{error}</ErrorNotice>}
      {toolSettings && (
        <Tools
          initialView="permissions"
          onClose={() => setToolSettings(false)}
        />
      )}
    </section>
  );
}
