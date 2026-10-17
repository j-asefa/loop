import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  CircleHelp,
  Clock3,
  FolderOpen,
  ListTodo,
  RefreshCw,
  Rows3,
  TriangleAlert,
} from "lucide-react";
import { apiInWorkspace } from "./api";
import { useSourceId } from "./SourceContext";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import { sourceUrl } from "./sourceRouting";
import { relativeTime } from "./threadView";
import { CheckoutChip, CheckoutSheet } from "./Checkout";
import { VerificationChip, VerificationSheet } from "./Verification";
import { PullStateChip } from "./PullState";
import { Sheet } from "./components";
import { BriefSourceSheet, type BriefEvidenceTarget } from "./BriefSourceSheet";
import { Chip } from "./ThreadTools";
import type { AgentSource } from "./agentSources";
import {
  compareProjectStatus,
  type ProjectStatus,
  type ProjectStatusAction,
  type ProjectStatusPage,
} from "../shared/project-status";
import "./projectStatus.css";
import { BriefTokenUsage } from "./BriefTokenUsage";
import { briefStageLabels } from "../shared/brief-reading";
import {
  createReadableText,
  readableAuthor,
  readableText,
  type DisplayAgent,
} from "../shared/readable-text";

type SourcePage = {
  source: AgentSource;
  page?: ProjectStatusPage;
  fresh: boolean;
  receivedAt?: number;
  error?: string;
};
type Card = { project: ProjectStatus; source: SourcePage };
const keyOf = (c: Card) => JSON.stringify([c.source.source.id, c.project.id]);
const actionLabel: Record<ProjectStatusAction["kind"], string> = {
  approve: "Approve request",
  answer: "Answer question",
  resume: "Review paused work",
  failed: "Review failed work",
  not_sent: "Review unsent message",
  review: "Review pull request",
};
const statusLabel: Record<ProjectStatus["status"], string> = {
  needs_you: "Needs you",
  blocked: "Blockers recorded",
  working: "In progress",
  queued: "Queued",
  idle: "Quiet",
};
const briefLabel: Record<ProjectStatus["brief"]["state"], string> = {
  never: "No brief enabled",
  pending: "First brief pending",
  failed: "Brief generation failed",
  off: "Brief is turned off",
  ready: "No headline recorded",
};
export function statusUrl(source: string, target: Record<string, string>) {
  const url = new URL(sourceUrl(source), location.origin);
  for (const [key, value] of Object.entries(target))
    url.searchParams.set(key, value);
  return url.pathname + url.search;
}
function Stamp({ at, prefix }: { at: number | null; prefix: string }) {
  return (
    <small>
      {at === null ? (
        `${prefix} time unavailable`
      ) : (
        <time
          dateTime={new Date(at).toISOString()}
          title={new Date(at).toLocaleString()}
        >
          {prefix} {relativeTime(at)}
        </time>
      )}
    </small>
  );
}

