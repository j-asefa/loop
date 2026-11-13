import {
  ConversationId,
  FolderId,
  TeamId,
  parseId,
} from "../shared/contract-ids.js";
import { literalEntry } from "./textEntry";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { callRoute, readRoute } from "./api";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { executionSourceId } from "./sourceRouting";
import { performStoredEffect, creationFailureSettled } from "./pendingCommands";
import { viewOwner, viewGeneration } from "./viewCache";
import { useSourceId } from "./SourceContext";
import { CollectionReadNotice, useCollectionRead } from "./CollectionRead";
import { broadWorkspaceChange } from "./workspace-changes";
import { Sheet } from "./components";
import type { Folder, Team } from "../shared/types";

type Status = RouteResponse<typeof workspaceApi.teamReview>;
export function StartCodeReview({
  teams,
  folders,
  initialTeam,
  initialFolder,
  onClose,
  onStarted,
  onCreateTeam,
}: {
  teams: Team[];
  folders: Folder[];
  initialTeam?: string;
  initialFolder?: string;
  onClose: () => void;
  onStarted: (conversation: string) => void;
  onCreateTeam: () => void;
}) {
  const choices = teams.filter((t) => t.preset_id === "code-review");
  const [teamId, setTeamId] = useState(initialTeam || choices[0]?.id || "");
  const [folderId, setFolderId] = useState(
    initialFolder || choices.find((t) => t.id === teamId)?.folder_id || "",
  );
  const [scope, setScope] = useState<Status["scope"]>("uncommitted"),
    [base, setBase] = useState("main");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const owner = viewOwner(),
    generation = viewGeneration(),
    source = executionSourceId();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () =>
    mounted.current &&
    owner === viewOwner() &&
    generation === viewGeneration() &&
    source === executionSourceId();
  return (
    <Sheet title="Review local changes" onClose={onClose}>
      <p>
        Three reviewers inspect the same captured code independently. The review
        lead verifies findings and returns one report. You can keep coding while
        they work.
      </p>
      <p className="muted">
        Uncommitted changes include non-ignored new files. Hidden files,
        credentials, generated output, binary and oversized files are omitted
        and listed in the result. No tests are run.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          const body = { folderId: parseId(FolderId, folderId), scope, base },
            encoded = JSON.stringify({ teamId, ...body });
          try {
            const r = await performStoredEffect(
              localStorage,
              owner,
              source,
              ["review-create", encoded],
              current,
              (idempotencyKey) =>
                callRoute(
                  workspaceApi.teamReview,
                  {
                    params: { id: TeamId.parse(teamId) },
                    body: { ...body, idempotencyKey },
                  },
                  source,
                ),
              creationFailureSettled,
            );
            if (current()) onStarted(r.conversationId);
          } catch (e) {
            if (current()) setError((e as Error).message);
          } finally {
            if (mounted.current) setBusy(false);
          }
        }}
      >
        <label>
          Review team
          <select
            aria-label="Review team"
            required
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
              setFolderId(
                choices.find((t) => t.id === e.target.value)?.folder_id ||
                  folderId,
              );
            }}
          >
            <option value="">Choose a review team</option>
            {choices.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="text-button" onClick={onCreateTeam}>
          Create a review team
        </button>
        <label>
          Project
          <select
            aria-label="Project"
            required
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
          >
            <option value="">Choose a project</option>
            {folders
              .filter((f) => f.kind === "project")
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Changes
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as Status["scope"])}
          >
            <option value="uncommitted">Uncommitted changes</option>
            <option value="staged">Staged changes</option>
            <option value="branch">Branch against a base</option>
          </select>
        </label>
        {scope === "branch" && (
          <label>
            Base branch
            <input
              {...literalEntry}
              required
              maxLength={200}
              value={base}
              onChange={(e) => setBase(e.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy || !teamId || !folderId}>
          {busy ? "Capturing changes…" : "Start review"}
        </button>
      </form>
    </Sheet>
  );
}

export function CodeReviewStatus({
  conversationId: rawConversationId,
  revision,
}: {
  conversationId: string;
  revision: number;
}) {
  const conversationId = ConversationId.parse(rawConversationId);
  const source = useSourceId();
  const generation = viewGeneration();
  const context = useMemo(
    () => ({ source, conversationId, retryFreshness: false }),
    [source, conversationId, generation],
  );
  const { load, error, busy } = useCollectionRead(
    JSON.stringify([generation, source, conversationId]),
  );
  const [snapshot, setSnapshot] = useState<{
    context: typeof context;
    review: Status | null;
  }>();
  const refresh = useCallback(
    (manual = false, freshness = false) =>
      load(
        (signal, mode) => {
          context.retryFreshness = freshness;
          return readRoute(
            workspaceApi.reviewStatus,
            {
              params: { id: context.conversationId },
              ...(freshness ? { query: { freshness: "true" } } : {}),
            },
            context.source,
            signal,
            undefined,
            mode,
          );
        },
        (review) =>
          setSnapshot((previous) => ({
            context,
            review:
              !freshness &&
              review &&
              previous?.context === context &&
              previous.review?.id === review.id
                ? {
                    ...review,
                    current: previous.review.current,
                    freshnessError: previous.review.freshnessError,
                  }
                : review,
          })),
        manual,
      ),
    [context, load],
  );
  useEffect(() => {
    const recover = (event: Event) => {
      if (!broadWorkspaceChange(event)) return;
      const sources = (event as CustomEvent<{ sources?: string[] }>).detail
        ?.sources;
      if (!sources || sources.includes(context.source)) void refresh();
    };
    window.addEventListener("loop-workspace-change", recover);
    void refresh();
    return () => {
      window.removeEventListener("loop-workspace-change", recover);
    };
  }, [context, refresh, revision]);
  const review = snapshot?.context === context ? snapshot.review : null;
  const checking = busy && context.retryFreshness;
  const notice = (
    <CollectionReadNotice
      error={error}
      busy={busy}
      retry={() => void refresh(true, context.retryFreshness)}
    />
  );
  if (!review) return notice;
  const complete = review.reviewers.filter(
    (r) => r.state === "completed",
  ).length;
  const missing = review.reviewers.filter((r) =>
    ["failed", "cancelled", "interrupted"].includes(r.state),
  );
  return (
    <aside className="code-review-status" aria-label="Snapshot review status">
      {notice}
      <strong>
        Snapshot review · {complete}/{review.reviewers.length} reviewers
        completed
      </strong>
      <p>
        {review.scope} · {review.changed.length} changed files · snapshot{" "}
        {review.fingerprint.slice(0, 10)}. Tests were not run.
      </p>
      {!!missing.length && (
        <p role="status">
          Incomplete coverage:{" "}
          {missing
            .map((r) => r.state + (r.error ? ` (${r.error})` : ""))
            .join("; ")}
        </p>
      )}
      {!!review.omitted.length && (
        <details>
          <summary>{review.omitted.length} files omitted</summary>
          <ul>
            {review.omitted.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
      )}
      <button
        className="text-button"
        disabled={checking}
        onClick={() => void refresh(true, true)}
      >
        {checking ? "Checking…" : "Check for newer edits"}
      </button>
      {review.current !== null && (
        <p role="status">
          {review.current
            ? "The snapshot matched at the last check."
            : "Changes have moved on. This report covers an earlier snapshot."}
        </p>
      )}
      {review.freshnessError && (
        <p role="status">Freshness unavailable: {review.freshnessError}</p>
      )}
    </aside>
  );
}
