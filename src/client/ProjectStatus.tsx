import { useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { apiInWorkspace } from "./api";
import { useSourceId } from "./SourceContext";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import { sourceUrl } from "./sourceRouting";
import { relativeTime } from "./threadView";
import { CheckoutChip, CheckoutSheet } from "./Checkout";
import { VerificationChip, VerificationSheet } from "./Verification";
import { PullStateChip } from "./PullState";
import { Sheet } from "./components";
import type { AgentSource } from "./agentSources";
import {
  compareProjectStatus,
  type ProjectStatus,
  type ProjectStatusAction,
  type ProjectStatusPage,
} from "../shared/project-status";
import "./projectStatus.css";

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
  sourceId,
  busy,
  onAction,
  onEvidence,
  onPulls,
}: {
  item: ProjectStatus;
  fresh: boolean;
  observedAt: number;
  sourceName?: string;
  sourceId: string;
  busy: boolean;
  onAction: (action: ProjectStatusAction) => void;
  onEvidence: (kind: "checkout" | "verification" | "evidence") => void;
  onPulls: () => void;
}) {
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
  const attention = p.actions[0];
  const setup = b.state === "never" || b.state === "off";
  return (
    <article
      className="project-status-card"
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("a,button"))
          location.assign(destination);
      }}
    >
      <header>
        <a href={destination} className="project-status-name">
          {p.name}
        </a>
        <span className={`project-status-word status-${p.status}`}>
          {p.status.replace("_", " ")}
          {!fresh && " · last seen"}
        </span>
      </header>
      {sourceName && <p className="project-status-source">{sourceName}</p>}
      <div className="project-status-record">
        <p className="project-status-clock">
          {b.synthesized_at === null ? (
            "Project brief"
          ) : (
            <Stamp at={b.synthesized_at} prefix="Brief" />
          )}
          {b.pending > 0 && (
            <span>
              {" "}
              · {b.pending} {b.pending === 1 ? "update" : "updates"} pending
            </span>
          )}
          {b.state !== "ready" && b.synthesized_at !== null && (
            <span> · {briefLabel[b.state]}</span>
          )}
        </p>
        <h3>{b.headline || briefLabel[b.state]}</h3>
        {b.headline && b.state !== "ready" && b.synthesized_at === null && (
          <p className="muted">{briefLabel[b.state]}</p>
        )}
      </div>
      <p className="project-status-counts">
        <span className={fresh ? "status-live" : ""}>
          {fresh ? "Live" : `Last seen ${relativeTime(observedAt)}`}
        </span>
        {p.counts.needs > 0 && <span>{p.counts.needs} needs you</span>}
        {p.counts.working > 0 && <span>{p.counts.working} working</span>}
        {p.counts.queued > 0 && <span>{p.counts.queued} queued</span>}
        {!p.counts.needs && !p.counts.working && !p.counts.queued && (
          <span>No active work</span>
        )}
      </p>
      {b.blockers === null ? (
        <p className="project-status-note">Blockers not recorded in a brief</p>
      ) : (
        b.blockers > 0 && (
          <p className="project-status-note">
            {b.blockers} recorded {b.blockers === 1 ? "blocker" : "blockers"}
          </p>
        )
      )}
      {e ? (
        <div className="project-status-evidence">
          <button
            type="button"
            className="project-status-caption"
            onClick={() => onEvidence("evidence")}
          >
            Latest recorded run · @{e.agent}
            <br />
            <span>{e.task}</span>
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
                  <Stamp at={e.checkout_at} prefix="Captured" />
                </div>
              )}
              {showVerification && (
                <div>
                  <VerificationChip
                    compact
                    summary={e.verification}
                    onOpen={() => onEvidence("verification")}
                  />
                  <Stamp at={e.verification_at} prefix="Observed" />
                </div>
              )}
            </div>
          )}
          {(!showCheckout || !showVerification) && (
            <p className="project-status-note">
              {[
                !showCheckout
                  ? e.checkout
                    ? `No tracked changes · captured ${e.checkout_at === null ? "time unavailable" : relativeTime(e.checkout_at)}`
                    : "Checkout not captured"
                  : "",
                !showVerification
                  ? e.telemetry === "unavailable"
                    ? "Verification telemetry unavailable"
                    : `No checks observed · ${e.verification_at === null ? "time unavailable" : relativeTime(e.verification_at)}`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>
      ) : (
        !p.pulls.length && (
          <p className="project-status-note project-status-empty">
            No captured run or linked PR
          </p>
        )
      )}
      {!!p.pulls.length && (
        <div className="project-status-pulls">
          <p className="project-status-caption">
            Project PR {p.pulls.length === 1 ? "observation" : "observations"}
          </p>
          <div className="project-status-chips">
            <div>
              <PullStateChip
                compact
                state={p.pulls[0].state}
                onOpen={onPulls}
              />
              <Stamp at={p.pulls[0].state.checked_at} prefix="Checked" />
            </div>
            {p.pulls.length > 1 && (
              <button className="text-button" onClick={onPulls}>
                All {p.pulls.length} watches <ChevronRight size={14} />
              </button>
            )}
          </div>
        </div>
      )}
      {(b.unfinished !== null || b.questions !== null) && (
        <p className="project-status-ledger">
          <a href={brief}>
            {b.unfinished ?? "Unknown"} unfinished · {b.questions ?? "Unknown"}{" "}
            open {b.questions === 1 ? "question" : "questions"}
          </a>
        </p>
      )}
      <footer>
        {attention ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() => onAction(attention)}
          >
            {busy ? "Checking…" : actionLabel[attention.kind]}{" "}
            <ChevronRight size={15} />
          </button>
        ) : b.state === "never" || b.state === "off" ? (
          <a className="primary" href={brief}>
            Enable brief <ChevronRight size={15} />
          </a>
        ) : b.state === "failed" ? (
          <a className="primary" href={brief}>
            Review brief <ChevronRight size={15} />
          </a>
        ) : null}
        <a className="text-button" href={setup && !attention ? threads : brief}>
          {setup ? (attention ? "Enable brief" : "Threads") : "Brief"}{" "}
          <ChevronRight size={15} />
        </a>
      </footer>
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
  const activeSources =
    sources && !project && !teams
      ? sources
      : [{ id: sourceId, name: "This workspace" }];
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
      kind: "checkout" | "verification" | "evidence" | "pulls";
    } | null>(null);
  const interacting = useRef(false),
    pending = useRef<SourcePage[] | null>(null);
  const hold = useRef(false);
  const actionInFlight = useRef(false);
  hold.current = !!sheet || !!busy;
  const commit = (next: SourcePage[]) => {
    pagesRef.current = next;
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
      setPages(next);
      pending.current = null;
    }
  };
  const release = () => {
    interacting.current = false;
    if (!hold.current && pending.current) {
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
    if (reorder && !interacting.current && !hold.current) order.current = [];
    commit(next);
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
    if (!sheet && !busy) release();
  }, [sheet, busy]);
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
      else if (action.conversation)
        onOpen(
          action.conversation,
          action.message ?? undefined,
          card.source.source.id,
        );
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
      sourceId={card.source.source.id}
      sourceName={sources.length > 1 ? card.source.source.name : undefined}
      busy={busy === keyOf(card)}
      onAction={(a) => void act(card, a)}
      onEvidence={(kind) => setSheet({ card, kind })}
      onPulls={() => setSheet({ card, kind: "pulls" })}
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
      onFocusCapture={() => {
        interacting.current = true;
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
      {teams && (
        <p className="field-hint">
          Activity and evidence: selected teams. Briefs and recorded blockers:
          whole project.
        </p>
      )}
      {pages
        .filter((p) => p.error)
        .map((p) => (
          <p className="error" role="status" key={p.source.id}>
            {p.source.name}:{" "}
            {p.page
              ? `Last seen ${relativeTime(p.page.observed_at)}. Couldn’t refresh.`
              : "Status unavailable."}
          </p>
        ))}
      {error && (
        <p className="error" role="alert">
          {error}
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
            @{sheet.card.project.evidence!.agent} ·{" "}
            {sheet.card.project.evidence!.task}
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
                ? "No checks observed"
                : "Verification telemetry unavailable"}
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
