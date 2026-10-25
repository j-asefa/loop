import { useEffect, useRef, useState } from "react";
import {
  useSourceApi,
  useSourceCapabilities,
  useSourceId,
} from "./SourceContext";
import { listenWorkspaceChanges } from "./workspace-changes";
import { viewGeneration } from "./viewCache";
import {
  PersonalDecisionsPageSchema,
  type PersonalDecisionsPage,
} from "../shared/personal-decisions";

const empty: PersonalDecisionsPage = { items: [], next: null };
const choiceLabel = (choice: string) => {
  if (choice === "approve") return "Approved";
  if (choice === "reject") return "Denied";
  return choice.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
};

export function PersonalDecisions({
  kind,
  onConversation,
}: {
  kind: "approval" | "answer";
  onConversation: (id: string) => void;
}) {
  const api = useSourceApi(),
    source = useSourceId(),
    supported = useSourceCapabilities().personalDecisions === true,
    generation = viewGeneration();
  const [page, setPage] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const actions = useRef({ more: () => {}, retry: () => {} });
  useEffect(() => {
    if (!supported) return;
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
          const params = new URLSearchParams({ kind });
          if (cursor) params.set("before", cursor);
          result = PersonalDecisionsPageSchema.parse(
            await api<unknown>(
              `/me/decisions?${params}`,
              undefined,
              undefined,
              controller.signal,
            ),
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
  }, [api, source, supported, kind, generation]);
  if (!supported)
    return (
      <section
        className="feed personal-decisions"
        aria-label="Decision history unavailable"
      >
        <p>
          Approval and answer history is not available on this workspace yet.
          Update Loop on that workspace to view it.
        </p>
      </section>
    );
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
        <article className="feed-card personal-decision" key={item.id}>
          <div className="personal-decision-meta">
            <span className="eyebrow">
              {item.kind === "approval"
                ? "Approval decision"
                : item.state === "resolved"
                  ? "Answered"
                  : "Response sent"}
            </span>
            <time
              className="field-hint"
              dateTime={new Date(item.created_at).toISOString()}
            >
              {!item.response_recorded && "Requested "}
              {new Date(item.created_at).toLocaleString()}
            </time>
          </div>
          <h3>{item.title}</h3>
          <p className="field-hint">
            {item.agent_name ? "@" + item.agent_name : "Workflow"}
            {item.conversation_title && " · " + item.conversation_title}
          </p>
          {item.choice && (
            <p className="personal-decision-choice">
              Your choice: {choiceLabel(item.choice)}
            </p>
          )}
          {!!item.answers.length && (
            <dl className="personal-decision-answers">
              {item.answers.map((answer, index) => (
                <div key={index}>
                  <dt>{answer.question}</dt>
                  <dd>
                    {answer.secret
                      ? "Secret response — not saved"
                      : answer.values === null
                        ? item.response_truncated && item.response_recorded
                          ? "Not included in this preview"
                          : "Response not recorded"
                        : answer.values.length
                          ? answer.values.join(", ")
                          : "No answer provided"}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {item.response_truncated && (
            <p className="field-hint">
              Long responses are shortened in history.
            </p>
          )}
          {!item.response_recorded && (
            <p className="field-hint">
              The response text was not saved for this older request.
            </p>
          )}
          {item.state !== "resolved" && (
            <p className="note" role="status">
              {item.state === "deciding"
                ? "Sending response…"
                : "Delivery was not confirmed. Check the conversation for what happened next."}
            </p>
          )}
          {item.detail && (
            <details>
              <summary>Request details</summary>
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
              className="text-button"
              onClick={() => onConversation(item.conversation_id!)}
            >
              Open conversation
            </button>
          )}
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
    </section>
  );
}
