import { useEffect, useRef, useState } from "react";
import type {
  BeadDetail,
  BeadWorkItem,
  BeadWorkState,
  BeadWriteStatus,
} from "../shared/bead-routes";
import type { ProjectId } from "../shared/contract-ids";
import { workspaceApi } from "../shared/workspace-api";
import { callRoute, readRoute } from "./api";
import { ErrorNotice } from "./ErrorNotice";
import { sourceUrl, executionSourceId } from "./sourceRouting";
import { viewOwner } from "./viewCache";

const labels: Record<BeadWorkItem["status"], string> = {
  ready: "Ready",
  in_progress: "In progress",
  blocked: "Blocked",
  closed: "Closed",
};

function storedDraft(key: string): {
  text: string;
  excerpt?: string;
  requestId?: string;
} {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    return {
      text: typeof value.text === "string" ? value.text : "",
      excerpt: typeof value.excerpt === "string" ? value.excerpt : undefined,
      requestId:
        typeof value.requestId === "string" ? value.requestId : undefined,
    };
  } catch {
    return { text: "" };
  }
}

export function ProjectWork({ project }: { project: ProjectId }) {
  const source = executionSourceId();
  const [nav] = useState(() => new URLSearchParams(location.search));
  const [work, setWork] = useState<BeadWorkState>();
  const [filter, setFilter] = useState<BeadWorkItem["status"]>("ready");
  const [selected, setSelected] = useState(nav.get("bead") || "");
  const [detail, setDetail] = useState<BeadDetail>();
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [agent, setAgent] = useState("");
  const [adding, setAdding] = useState(nav.has("beadFromMessage"));
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reason, setReason] = useState("");
  const [closing, setClosing] = useState(false);
  const [revision, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [commentState, setComment] = useState<{
    key: string;
    draft: ReturnType<typeof storedDraft>;
  }>();
  const [createPending, setCreatePending] = useState(false);
  const [sourceMessageId, setSourceMessageId] = useState(
    nav.get("beadFromMessage") || undefined,
  );
  const passage = useRef<HTMLDivElement>(null);
  const closeRequest = useRef("");
  const bead = detail?.id === selected ? detail : undefined;
  const draftKey = bead
    ? JSON.stringify([
        "loop-bead-comment",
        viewOwner(),
        source,
        project,
        bead.storeId,
        bead.id,
      ])
    : "";

  const comment =
    commentState?.key === draftKey ? commentState.draft : { text: "" };
  const createKey = work?.enabled
    ? JSON.stringify([
        "loop-bead-create",
        viewOwner(),
        source,
        project,
        work.storeId,
      ])
    : "";

  useEffect(() => {
    if (!createKey) return;
    const pending = localStorage.getItem(createKey);
    if (!pending) return;
    try {
      const draft = JSON.parse(pending) as {
        title: string;
        description: string;
        sourceMessageId?: string;
      };
      setTitle(draft.title);
      setDescription(draft.description);
      setSourceMessageId(draft.sourceMessageId);
      setAdding(true);
      setCreatePending(true);
    } catch {
      setError("The saved bead draft could not be opened.");
    }
  }, [createKey]);

  useEffect(() => {
    const controller = new AbortController();
    void readRoute(
      workspaceApi.projectWork,
      { params: { project } },
      source,
      controller.signal,
    )
      .then(setWork)
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setWork(undefined);
        setError(error.message);
      });
    return () => controller.abort();
  }, [project, source, revision]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void readRoute(
      workspaceApi.projectBead,
      { params: { project, bead: selected } },
      source,
      controller.signal,
    )
      .then(setDetail)
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setDetail(undefined);
        setError(error.message);
      });
    void readRoute(
      workspaceApi.projectBeadAgents,
      { params: { project } },
      source,
      controller.signal,
    )
      .then(setAgents)
      .catch(() => {});
    return () => controller.abort();
  }, [project, selected, source, revision]);
  useEffect(() => {
    if (draftKey) setComment({ key: draftKey, draft: storedDraft(draftKey) });
    setReason("");
    setClosing(false);
    setAgent("");
    closeRequest.current = "";
  }, [draftKey]);

  function handle(operation: () => Promise<void>) {
    if (busy) return;
    setError("");
    setBusy(true);
    void operation()
      .then(() => refresh((value) => value + 1))
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  }
  function checkWrite(result: BeadWriteStatus) {
    if (result.status === "unknown")
      throw new Error("Outcome unknown. Check again using the same request.");
    if (result.status === "refused")
      throw new Error("Work changed or is unavailable. Refresh and try again.");
  }
  function saveComment(next: typeof comment) {
    if (!draftKey) return;
    localStorage.setItem(draftKey, JSON.stringify(next));
    setComment({ key: draftKey, draft: next });
  }
  function quoteSelection() {
    const range = document.getSelection();
    if (
      !range?.anchorNode ||
      !range.focusNode ||
      !passage.current?.contains(range.anchorNode) ||
      !passage.current.contains(range.focusNode)
    )
      return;
    const excerpt = range.toString().trim();
    if (excerpt.length > 4000) setError("Select up to 4,000 characters.");
    else if (excerpt) saveComment({ ...comment, excerpt });
  }

  return (
    <section aria-label="Project Work" className="project-work">
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <button
        type="button"
        className="text-button"
        disabled={busy}
        onClick={() => {
          setError("");
          refresh((value) => value + 1);
        }}
      >
        Refresh Work
      </button>
      {!work && !error && <p>Loading Work…</p>}
      {work?.enabled === false && (
        <button
          disabled={busy}
          onClick={() =>
            handle(async () => {
              await callRoute(
                workspaceApi.projectWorkEnable,
                { params: { project }, body: {} },
                source,
              );
            })
          }
        >
          Enable Beads
        </button>
      )}
      {work?.enabled && (
        <>
          <div className="segmented" aria-label="Bead status">
            {(Object.keys(labels) as (keyof typeof labels)[]).map((status) => (
              <button
                key={status}
                aria-pressed={filter === status}
                className={filter === status ? "selected" : ""}
                onClick={() => setFilter(status)}
              >
                {labels[status]}
              </button>
            ))}
          </div>
          <button onClick={() => setAdding(!adding)}>
            {adding ? "Hide new bead" : "New bead"}
          </button>
          {adding && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                handle(async () => {
                  const existing = localStorage.getItem(createKey);
                  const draft = existing
                    ? (JSON.parse(existing) as {
                        storeId: string;
                        title: string;
                        description: string;
                        sourceMessageId?: string;
                        requestId: string;
                      })
                    : {
                        storeId: work.storeId,
                        requestId: crypto.randomUUID(),
                        title,
                        description,
                        sourceMessageId,
                      };
                  localStorage.setItem(createKey, JSON.stringify(draft));
                  setCreatePending(true);
                  const result = await callRoute(
                    workspaceApi.projectBeadCreate,
                    { params: { project }, body: draft },
                    source,
                  );
                  if (result.status !== "unknown") {
                    localStorage.removeItem(createKey);
                    setCreatePending(false);
                  }
                  checkWrite(result);
                  setSelected(result.beadId);
                  setAdding(false);
                  setTitle("");
                  setDescription("");
                  setSourceMessageId(undefined);
                });
              }}
            >
              <label>
                Title{" "}
                <input
                  value={title}
                  required
                  maxLength={256}
                  readOnly={createPending}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                Description{" "}
                <textarea
                  value={description}
                  maxLength={16000}
                  readOnly={createPending}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <button disabled={busy || !title.trim()}>
                {createPending
                  ? "Check new bead"
                  : sourceMessageId
                    ? "Create bead from result"
                    : "Create bead"}
              </button>
              {createPending && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    localStorage.removeItem(createKey);
                    setCreatePending(false);
                  }}
                >
                  Discard new bead draft
                </button>
              )}
            </form>
          )}
          <ul>
            {work.items
              .filter((item) => item.status === filter)
              .map((item) => (
                <li key={item.id}>
                  <button
                    aria-current={selected === item.id}
                    className="text-button"
                    onClick={() => setSelected(item.id)}
                  >
                    {item.title}
                  </button>
                  {item.blockedBy.length > 0 && (
                    <span> Waiting on {item.blockedBy.join(", ")}</span>
                  )}
                </li>
              ))}
          </ul>
          {bead && (
            <article aria-label={bead.title}>
              <h3>{bead.title}</h3>
              <p>{labels[bead.status]}</p>
              <div ref={passage} style={{ whiteSpace: "pre-wrap" }}>
                {bead.description}
              </div>
              {bead.closeReason && <p>{bead.closeReason}</p>}
              {bead.dependencies.length > 0 && (
                <p>
                  Dependencies{" "}
                  {bead.dependencies.map((id) => (
                    <button
                      key={id}
                      className="text-button"
                      onClick={() => setSelected(id)}
                    >
                      {id}
                    </button>
                  ))}
                </p>
              )}
              {bead.sourceResult && (
                <a
                  href={sourceUrl(source, {
                    conversation: bead.sourceResult.conversationId,
                    message: bead.sourceResult.messageId,
                  })}
                >
                  Source result · {bead.sourceResult.title}
                </a>
              )}
              {bead.linkedRuns.map((run) => (
                <p key={run.requestId}>
                  {run.conversationId && (
                    <a
                      href={sourceUrl(source, {
                        conversation: run.conversationId,
                        message: run.result?.messageId,
                      })}
                    >
                      {run.result?.title || "Open linked thread"}
                    </a>
                  )}{" "}
                  {run.pulls.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer">
                      {url.split("/").slice(-3).join("/")}
                    </a>
                  ))}
                </p>
              ))}
              {bead.assignment && bead.status !== "closed" && (
                <div>
                  <p>
                    {bead.assignment.recovery
                      ? "Checking " + bead.assignment.recovery + " recovery"
                      : "Assigned to " +
                        (agents.find(
                          ({ id }) => id === bead.assignment!.agentId,
                        )?.name || "project agent")}
                  </p>
                  {(["resume", "release", "recover"] as const)
                    .filter((action) =>
                      action === "resume"
                        ? bead.assignment!.canResume
                        : action === "release"
                          ? bead.assignment!.canRelease
                          : !!bead.assignment!.recovery,
                    )
                    .map((action) => (
                      <button
                        key={action}
                        disabled={busy}
                        onClick={() =>
                          handle(async () => {
                            await callRoute(
                              workspaceApi.projectBeadAssignment,
                              {
                                params: { project, bead: bead.id },
                                body: {
                                  storeId: bead.storeId,
                                  generation: bead.assignment!.generation,
                                  action,
                                },
                              },
                              source,
                            );
                          })
                        }
                      >
                        {action === "resume"
                          ? "Resume start"
                          : action === "release"
                            ? "Release"
                            : "Check recovery"}
                      </button>
                    ))}
                </div>
              )}
              {bead.status === "ready" &&
                !bead.assignment &&
                agents.length > 0 && (
                  <div>
                    <select
                      aria-label="Project agent"
                      value={agent}
                      onChange={(event) => {
                        setAgent(event.target.value);
                      }}
                    >
                      <option value="">Choose a project agent</option>
                      {agents.map((option) => (
                        <option key={option.id} value={option.id}>
                          @{option.name}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={!agent || busy}
                      onClick={() =>
                        handle(async () => {
                          const key = JSON.stringify([
                            "loop-bead-start",
                            draftKey,
                            agent,
                          ]);
                          const requestId =
                            localStorage.getItem(key) || crypto.randomUUID();
                          localStorage.setItem(key, requestId);
                          await callRoute(
                            workspaceApi.projectBeadStart,
                            {
                              params: { project, bead: bead.id },
                              body: {
                                storeId: bead.storeId,
                                requestId,
                                agentId: agent,
                              },
                            },
                            source,
                          );
                          localStorage.removeItem(key);
                        })
                      }
                    >
                      Work on this
                    </button>
                  </div>
                )}
              {bead.status !== "closed" && (
                <button disabled={busy} onClick={() => setClosing(!closing)}>
                  Close bead
                </button>
              )}
              {closing && bead.status !== "closed" && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    handle(async () => {
                      closeRequest.current ||= crypto.randomUUID();
                      checkWrite(
                        await callRoute(
                          workspaceApi.projectBeadClose,
                          {
                            params: { project, bead: bead.id },
                            body: {
                              storeId: bead.storeId,
                              requestId: closeRequest.current,
                              reason,
                              generation: bead.assignment?.generation ?? null,
                            },
                          },
                          source,
                        ),
                      );
                    });
                  }}
                >
                  <input
                    aria-label="Close reason"
                    required
                    value={reason}
                    maxLength={2000}
                    onChange={(event) => {
                      closeRequest.current = "";
                      setReason(event.target.value);
                    }}
                  />
                  <button disabled={busy || !reason.trim()}>
                    Confirm close
                  </button>
                </form>
              )}
              <h4>Comments</h4>
              {bead.comments.map((item) => (
                <div key={item.id}>
                  <strong>{item.author}</strong>{" "}
                  <time dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                  <p style={{ whiteSpace: "pre-wrap" }}>{item.text}</p>
                </div>
              ))}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  handle(async () => {
                    const draft = {
                      ...comment,
                      requestId: comment.requestId || crypto.randomUUID(),
                    };
                    saveComment(draft);
                    try {
                      const result = await callRoute(
                        workspaceApi.projectBeadComment,
                        {
                          params: { project, bead: bead.id },
                          body: { storeId: bead.storeId, ...draft },
                        },
                        source,
                      );
                      if (result.status === "refused") {
                        const editable = { ...draft, requestId: undefined };
                        localStorage.setItem(
                          draftKey,
                          JSON.stringify(editable),
                        );
                        setComment((current) =>
                          current?.key === draftKey
                            ? { key: draftKey, draft: editable }
                            : current,
                        );
                      }
                      checkWrite(result);
                      localStorage.removeItem(draftKey);
                      setComment((current) =>
                        current?.key === draftKey
                          ? { key: draftKey, draft: { text: "" } }
                          : current,
                      );
                    } catch (error) {
                      const response = error as {
                        status?: number;
                        executionOutcome?: string;
                      };
                      if (
                        [400, 404, 409, 422].includes(response.status || 0) &&
                        response.executionOutcome !== "unknown"
                      ) {
                        const editable = { ...draft, requestId: undefined };
                        localStorage.setItem(
                          draftKey,
                          JSON.stringify(editable),
                        );
                        setComment((current) =>
                          current?.key === draftKey
                            ? { key: draftKey, draft: editable }
                            : current,
                        );
                      }
                      throw error;
                    }
                  });
                }}
              >
                <button
                  type="button"
                  disabled={busy || !!comment.requestId || !bead.description}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={quoteSelection}
                >
                  Comment on selection
                </button>
                {comment.excerpt && <blockquote>{comment.excerpt}</blockquote>}
                <textarea
                  aria-label="Comment"
                  value={comment.text}
                  maxLength={8000}
                  readOnly={!!comment.requestId}
                  onChange={(event) =>
                    saveComment({ ...comment, text: event.target.value })
                  }
                />
                {comment.requestId && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      localStorage.removeItem(draftKey);
                      setComment({ key: draftKey, draft: { text: "" } });
                    }}
                  >
                    Discard draft
                  </button>
                )}
                <button disabled={busy || !comment.text.trim()}>
                  {comment.requestId ? "Check comment" : "Post comment"}
                </button>
              </form>
            </article>
          )}
        </>
      )}
    </section>
  );
}
