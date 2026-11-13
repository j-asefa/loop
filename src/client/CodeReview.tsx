import { literalEntry } from "./textEntry";
import { useEffect, useRef, useState } from "react";
import { callRoute } from "./api";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { executionSourceId } from "./sourceRouting";
import { performStoredEffect, creationFailureSettled } from "./pendingCommands";
import { viewOwner, viewGeneration } from "./viewCache";
import { useSourceRoute, useSourceRouteRead } from "./SourceContext";
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
          const body = { folderId, scope, base },
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
                  { params: { id: teamId }, body: { ...body, idempotencyKey } },
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
  conversationId,
  revision,
}: {
  conversationId: string;
  revision: number;
}) {
  const sourceRoute = useSourceRoute();
  const read = useSourceRouteRead();
  const [review, setReview] = useState<Status | null>(null),
    [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    read(
      workspaceApi.reviewStatus,
      { params: { id: conversationId } },
      controller.signal,
    )
      .then((r) => {
        if (active)
          setReview((previous) =>
            r && previous?.id === r.id
              ? {
                  ...r,
                  current: previous.current,
                  freshnessError: previous.freshnessError,
                }
              : r,
          );
      })
      .catch(() => {});
    return () => {
      active = false;
      controller.abort();
    };
  }, [conversationId, revision, read]);
  if (!review) return null;
  const complete = review.reviewers.filter(
    (r) => r.state === "completed",
  ).length;
  const missing = review.reviewers.filter((r) =>
    ["failed", "cancelled", "interrupted"].includes(r.state),
  );
  return (
    <aside className="code-review-status" aria-label="Snapshot review status">
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
        onClick={async () => {
          setChecking(true);
          setError("");
          try {
            setReview(
              await sourceRoute(workspaceApi.reviewStatus, {
                params: { id: conversationId },
                query: { freshness: "true" },
              }),
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setChecking(false);
          }
        }}
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
      {(error || review.freshnessError) && (
        <p role="status">
          Freshness unavailable: {error || review.freshnessError}
        </p>
      )}
    </aside>
  );
}