/** The source's counts and the synthesized project record have separate clocks. */
export function ProjectStatusCard({
  item: p,
  fresh,
  observedAt,
  sourceName,
  agents = [],
  sourceId,
  busy,
  onAction,
  onEvidence,
  onPulls,
  onBriefSource,
  onRequests,
  teams,
}: {
  item: ProjectStatus;
  fresh: boolean;
  observedAt: number;
  sourceName?: string;
  agents?: DisplayAgent[];
  sourceId: string;
  busy: boolean;
  onAction: (action: ProjectStatusAction) => void;
  onEvidence: (kind: "checkout" | "verification" | "evidence") => void;
  onPulls: () => void;
  onBriefSource?: (target: BriefEvidenceTarget) => void;
  onRequests?: () => void;
  teams?: string;
}) {
  const readable = createReadableText(agents);
  const b = p.brief,
    e = p.evidence;
  const brief = statusUrl(sourceId, {
    page: "projects",
    projectView: p.id,
    projectTab: "brief",
  });
  const threads = statusUrl(sourceId, {
    page: "projects",
    projectView: p.id,
    projectTab: "threads",
  });
  const destination = b.synthesized_at !== null ? brief : threads;
  const showCheckout =
    e?.checkout &&
    (e.checkout.state !== "captured" ||
      e.checkout.files > 0 ||
      e.checkout.untracked > 0);
  const showVerification = !!e?.verification?.items.length;
  const highlights = b.highlights;
  const attention = p.actions[0];
  const setup = b.state === "never" || b.state === "off";
  const briefSection = (section: string) => brief + "&briefSection=" + section;
  const briefItems = (kind: string) => brief + "&briefKind=" + kind;
  const activity = (filter: string) =>
    statusUrl(sourceId, {
      page: "feed",
      project: p.id,
      filter,
      ...(teams ? { teams } : {}),
    });
  const sourceLink = (item: string, children: ReactNode, className = "") => {
    const target = {
      item,
      ...(item === "headline" ? { version: b.version } : {}),
    };
    const query = new URLSearchParams({ briefEvidence: item });
    if (target.version) query.set("briefVersion", String(target.version));
    return (
      <a
        className={"project-status-link project-status-surface " + className}
        href={brief + "&" + query}
        onClick={(event) => {
          if (
            !onBriefSource ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          onBriefSource(target);
        }}
      >
        <div>{children}</div>
        <ArrowUpRight
          className="project-status-surface-arrow"
          size={17}
          aria-hidden="true"
        />
      </a>
    );
  };
  const statusTarget =
    p.status === "blocked"
      ? briefItems("unfinished")
      : activity(
          p.status === "working"
            ? "working"
            : p.status === "queued"
              ? "queued"
              : "done",
        );
  const primaryAction = attention ? (
    <button
      className="primary"
      disabled={busy}
      onClick={() => onAction(attention)}
    >
      {busy ? "Checking…" : actionLabel[attention.kind]}
      <ChevronRight size={15} aria-hidden="true" />
    </button>
  ) : setup ? (
    <a className="primary" href={brief}>
      Enable brief <ChevronRight size={15} aria-hidden="true" />
    </a>
  ) : b.state === "failed" ? (
    <a className="primary" href={brief}>
      Review brief <ChevronRight size={15} aria-hidden="true" />
    </a>
  ) : null;
  return (
    <article className="project-status-card">
      <header>
        <a href={destination} className="project-status-identity">
          <span className="project-status-icon" aria-hidden="true">
            <FolderOpen size={21} />
          </span>
          <span className="project-status-name">{readable(p.name)}</span>
        </a>
        <a
          className="project-status-state-link"
          href={statusTarget}
          onClick={(event) => {
            if (
              p.status === "needs_you" &&
              onRequests &&
              event.button === 0 &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              event.preventDefault();
              onRequests();
            }
          }}
        >
          <Chip
            tone={
              !fresh
                ? "idle"
                : p.status === "needs_you"
                  ? "needs"
                  : p.status === "blocked"
                    ? "failed"
                    : p.status
            }
          >
            {statusLabel[p.status]}
            {!fresh && " · last seen"}
            <ChevronRight size={12} aria-hidden="true" />
          </Chip>
        </a>
      </header>
      {sourceName && (
        <p className="project-status-source">
          <a
            className="project-status-link"
            href={statusUrl(sourceId, { page: "feed", filter: "status" })}
          >
            {readable(sourceName)}
          </a>
        </p>
      )}
      <p className="project-status-counts">
        <span className={fresh ? "status-live" : ""}>
          <a className="project-status-link" href={threads}>
            {fresh ? "Now" : `Last seen ${relativeTime(observedAt)}`}
          </a>
        </span>
        {p.counts.needs > 0 && (
          <span>
            <button
              className="project-status-link project-status-count project-status-count-needs"
              onClick={onRequests}
            >
              {p.counts.needs} waiting for you
              <ChevronRight size={12} aria-hidden="true" />
            </button>
          </span>
        )}
        {p.counts.working > 0 && (
          <span>
            <a
              className="project-status-link project-status-count"
              href={activity("working")}
            >
              {p.counts.working} working
              <ChevronRight size={12} aria-hidden="true" />
            </a>
          </span>
        )}
        {p.counts.queued > 0 && (
          <span>
            <a
              className="project-status-link project-status-count"
              href={activity("queued")}
            >
              {p.counts.queued} queued
              <ChevronRight size={12} aria-hidden="true" />
            </a>
          </span>
        )}
        {!p.counts.needs && !p.counts.working && !p.counts.queued && (
          <span>
            <a
              className="project-status-link project-status-count"
              href={threads}
            >
              No agents working
              <ChevronRight size={12} aria-hidden="true" />
            </a>
          </span>
        )}
      </p>
      <div className="project-status-record">
        <div className="project-status-record-heading">
          <a
            className="project-status-eyebrow project-status-link"
            href={brief}
          >
            Latest update
            <ChevronRight size={12} aria-hidden="true" />
          </a>
          {b.synthesized_at !== null && (
            <a
              className="project-status-clock project-status-link"
              href={brief}
            >
              <Clock3 size={12} aria-hidden="true" />
              <Stamp at={b.synthesized_at} prefix="" />
            </a>
          )}
        </div>
        {(b.pending > 0 ||
          (b.state !== "ready" && b.synthesized_at !== null)) && (
          <p className="project-status-note">
            {b.pending > 0 && (
              <a className="project-status-link" href={brief}>
                {b.pending} {b.pending === 1 ? "update" : "updates"} pending
              </a>
            )}
            {b.state !== "ready" && b.synthesized_at !== null && (
              <a className="project-status-link" href={brief}>
                {b.pending > 0 && " · "}
                {briefLabel[b.state]}
              </a>
            )}
          </p>
        )}
        <div className="project-status-summary">
          {b.headline ? (
            sourceLink(
              "headline",
              <>
                <span>{readable(b.headline)}</span>
                {b.update && (
                  <p className="project-status-update">{readable(b.update)}</p>
                )}
              </>,
            )
          ) : (
            <a
              className="project-status-link project-status-surface"
              href={brief}
            >
              <span>{readable(briefLabel[b.state])}</span>
              <ArrowUpRight
                className="project-status-surface-arrow"
                size={17}
                aria-hidden="true"
              />
            </a>
          )}
        </div>
        {b.headline && b.state !== "ready" && b.synthesized_at === null && (
          <p className="muted">
            <a className="project-status-link" href={brief}>
              {briefLabel[b.state]}
            </a>
          </p>
        )}
      </div>
      {primaryAction && (
        <div className="project-status-action">{primaryAction}</div>
      )}
      {highlights &&
        (highlights.progress.length > 0 ||
          highlights.task ||
          highlights.question) && (
          <section
            className="project-status-highlights"
            aria-label="Brief summary"
          >
            <a
              className="project-status-clock project-status-link"
              href={brief}
            >
              From the brief <span aria-hidden="true">·</span>{" "}
              <Stamp at={highlights.updated_at} prefix="" />
              <ChevronRight size={12} aria-hidden="true" />
            </a>
            {highlights.task &&
              sourceLink(
                highlights.task.id,
                <>
                  <h3>
                    <ListTodo size={15} aria-hidden="true" /> Next up
                  </h3>
                  <p className="project-status-task-name">
                    {readable(
                      highlights.task.summary?.title ?? highlights.task.text,
                    )}
                  </p>
                  {highlights.task.summary?.update && (
                    <p className="project-status-work-update">
                      {readable(highlights.task.summary.update)}
                    </p>
                  )}
                  {highlights.task.blocker && (
                    <div className="project-status-blocker">
                      <TriangleAlert size={15} aria-hidden="true" />
                      <p>
                        <strong>Blocked by</strong>
                        <span>{readable(highlights.task.blocker)}</span>
                      </p>
                    </div>
                  )}
                  {highlights.task.next &&
                    highlights.task.next !== highlights.task.text && (
                      <div className="project-status-step">
                        <ArrowRight size={15} aria-hidden="true" />
                        <p>
                          <strong>Next step</strong>
                          <span>{readable(highlights.task.next)}</span>
                        </p>
                      </div>
                    )}
                </>,
                "project-status-next",
              )}
            {(highlights.progress.length > 0 || highlights.question) && (
              <div className="project-status-context">
                {highlights.progress.length > 0 && (
                  <div className="project-status-progress">
                    <h3>
                      <Rows3 size={15} aria-hidden="true" />{" "}
                      <a
                        className="project-status-link"
                        href={briefSection("state")}
                      >
                        Also in this project
                        <ChevronRight size={12} aria-hidden="true" />
                      </a>
                    </h3>
                    <ul role="list">
                      {highlights.progress.map((item) => (
                        <li key={item.id}>
                          {sourceLink(
                            item.id,
                            <>
                              <span
                                className={
                                  item.summary
                                    ? "project-status-work-title"
                                    : ""
                                }
                              >
                                {readable(item.summary?.title ?? item.text)}
                              </span>
                              {item.summary?.update && (
                                <span className="project-status-work-update">
                                  {readable(item.summary.update)}
                                </span>
                              )}
                              {item.summary?.stage && (
                                <small className="project-status-work-stage">
                                  {briefStageLabels[item.summary.stage]}
                                </small>
                              )}
                            </>,
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {highlights.question &&
                  sourceLink(
                    highlights.question.id,
                    <>
                      <h3>
                        <CircleHelp size={15} aria-hidden="true" /> Open
                        question
                      </h3>
                      <p>
                        {readable(
                          highlights.question.summary?.title ??
                            highlights.question.text,
                        )}
                      </p>
                      {highlights.question.summary?.update && (
                        <small>
                          {readable(highlights.question.summary.update)}
                        </small>
                      )}
                    </>,
                    "project-status-question",
                  )}
              </div>
            )}
          </section>
        )}
      <footer>
        <a
          className="text-button project-status-open"
          href={
            setup && !attention
              ? threads
              : p.status === "blocked" && !attention
                ? briefItems("unfinished")
                : brief
          }
        >
          {setup
            ? attention
              ? "Enable brief"
              : "View threads"
            : p.status === "blocked" && !attention
              ? "Review blockers"
              : "Read brief"}{" "}
          <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </footer>
      {!!p.pulls.length && (
        <div className="project-status-pulls">
          <button
            className="project-status-caption project-status-link"
            onClick={onPulls}
          >
            Pull requests
          </button>
          <div className="project-status-chips">
            <div>
              <PullStateChip
                compact
                state={p.pulls[0].state}
                onOpen={onPulls}
              />
              <button className="project-status-link" onClick={onPulls}>
                <Stamp at={p.pulls[0].state.checked_at} prefix="Checked" />
              </button>
            </div>
            {p.pulls.length > 1 && (
              <button className="text-button" onClick={onPulls}>
                View all {p.pulls.length} <ChevronRight size={14} />
              </button>
            )}
          </div>
        </div>
      )}
      <details className="project-status-details">
        <summary>
          <span>
            <BookOpen size={15} aria-hidden="true" /> Details
          </span>
          <ChevronRight size={15} aria-hidden="true" />
        </summary>
        <div className="project-status-detail-body">
          <p className="project-status-caption">
            <a className="project-status-link" href={brief}>
              Recorded in the brief · separate from current activity
            </a>
          </p>
          {b.blockers === null ? (
            <p className="project-status-note">
              <a
                className="project-status-link"
                href={briefItems("unfinished")}
              >
                No blocker information in the brief
              </a>
            </p>
          ) : (
            b.blockers > 0 && (
              <p className="project-status-note">
                <a
                  className="project-status-link"
                  href={briefItems("unfinished")}
                >
                  {b.blockers} recorded{" "}
                  {b.blockers === 1 ? "blocker" : "blockers"}
                </a>
              </p>
            )
          )}
          {(b.unfinished !== null || b.questions !== null) && (
            <div className="project-status-ledger">
              {b.unfinished !== null && (
                <a
                  className="project-status-link project-status-surface"
                  href={briefItems("unfinished")}
                >
                  <span>Unfinished tasks</span>
                  <span className="project-status-total">
                    {b.unfinished}
                    <ChevronRight size={14} aria-hidden="true" />
                  </span>
                </a>
              )}
              {b.questions !== null && (
                <a
                  className="project-status-link project-status-surface"
                  href={briefItems("question")}
                >
                  <span>Open questions</span>
                  <span className="project-status-total">
                    {b.questions}
                    <ChevronRight size={14} aria-hidden="true" />
                  </span>
                </a>
              )}
            </div>
          )}
          {e ? (
            <div className="project-status-evidence">
              <button
                type="button"
                className="project-status-caption project-status-link"
                onClick={() => onEvidence("evidence")}
              >
                Latest task ·{" "}
                {readableAuthor("@" + e.agent.replace(/^@/, ""), agents)}
                <br />
                <span>{readable(e.task)}</span>
              </button>
              {(showCheckout || showVerification) && (
                <div className="project-status-chips">
                  {showCheckout && e.checkout && (
                    <div>
                      <CheckoutChip
                        compact
                        summary={e.checkout}
                        onOpen={() => onEvidence("checkout")}
                      />
                      <button
                        className="project-status-link"
                        onClick={() => onEvidence("checkout")}
                      >
                        <Stamp at={e.checkout_at} prefix="Captured" />
                      </button>
                    </div>
                  )}
                  {showVerification && (
                    <div>
                      <VerificationChip
                        compact
                        summary={e.verification}
                        onOpen={() => onEvidence("verification")}
                      />
                      <button
                        className="project-status-link"
                        onClick={() => onEvidence("verification")}
                      >
                        <Stamp at={e.verification_at} prefix="Observed" />
                      </button>
                    </div>
                  )}
                </div>
              )}
              {(!showCheckout || !showVerification) && (
                <p className="project-status-note">
                  <button
                    className="project-status-link"
                    onClick={() => onEvidence("evidence")}
                  >
                    {[
                      !showCheckout
                        ? e.checkout
                          ? `No tracked changes · captured ${e.checkout_at === null ? "time unavailable" : relativeTime(e.checkout_at)}`
                          : "File changes not recorded"
                        : "",
                      !showVerification
                        ? e.telemetry === "unavailable"
                          ? "Check results unavailable"
                          : `No checks recorded · ${e.verification_at === null ? "time unavailable" : relativeTime(e.verification_at)}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </button>
                </p>
              )}
            </div>
          ) : (
            !p.pulls.length && (
              <p className="project-status-note project-status-empty">
                <a className="project-status-link" href={threads}>
                  No task details or pull requests recorded
                </a>
              </p>
            )
          )}
        </div>
      </details>
      <BriefTokenUsage
        usage={b.generation_usage}
        recorded={b.synthesized_at !== null}
        statusCard
      />
    </article>
  );
}

export function ProjectStatusFeed({
  project,
  teams,
  sources,
  revision,
  onOpen,
}: {
  project?: string;
  teams?: string;
  sources?: AgentSource[];
  revision: number;
  onOpen: (conversation: string, message?: string, sourceId?: string) => void;
}) {
  const sourceId = useSourceId(),
    owner = viewOwner();
  // App's project/team selectors use the current workspace's bootstrap IDs,
  // just as in Feed. They cannot be applied to another source's namespace.
  const currentSource = sources?.find((s) => s.id === sourceId) ?? {
    id: sourceId,
    name: "This workspace",
  };
  const activeSources =
    sources && !project && !teams ? sources : [currentSource];
  const scope = JSON.stringify([
    owner,
    project,
    teams,
    activeSources.map((s) => s.id).sort(),
  ]);
  return (
    <StatusSession
      key={scope}
      scope={scope}
      sources={activeSources}
      project={project}
      teams={teams}
      revision={revision}
      onOpen={onOpen}
    />
  );
}

function StatusSession({
  scope,
  sources,
  project,
  teams,
  revision,
  onOpen,
}: {
  scope: string;
  sources: AgentSource[];
  project?: string;
  teams?: string;
  revision: number;
  onOpen: (conversation: string, message?: string, sourceId?: string) => void;
}) {
  const cacheKey = "project-status:" + scope;
  const [pages, setPages] = useState<SourcePage[]>(
    () =>
      cachedView<SourcePage[]>(cacheKey)?.map((p) => ({
        ...p,
        fresh: false,
      })) ?? sources.map((source) => ({ source, fresh: false })),
  );
  const pagesRef = useRef(pages),
    order = useRef<string[]>([]),
    alive = useRef(true),
    request = useRef(0);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState<string | null>(null);
  const [older, setOlder] = useState(false),
    [sheet, setSheet] = useState<{
      card: Card;
      kind: "checkout" | "verification" | "evidence" | "pulls" | "requests";
    } | null>(null);
  const [briefSource, setBriefSource] = useState<{
    card: Card;
    target: BriefEvidenceTarget;
  } | null>(null);
  const interacting = useRef(false),
    pending = useRef<SourcePage[] | null>(null),
    pendingReorder = useRef(false);
  const hold = useRef(false);
  const actionInFlight = useRef(false);
  hold.current = !!sheet || !!busy || !!briefSource;
  const commit = (next: SourcePage[], reorder = false) => {
    pagesRef.current = next;
    pendingReorder.current ||= reorder;
    if (interacting.current || hold.current) {
      pending.current = next;
      // Freeze action targets/layout while acting, but never freeze a Live
      // label after the source fails or its successful read expires.
      setPages((previous) =>
        previous.map((p) => {
          const current = next.find((n) => n.source.id === p.source.id);
          return { ...p, fresh: false, error: current?.error };
        }),
      );
    } else {
      if (pendingReorder.current) order.current = [];
      pendingReorder.current = false;
      setPages(next);
      pending.current = null;
    }
  };
  const release = () => {
    interacting.current = false;
    if (!hold.current && pending.current) {
      if (pendingReorder.current) order.current = [];
      pendingReorder.current = false;
      setPages(pending.current);
      pending.current = null;
    }
  };
  const load = async (reorder = false) => {
    const ticket = ++request.current,
      owner = viewOwner();
    const q = new URLSearchParams();
    if (project) q.set("project", project);
    if (teams) q.set("teams", teams);
    const settled = await Promise.allSettled(
      sources.map(async (s) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
          return await apiInWorkspace<ProjectStatusPage>(
            "/projects/status?" + q,
            s.id,
            undefined,
            undefined,
            controller.signal,
          );
        } finally {
          clearTimeout(timeout);
        }
      }),
    );
    if (!alive.current || ticket !== request.current || owner !== viewOwner())
      return;
    const next = settled.map((result, index): SourcePage =>
      result.status === "fulfilled"
        ? {
            source: sources[index],
            page: result.value,
            fresh: true,
            receivedAt: Date.now(),
          }
        : {
            ...pagesRef.current.find((p) => p.source.id === sources[index].id),
            source: sources[index],
            fresh: false,
            error: "Status unavailable",
          },
    );
    cacheView(cacheKey, next, owner);
    commit(next, reorder);
    setLoading(false);
  };
  useEffect(() => {
    alive.current = true;
    void load();
    const refresh = () => void load();
    const offline = () => {
      ++request.current;
      commit(
        pagesRef.current.map((p) => ({
          ...p,
          fresh: false,
          error: "Source disconnected",
        })),
      );
    };
    const timer = setInterval(refresh, 30_000);
    // A hanging refresh must not leave an indefinitely live-looking snapshot.
    const expiry = setInterval(() => {
      if (
        pagesRef.current.some(
          (p) => p.fresh && Date.now() - (p.receivedAt ?? 0) > 45_000,
        )
      )
        commit(
          pagesRef.current.map((p) => ({
            ...p,
            fresh: p.fresh && Date.now() - (p.receivedAt ?? 0) <= 45_000,
          })),
        );
    }, 5000);
    window.addEventListener("loop-source-refresh", refresh);
    window.addEventListener("offline", offline);
    window.addEventListener("online", refresh);
    return () => {
      alive.current = false;
      ++request.current;
      clearInterval(timer);
      clearInterval(expiry);
      window.removeEventListener("loop-source-refresh", refresh);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", refresh);
    };
  }, []);
  useEffect(() => {
    void load();
  }, [revision]);
  useEffect(() => {
    if (!sheet && !busy && !briefSource) release();
  }, [sheet, busy, briefSource]);
  const cards = pages.flatMap(
    (source) =>
      source.page?.items.map((project) => ({ project, source })) ?? [],
  );
  cards.sort(
    (a, b) =>
      compareProjectStatus(a.project, b.project) ||
      keyOf(a).localeCompare(keyOf(b)),
  );
  // Preserve the displayed order during refreshes. An explicit Refresh starts
  // a new ordering; new projects append in deterministic status order.
  const keys = new Set(cards.map(keyOf));
  order.current = [
    ...order.current.filter((k) => keys.has(k)),
    ...cards.map(keyOf).filter((k) => !order.current.includes(k)),
  ];
  cards.sort(
    (a, b) => order.current.indexOf(keyOf(a)) - order.current.indexOf(keyOf(b)),
  );
  const act = async (card: Card, target: ProjectStatusAction) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    const owner = viewOwner();
    setBusy(keyOf(card));
    setError("");
    try {
      const q = new URLSearchParams({ key: target.key });
      if (teams) q.set("teams", teams);
      const action = await apiInWorkspace<ProjectStatusAction>(
        `/projects/${encodeURIComponent(card.project.id)}/status-action?${q}`,
        card.source.source.id,
      );
      if (!alive.current || owner !== viewOwner()) return;
      if (action.kind === "not_sent")
        location.assign(
          statusUrl(card.source.source.id, {
            page: "profile",
            profileTab: "scheduled",
            scheduledSend: action.ref,
          }),
        );
      else if (action.kind === "review")
        location.assign(
          statusUrl(card.source.source.id, {
            page: "pulls",
            pull: `${action.pull.owner}/${action.pull.repo}/${action.pull.number}`,
          }),
        );
      else if (action.conversation)
        onOpen(
          action.conversation,
          action.message ?? undefined,
          card.source.source.id,
        );
      setSheet(null);
    } catch (e) {
      if (alive.current && owner === viewOwner()) {
        setError((e as Error).message);
        void load();
      }
    } finally {
      actionInFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  const render = (card: Card) => (
    <ProjectStatusCard
      key={keyOf(card)}
      item={card.project}
      fresh={card.source.fresh}
      observedAt={card.source.page!.observed_at}
      agents={card.source.page?.agents}
      sourceId={card.source.source.id}
      sourceName={sources.length > 1 ? card.source.source.name : undefined}
      busy={busy === keyOf(card)}
      onAction={(a) => void act(card, a)}
      onEvidence={(kind) => setSheet({ card, kind })}
      onPulls={() => setSheet({ card, kind: "pulls" })}
      onBriefSource={(target) => setBriefSource({ card, target })}
      onRequests={() => {
        setError("");
        setSheet({ card, kind: "requests" });
      }}
      teams={teams}
    />
  );
  return (
    <div
      className="project-status"
      onPointerDownCapture={() => {
        interacting.current = true;
      }}
      onPointerUpCapture={() => setTimeout(release, 0)}
      onPointerCancel={release}
      onKeyDownCapture={(e) => {
        if (e.key === "Enter" || e.key === " ") interacting.current = true;
      }}
      onKeyUpCapture={(e) => {
        if (e.key === "Enter" || e.key === " ") setTimeout(release, 0);
      }}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) release();
      }}
    >
      <div className="project-status-intro">
        <p>Across your projects</p>
        <button className="text-button" onClick={() => void load(true)}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {(project || teams) && (
        <p className="field-hint">
          Activity and evidence:{" "}
          {readableText(sources[0]?.name || "This workspace")}.
          {teams &&
            " Selected teams; briefs and recorded blockers describe the whole project."}
          {" Clear filters to see all workspaces."}
        </p>
      )}
      {pages
        .filter((p) => p.error)
        .map((p) => (
          <p className="error" role="status" key={p.source.id}>
            {readableText(p.source.name)}:{" "}
            {p.page
              ? `Last seen ${relativeTime(p.page.observed_at)}. Couldn’t refresh.`
              : "Status unavailable."}
          </p>
        ))}
      {error && (
        <p className="error" role="alert">
          {readableText(error)}
        </p>
      )}
      {loading && !cards.length ? (
        <p className="muted">Loading project status…</p>
      ) : !cards.length && pages.every((p) => p.fresh) ? (
        <p className="muted">No projects yet.</p>
      ) : null}
      {cards.filter((c) => !c.project.older).map(render)}
      {cards.some((c) => c.project.older) && (
        <div className="project-status-older">
          <button
            className="text-button"
            aria-expanded={older}
            onClick={() => setOlder(!older)}
          >
            Older projects ({cards.filter((c) => c.project.older).length}){" "}
            <ChevronRight size={16} />
          </button>
          {older && cards.filter((c) => c.project.older).map(render)}
        </div>
      )}
      {briefSource && (
        <BriefSourceSheet
          project={briefSource.card.project.id}
          target={briefSource.target}
          sourceId={briefSource.card.source.source.id}
          agents={briefSource.card.source.page?.agents ?? []}
          onClose={() => setBriefSource(null)}
        />
      )}
      {sheet?.kind === "requests" && (
        <Sheet title="Waiting for you" onClose={() => setSheet(null)}>
          {error && (
            <p className="error" role="alert">
              {readableText(error)}
            </p>
          )}
          <div className="project-status-requests">
            {sheet.card.project.actions.map((action) => (
              <button
                key={action.key}
                disabled={!!busy}
                onClick={() => void act(sheet.card, action)}
              >
                <span>
                  <strong>{action.title || actionLabel[action.kind]}</strong>
                  <small>
                    {actionLabel[action.kind]} · {relativeTime(action.at)}
                  </small>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {sheet?.kind === "checkout" && sheet.card.project.evidence && (
        <CheckoutSheet
          runId={sheet.card.project.evidence.run_id}
          load={(id) =>
            apiInWorkspace(`/runs/${id}/checkout`, sheet.card.source.source.id)
          }
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "verification" && sheet.card.project.evidence && (
        <VerificationSheet
          runId={sheet.card.project.evidence.run_id}
          load={(id) =>
            apiInWorkspace(
              `/runs/${id}/verifications`,
              sheet.card.source.source.id,
            )
          }
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "evidence" && (
        <Sheet title="Recorded run" onClose={() => setSheet(null)}>
          <p>
            {readableAuthor(
              "@" + sheet.card.project.evidence!.agent.replace(/^@/, ""),
              sheet.card.source.page?.agents,
            )}{" "}
            ·{" "}
            {createReadableText(sheet.card.source.page?.agents)(
              sheet.card.project.evidence!.task,
            )}
          </p>
          <p className="muted">
            Checkout and verification belong to this run. Project PR
            observations are separate.
          </p>
          {sheet.card.project.evidence!.checkout && (
            <CheckoutChip
              summary={sheet.card.project.evidence!.checkout!}
              onOpen={() => setSheet({ ...sheet, kind: "checkout" })}
            />
          )}
          {sheet.card.project.evidence!.verification ? (
            <VerificationChip
              summary={sheet.card.project.evidence!.verification}
              onOpen={() => setSheet({ ...sheet, kind: "verification" })}
            />
          ) : (
            <p>
              {sheet.card.project.evidence!.telemetry === "observed"
                ? "No checks recorded"
                : "Check results unavailable"}
            </p>
          )}
          <button
            className="text-button"
            onClick={() => {
              onOpen(
                sheet.card.project.evidence!.conversation,
                undefined,
                sheet.card.source.source.id,
              );
              setSheet(null);
            }}
          >
            Open run’s thread <ChevronRight size={16} />
          </button>
        </Sheet>
      )}
      {sheet?.kind === "pulls" && (
        <Sheet title="Project PR observations" onClose={() => setSheet(null)}>
          <p className="muted">
            All watches in this activity scope, with failures first. These
            observations are separate from the recorded run.
          </p>
          {sheet.card.project.pulls.map((p) => (
            <div className="project-status-pull-detail" key={p.id}>
              <p>
                {p.state.repo_owner}/{p.state.repo_name}
              </p>
              <PullStateChip
                state={p.state}
                onOpen={() =>
                  location.assign(
                    statusUrl(sheet.card.source.source.id, {
                      page: "pulls",
                      pull: `${p.state.repo_owner}/${p.state.repo_name}/${p.state.number}`,
                    }),
                  )
                }
              />
              <Stamp at={p.state.checked_at} prefix="Checked" />
            </div>
          ))}
        </Sheet>
      )}
    </div>
  );
}
