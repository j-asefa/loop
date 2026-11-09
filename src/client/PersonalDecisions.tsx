import { workspaceApi } from "../shared/workspace-api";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  MessageSquare,
  X,
} from "lucide-react";
import { Avatar } from "./Avatar";
import { Sheet } from "./components";
import { ApprovalRequestDetails } from "./ApprovalRequest";
import { NativeRequestDetails } from "./NativeRequestDetails";
import { useSourceRoute, useSourceId } from "./SourceContext";
import { listenWorkspaceChanges } from "./workspace-changes";
import { viewGeneration } from "./viewCache";
import type {
  PersonalDecision,
  PersonalDecisionsPage,
  PersonalApproval,
} from "../shared/personal-decisions";

const empty: PersonalDecisionsPage = { items: [], next: null };
const choiceLabel = (choice: string) => {
  if (choice === "approve") return "Approved";
  if (choice === "reject") return "Denied";
  return choice.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
};

function PersonalApprovalSheet({
  item,
  onClose,
  onConversation,
}: {
  item: PersonalDecision;
  onClose: () => void;
  onConversation: (id: string) => void;
}) {
  const call = useSourceRoute();
  const generation = viewGeneration();
  const [approval, setApproval] = useState<PersonalApproval | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setApproval(null);
    setError("");
    const controller = new AbortController();
    void call(
      workspaceApi.personalApproval,
      { params: { id: item.id } },
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted && generation === viewGeneration())
          setApproval(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted && generation === viewGeneration())
          setError((e as Error).message);
      });
    return () => controller.abort();
  }, [call, item.id, generation, retry]);
  return (
    <Sheet title="Original approval" onClose={onClose}>
      <div className="approval-detail">
        <div className="approval-identity">
          <Avatar name={item.agent_name || "Agent"} />
          <span>{item.agent_name || "Agent"}</span>
          {approval?.source === "approval" && approval.request.server && (
            <span>{approval.request.server}</span>
          )}
          <DecisionOutcome item={item} />
        </div>
        {approval?.source === "approval" && (
          <ApprovalRequestDetails
            request={JSON.stringify(approval.request)}
            heading
          />
        )}
        {approval?.source === "native" && (
          <>
            <h3>{approval.request.title}</h3>
            <NativeRequestDetails request={approval.request} />
          </>
        )}
        {!approval && !error && <p role="status">Loading approval…</p>}
        {error && (
          <div role="alert">
            <p>{error}</p>
            <button onClick={() => setRetry((value) => value + 1)}>
              Retry
            </button>
          </div>
        )}
        {item.conversation_id && (
          <button
            className="text-button"
            onClick={() => {
              onClose();
              onConversation(item.conversation_id!);
            }}
          >
            Open conversation <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </Sheet>
  );
}

function DecisionOutcome({ item }: { item: PersonalDecision }) {
  const approved = ["approve", "allow", "accept", "once", "confirm"].includes(
    item.choice || "",
  );
  const denied = ["reject", "deny", "decline", "cancel"].includes(
    item.choice || "",
  );
  const answered = item.kind === "answer" && item.state === "resolved";
  const Icon = denied ? X : approved || answered ? Check : MessageSquare;
  return (
    <span
      className={
        "personal-decision-outcome" +
        (approved
          ? " approved"
          : denied
            ? " denied"
            : answered
              ? " answered"
              : "")
      }
    >
      <Icon size={12} aria-hidden="true" />
      {item.choice && <span className="sr-only">Your choice: </span>}
      {item.choice
        ? choiceLabel(item.choice)
        : item.state === "deciding"
          ? "Sending"
          : answered
            ? "Answered"
            : "Response sent"}
    </span>
  );
}

export function PersonalDecisions({
  kind,
  onConversation,
}: {
  kind: "approval" | "answer";
  onConversation: (id: string) => void;
}) {
  const call = useSourceRoute(),
    source = useSourceId(),
    generation = viewGeneration();
  const [page, setPage] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{
    item: PersonalDecision;
    source: string;
    generation: number;
  } | null>(null);
  const openApproval = (item: PersonalDecision) =>
    setSelected({ item, source, generation });
  const actions = useRef({ more: () => {}, retry: () => {} });
  useEffect(() => {
    const controller = new AbortController();
    const stale = () =>
      controller.signal.aborted || generation !== viewGeneration();
    let current = empty,
      busy = false,
      pending = false,
      refreshImmediately = false,
      refreshAfter = 0;
    let retryBefore: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      pending = true;
      if (busy || timer || stale()) return;
      timer = setTimeout(
        () => void load(),
        Math.max(0, refreshAfter - Date.now()),
      );
    };
    const load = async (before?: string) => {
      if (busy || stale()) return;
      clearTimeout(timer);
      timer = undefined;
      busy = true;
      retryBefore = before;
      if (!before) {
        pending = false;
        refreshImmediately = false;
      }
      setLoading(true);
      setError("");
      // Reconcile only the loaded range. A deleted boundary ID must not make
      // one invalidation scan the owner's entire older history.
      const boundary = !before ? current.items.at(-1) : undefined;
      let reachedBoundary = false;
      let cursor = before;
      let next: string | null = null;
      const items: PersonalDecisionsPage["items"] = [];
      try {
        let result: PersonalDecisionsPage;
        do {
          result = await call(
            workspaceApi.personalDecisions,
            {
              query: { kind, before: cursor },
            },
            controller.signal,
          );
          if (stale()) return;
          const visible = boundary
            ? result.items.filter(
                (item) =>
                  item.created_at > boundary.created_at ||
                  (item.created_at === boundary.created_at &&
                    item.id >= boundary.id),
              )
            : result.items;
          items.push(...visible);
          // A fetched page may cross the loaded boundary. Keep its older rows
          // behind Load more, with a server-issued cursor that does not skip them.
          next =
            visible.length < result.items.length
              ? (items.at(-1)?.cursor ?? boundary!.cursor)
              : result.next;
          const last = result.items.at(-1);
          reachedBoundary = !!(
            boundary &&
            last &&
            (last.created_at < boundary.created_at ||
              (last.created_at === boundary.created_at &&
                last.id <= boundary.id))
          );
          if (result.next && result.next === cursor)
            throw new Error(
              "History pagination did not advance. Please retry.",
            );
          cursor = result.next ?? undefined;
        } while (!before && boundary && cursor && !reachedBoundary);
        current = {
          items: [
            ...new Map(
              [...(before ? current.items : []), ...items].map((item) => [
                item.id,
                item,
              ]),
            ).values(),
          ],
          next,
        };
        setPage(current);
      } catch (e) {
        if (!stale()) setError((e as Error).message);
      } finally {
        busy = false;
        refreshAfter = refreshImmediately ? 0 : Date.now() + 5000;
        if (!stale()) {
          setLoading(false);
          if (pending) schedule();
        }
      }
    };
    const refresh = (event: Event) => {
      const sources = (event as CustomEvent<{ sources?: string[] }>).detail
        ?.sources;
      if (sources && !sources.includes(source)) return;
      if (event.type === "loop-refresh") {
        refreshImmediately = true;
        refreshAfter = 0;
        clearTimeout(timer);
        timer = undefined;
      }
      schedule();
    };
    actions.current = {
      more: () => {
        if (current.next) void load(current.next);
      },
      retry: () => void load(retryBefore),
    };
    // Subscribe before starting the snapshot; changes arriving during any
    // page read queue a follow-up instead of being swallowed by its result.
    const stop = listenWorkspaceChanges(
      kind === "approval" ? "approvals" : "decisions",
      refresh,
      source,
    );
    const stopMetadata = listenWorkspaceChanges("metadata", refresh, source);
    window.addEventListener("loop-refresh", refresh);
    setPage(empty);
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      stop();
      stopMetadata();
      window.removeEventListener("loop-refresh", refresh);
    };
  }, [call, source, kind, generation]);
  return (
    <section
      className="feed personal-decisions"
      aria-label={
        kind === "approval"
          ? "Your approval history"
          : "Your answered questions"
      }
    >
      <p className="field-hint">
        {kind === "approval"
          ? "Approval requests you responded to, newest first."
          : "Questions you answered, newest first."}
      </p>
      {page.items.map((item) => (
        <article
          className="feed-card personal-decision"
          key={item.id}
          data-openable={item.kind === "approval" || undefined}
          onClick={
            item.kind === "approval"
              ? (event) => {
                  if (
                    !(event.target as HTMLElement).closest(
                      "button, a, details, input, select, textarea",
                    ) &&
                    !window.getSelection()?.toString()
                  )
                    openApproval(item);
                }
              : undefined
          }
        >
          <div className="card-byline">
            <div className="identity">
              <Avatar name={item.agent_name || "Agent"} />
              <span>
                <strong>{item.agent_name || "Agent"}</strong>
                <span className="subline">
                  <time
                    dateTime={new Date(item.created_at).toISOString()}
                    title={new Date(item.created_at).toLocaleString()}
                    aria-label={new Date(item.created_at).toLocaleString()}
                  >
                    {new Date(item.created_at).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </time>
                </span>
              </span>
            </div>
          </div>
          <div className="card-content">
            <div className="personal-decision-meta">
              <span className="eyebrow">
                {item.kind === "approval" ? "Approval" : "Answer"}
              </span>
              <DecisionOutcome item={item} />
            </div>
            <h2>
              {item.kind === "approval" ? (
                <button
                  className="personal-decision-open"
                  onClick={() => openApproval(item)}
                  aria-label={`Open approval: ${item.title}`}
                >
                  {item.title}
                </button>
              ) : (
                item.title
              )}
            </h2>
            {!!item.answers.length && (
              <dl className="personal-decision-answers">
                {item.answers.map((answer, index) => {
                  const values = answer.secret ? null : answer.values;
                  const hasAnswer = values !== null && values.length > 0;
                  return (
                    <div key={index}>
                      <dt>
                        <span className="personal-decision-question-label">
                          Question
                        </span>
                        {answer.question}
                      </dt>
                      <dd
                        className={
                          hasAnswer
                            ? "personal-decision-response" +
                              (item.state === "resolved" ? " answered" : "")
                            : "personal-decision-unavailable"
                        }
                      >
                        {hasAnswer ? (
                          <>
                            <span className="personal-decision-answer-label">
                              {item.state === "resolved"
                                ? "You answered"
                                : "Your response"}
                            </span>
                            {values.length === 1 ? (
                              <p className="personal-decision-answer-value">
                                {values[0]}
                              </p>
                            ) : (
                              <ul className="personal-decision-answer-values">
                                {values.map((value, valueIndex) => (
                                  <li
                                    className="personal-decision-answer-value"
                                    key={valueIndex}
                                  >
                                    {value}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        ) : answer.secret ? (
                          "Secret response — not saved"
                        ) : answer.values === null ? (
                          "Not included in this preview"
                        ) : (
                          "No answer provided"
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
            {item.response_truncated && (
              <p className="field-hint">
                Long responses are shortened in history.
              </p>
            )}
            {item.state !== "resolved" && (
              <p className="note" role="status">
                {item.state === "deciding"
                  ? "Sending response…"
                  : "Delivery was not confirmed. Check the conversation for what happened next."}
              </p>
            )}
            {item.conversation_title && (
              <p
                className="personal-decision-context"
                title={item.conversation_title}
              >
                {item.conversation_title}
              </p>
            )}
            {item.detail && (
              <details className="personal-decision-details">
                <summary>
                  <ChevronRight size={14} aria-hidden="true" />
                  Request details
                </summary>
                <pre>{item.detail}</pre>
                {item.detail_truncated && (
                  <p className="field-hint">
                    Long request details are shortened in history. Open the
                    conversation for the full request when available.
                  </p>
                )}
              </details>
            )}
            {item.conversation_id && (
              <button
                className="text-button preview-open"
                onClick={() => onConversation(item.conversation_id!)}
              >
                Open conversation <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        </article>
      ))}
      {loading && <p role="status">Loading history…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button onClick={() => actions.current.retry()}>Retry</button>
        </div>
      )}
      {!loading && !error && !page.items.length && !page.next && (
        <p>
          {kind === "approval"
            ? "You haven’t responded to any approval requests yet."
            : "You haven’t answered any questions yet."}
        </p>
      )}
      {page.next && !error && (
        <button disabled={loading} onClick={() => actions.current.more()}>
          Load more {kind === "approval" ? "approvals" : "answers"}
        </button>
      )}
      {selected &&
        selected.source === source &&
        selected.generation === generation &&
        selected.item.kind === kind && (
          <PersonalApprovalSheet
            key={selected.item.id}
            item={selected.item}
            onClose={() => setSelected(null)}
            onConversation={onConversation}
          />
        )}
    </section>
  );
}
