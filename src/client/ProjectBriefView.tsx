import { useId, type MouseEvent, type ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDashed,
  Clock3,
  FileText,
  HelpCircle,
  Link2,
  ListTodo,
  Pin,
  Pencil,
  Plus,
  Settings2,
  TriangleAlert,
} from "lucide-react";
import { briefAttentionUrl, briefSourceUrl } from "./briefView";
import { relativeTime } from "./threadView";
import { useReadableAuthor, useReadableText } from "./ReadableText";
import type { BriefPage, BriefSource, Item } from "../shared/briefs";
import { BriefTokenUsage } from "./BriefTokenUsage";
import { briefStageLabels } from "../shared/brief-reading";
import { itemCitations } from "./BriefItemContent";
import { DeploymentStatus } from "./BuildStatus";

export const briefSections = [
  ["state", "Updates", "state"],
  ["decisions", "Decisions", "decision"],
  ["open_questions", "Questions", "question"],
  ["unfinished", "Next", "unfinished"],
] as const;
export type BriefSection = (typeof briefSections)[number][0];
const itemIcons = {
  state: CircleDashed,
  decision: FileText,
  question: HelpCircle,
  unfinished: ListTodo,
};
const attentionLabels = {
  approval: ["Approval needed", "Review approval"],
  question: ["A question needs your answer", "Answer question"],
  review: ["A pull request needs review", "Review pull request"],
  failed: ["A run needs a closer look", "Review failure"],
  not_sent: ["Message not sent", "Review scheduled message"],
};

/** A single labelled panel, with automatic activation and roving keyboard focus. */
export function BriefTabs<T extends string>({
  label,
  value,
  options,
  onChange,
  children,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <>
      <div className="brief-tabs" role="tablist" aria-label={label}>
        {options.map((option, index) => (
          <button
            type="button"
            role="tab"
            key={option.value}
            aria-label={
              option.count === undefined
                ? option.label
                : `${option.label} ${option.count}`
            }
            id={`${id}-${option.value}`}
            aria-controls={`${id}-panel`}
            aria-selected={value === option.value}
            tabIndex={value === option.value ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? options.length - 1
                    : event.key === "ArrowRight"
                      ? (index + 1) % options.length
                      : event.key === "ArrowLeft"
                        ? (index + options.length - 1) % options.length
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              onChange(options[next].value);
              const tabs =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                );
              tabs?.[next].focus();
            }}
          >
            {option.label}
            {option.count !== undefined && <span>{option.count}</span>}
          </button>
        ))}
      </div>
      <div
        className="brief-tab-panel"
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${value}`}
        tabIndex={0}
      >
        {children}
      </div>
    </>
  );
}

export function BriefCitations({
  item,
  sources,
  workspace,
  onNavigate,
}: {
  item: Pick<Item, "cite" | "answered_cite" | "summary">;
  sources: Record<string, BriefSource>;
  workspace: string;
  onNavigate: (url: string) => void;
}) {
  const readable = useReadableText();
  const cites = itemCitations(item);
  return (
    <div className="brief-citations">
      {cites.map((cite, index) => {
        const source = sources[cite.ref],
          href = source && briefSourceUrl(source, workspace);
        return href ? (
          <a
            className="chip"
            key={cite.ref + index}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(href);
            }}
            aria-label={`Open source: ${readable(source.title)}`}
          >
            <ArrowUpRight size={14} aria-hidden="true" />
            {readable(source.title)}
          </a>
        ) : (
          <span className="chip muted" key={cite.ref + index}>
            Source unavailable
          </span>
        );
      })}
    </div>
  );
}

export function BriefItemCard({
  item,
  sources,
  workspace,
  onNavigate,
  onItem,
  author,
  changed,
  replacement,
  compact = false,
}: {
  item: Item;
  sources: Record<string, BriefSource>;
  workspace: string;
  onNavigate: (url: string) => void;
  onItem: (item: Item) => void;
  author: (id: string) => string;
  changed?: boolean;
  replacement?: string;
  compact?: boolean;
}) {
  const readable = useReadableText();
  const Icon = item.pinned ? Pin : itemIcons[item.kind];
  const sourcesCount = new Set(itemCitations(item).map((cite) => cite.ref))
    .size;
  return (
    <article className={"brief-item" + (compact ? " brief-item-compact" : "")}>
      <button
        type="button"
        className="brief-item-open"
        onClick={() => onItem(item)}
      >
        <Icon className="brief-item-icon" size={16} aria-hidden="true" />
        <span className="brief-item-copy">
          <span
            className={item.status === "superseded" ? "brief-superseded" : ""}
          >
            {readable(item.summary?.title ?? item.text)}
          </span>
          {item.summary?.update && (
            <small className="brief-reading-update">
              {readable(item.summary.update)}
            </small>
          )}
          {!compact && (
            <>
              {item.why && <small>{readable(item.why)}</small>}
              {item.asked_by && (
                <small>Asked by {readable(author(item.asked_by))}</small>
              )}
              {item.decided_by && (
                <small>Decided by {readable(author(item.decided_by))}</small>
              )}
              {item.next && <small>Next · {readable(item.next)}</small>}
              {item.blocker && (
                <small className="brief-blocker">
                  Blocked · {readable(item.blocker)}
                </small>
              )}
              {replacement && (
                <small>Replaced by · {readable(replacement)}</small>
              )}
            </>
          )}
          <span className="brief-markers">
            {(!compact || !item.summary) && (
              <span>
                <Link2 size={12} aria-hidden="true" />
                {sourcesCount} {sourcesCount === 1 ? "source" : "sources"}
              </span>
            )}
            {compact && item.summary && item.decided_by && (
              <span>
                {item.decided_by === "you"
                  ? "Chosen by you"
                  : `Chosen by ${readable(author(item.decided_by))}`}
              </span>
            )}
            {item.pinned && <span>Pinned</span>}
            {item.cite_stale && <span>Source changed</span>}
            {changed && <span className="brief-new">Updated</span>}
            {item.blocker && compact && (
              <span className="brief-blocker">Blocked</span>
            )}
            {!["active", "open"].includes(item.status) && (
              <span>{item.status}</span>
            )}
          </span>
        </span>
        <ChevronRight
          size={14}
          className="brief-item-chevron"
          aria-hidden="true"
        />
      </button>
      {!compact && (
        <BriefCitations
          item={item}
          sources={sources}
          workspace={workspace}
          onNavigate={onNavigate}
        />
      )}
    </article>
  );
}

type ViewProps = {
  brief: BriefPage;
  section: BriefSection;
  onSectionChange: (section: BriefSection) => void;
  workspace?: string;
  author?: (id: string) => string;
  onNavigate: (url: string) => void;
  onItem: (item: Item) => void;
  onAll: (kind: Item["kind"]) => void;
  onGoal: () => void;
  onSettings: () => void;
  onHistory: () => void;
  onDecision: () => void;
  onHeadline?: () => void;
};

export function ProjectBriefView({
  brief,
  section,
  onSectionChange,
  workspace = "",
  author: authorOverride,
  onNavigate,
  onItem,
  onAll,
  onGoal,
  onSettings,
  onHistory,
  onDecision,
  onHeadline,
}: ViewProps) {
  const readable = useReadableText();
  const defaultAuthor = useReadableAuthor();
  const author = authorOverride ?? defaultAuthor;
  const selected = briefSections.find(([key]) => key === section)!;
  const changed = new Set(brief.changes.map((change) => change.id));
  const reading = brief[section].some((item) => item.summary);
  const groups = new Map<string, Item[]>();
  for (const item of brief[section].slice(0, reading ? 5 : 2)) {
    const label =
      section === "state" && item.summary?.stage && !item.cite_stale
        ? briefStageLabels[item.summary.stage]
        : "";
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  const headlineParams = new URLSearchParams({
    page: "projects",
    projectView: brief.project,
    projectTab: "brief",
    briefEvidence: "headline",
    briefVersion: String(brief.version),
  });
  if (workspace) headlineParams.set("source", workspace);
  const needs = brief.needs_you;
  const pullRequests = brief.artifacts.filter(
    (artifact) => artifact.kind === "pr",
  );
  const pullsParams = new URLSearchParams({ page: "pulls" });
  if (workspace) pullsParams.set("source", workspace);
  const attentionLink = (need: BriefPage["needs_you"][number]) =>
    briefAttentionUrl(
      need,
      brief.attention[need.ref] ?? {
        conversation: need.conversation,
        message: null,
      },
      workspace,
    );
  const navigate = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate(href);
  };
  const quiet =
    brief.status === "blocked"
      ? "Work is blocked. See Next for the details."
      : brief.status === "working"
        ? "Work is in progress. Nothing needs you right now."
        : "Nothing needs you right now.";
  const QuietIcon =
    brief.status === "blocked"
      ? TriangleAlert
      : brief.status === "working"
        ? Clock3
        : Check;
  return (
    <div className="project-brief">
      <DeploymentStatus observations={brief.deployments} source={workspace} />
      <section className="brief-headline" aria-label="Project brief">
        <div className="brief-heading">
          <span className="brief-eyebrow">Project brief</span>
          <span className="brief-freshness">
            <Clock3 size={12} aria-hidden="true" />
            {brief.basis.synth_at !== null ? (
              <time
                dateTime={new Date(brief.basis.synth_at).toISOString()}
                title={new Date(brief.basis.synth_at).toLocaleString()}
              >
                {brief.settings.enabled ? "Updated" : "Recorded"}{" "}
                {relativeTime(brief.basis.synth_at).replace(
                  "Just now",
                  "just now",
                )}
              </time>
            ) : (
              "Not generated yet"
            )}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Brief settings"
            onClick={onSettings}
          >
            <Settings2 size={17} />
          </button>
        </div>
        <div className={brief.headline ? "brief-focus" : ""}>
          {brief.headline ? (
            <a
              href={"/?" + headlineParams}
              onClick={(event) => {
                if (
                  onHeadline &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  !event.altKey &&
                  event.button === 0
                ) {
                  event.preventDefault();
                  onHeadline();
                }
              }}
            >
              <span className="brief-reading-label">In focus</span>
              <h2>{readable(brief.headline.text)}</h2>
              {brief.headline.update && (
                <p>{readable(brief.headline.update)}</p>
              )}
              <ArrowUpRight
                className="brief-focus-arrow"
                size={17}
                aria-hidden="true"
              />
            </a>
          ) : (
            <h2>Your project, taking shape.</h2>
          )}
        </div>
        {brief.goal ? (
          <button type="button" className="brief-goal" onClick={onGoal}>
            <span>
              <small>Goal · you</small>
              <strong>{readable(brief.goal.text)}</strong>
            </span>
            <Pencil size={14} aria-hidden="true" />
          </button>
        ) : (
          <>
            {!brief.headline && (
              <p className="brief-intro">
                Decisions, questions and next steps, with the record behind
                them.
              </p>
            )}
            <button
              type="button"
              className="text-button brief-goal"
              onClick={onGoal}
            >
              Set a project goal <Plus size={14} aria-hidden="true" />
            </button>
          </>
        )}
        {(brief.basis.pending > 0 ||
          brief.basis.unincorporated_before !== null) && (
          <div className="brief-notice">
            {brief.basis.pending > 0 && (
              <p>
                {brief.basis.pending} newer{" "}
                {brief.basis.pending === 1 ? "event is" : "events are"} waiting
                to be incorporated.
              </p>
            )}
            {brief.basis.unincorporated_before !== null && (
              <p>Older project history has not been fully incorporated.</p>
            )}
          </div>
        )}
        {brief.settings.lastError && (
          <div className="brief-notice error" role="alert">
            <p>
              The brief could not update. {readable(brief.settings.lastError)}
            </p>
            <button type="button" className="text-button" onClick={onSettings}>
              Check brief settings
            </button>
          </div>
        )}
      </section>
      {needs.length ? (
        <section className="brief-attention" aria-label="Needs you">
          <div className="brief-attention-heading">
            <span className="brief-status needs_you">Needs you</span>
            <span>
              {needs.length} {needs.length === 1 ? "request" : "requests"}
            </span>
          </div>
          <h3>{attentionLabels[needs[0].kind][0]}</h3>
          <div className="brief-attention-action">
            <span>In this project</span>
            <a
              className="primary"
              href={attentionLink(needs[0])}
              onClick={navigate(attentionLink(needs[0]))}
            >
              {attentionLabels[needs[0].kind][1]}
              <ArrowRight size={15} aria-hidden="true" />
            </a>
          </div>
          {needs.length > 1 && (
            <details className="brief-more-attention">
              <summary>
                {needs.length - 1} more{" "}
                {needs.length === 2 ? "request" : "requests"}
              </summary>
              {needs.slice(1).map((need) => (
                <a
                  key={need.kind + need.ref}
                  href={attentionLink(need)}
                  onClick={navigate(attentionLink(need))}
                >
                  {attentionLabels[need.kind][1]}
                  <ArrowUpRight size={15} aria-hidden="true" />
                </a>
              ))}
            </details>
          )}
        </section>
      ) : (
        <div className={`brief-quiet ${brief.status}`}>
          <QuietIcon size={17} aria-hidden="true" />
          <span>{quiet}</span>
        </div>
      )}
      <section className="brief-record" aria-label="Project record">
        <div className="brief-section-heading">
          <h3>Project record</h3>
          <button
            type="button"
            className="icon-button"
            aria-label="Record a decision"
            onClick={onDecision}
          >
            <Plus size={18} />
          </button>
        </div>
        <BriefTabs
          label="Project record"
          value={section}
          onChange={onSectionChange}
          options={briefSections.map(([key, label]) => ({
            value: key,
            label,
            count: brief[key].length + brief.overflow[key],
          }))}
        >
          {[...groups].map(([label, items]) => (
            <div
              className={
                "brief-update-group" +
                (label === briefStageLabels.awaiting_update
                  ? " brief-update-waiting"
                  : "")
              }
              key={label}
            >
              {label && <h4>{label}</h4>}
              <div className="brief-record-items">
                {items.map((item) => (
                  <BriefItemCard
                    key={item.id}
                    item={item}
                    sources={brief.sources}
                    workspace={workspace}
                    onNavigate={onNavigate}
                    onItem={onItem}
                    author={author}
                    changed={changed.has(item.id)}
                    compact
                  />
                ))}
              </div>
            </div>
          ))}
          {!brief[section].length && (
            <p className="brief-empty">
              {
                {
                  state: "No current state recorded.",
                  decisions: "No active decisions recorded.",
                  open_questions: "No open questions recorded.",
                  unfinished: "No unfinished work recorded.",
                }[section]
              }
            </p>
          )}
          <button
            type="button"
            className="text-button brief-all"
            onClick={() => onAll(selected[2])}
          >
            View full{" "}
            {section === "unfinished"
              ? "unfinished work"
              : section === "open_questions"
                ? "question"
                : section === "decisions"
                  ? "decision"
                  : "update"}{" "}
            record
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </BriefTabs>
      </section>
      <footer className="brief-record-footer">
        <div className="brief-meta">
          <details className="brief-provenance">
            <summary>
              <Link2 size={13} aria-hidden="true" />
              {brief.coverage.results}{" "}
              {brief.coverage.results === 1 ? "result" : "results"} ·{" "}
              {brief.coverage.threads}{" "}
              {brief.coverage.threads === 1 ? "thread" : "threads"}
            </summary>
            <div className="brief-provenance-detail">
              <p>
                {readable(brief.basis.window)} ·{" "}
                {readable(brief.coverage.model || "No model generation yet")}
              </p>
              {brief.headline && (
                <BriefCitations
                  item={{ cite: brief.headline.cite }}
                  sources={brief.sources}
                  workspace={workspace}
                  onNavigate={onNavigate}
                />
              )}
              {brief.artifacts
                .filter((artifact) => artifact.kind !== "pr")
                .map((artifact) => {
                  const params = new URLSearchParams({
                    artifact: artifact.ref,
                  });
                  if (workspace) params.set("source", workspace);
                  const href = "/?" + params;
                  return (
                    <a
                      className="brief-artifact"
                      key={artifact.kind + artifact.ref}
                      href={href}
                      onClick={navigate(href)}
                    >
                      {artifact.kind === "chart"
                        ? "Published chart"
                        : "Published file"}{" "}
                      · {readable(artifact.state)}
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </a>
                  );
                })}
              {pullRequests.length > 0 && (
                <div className="brief-linked-pulls">
                  <p>
                    {pullRequests.length} linked{" "}
                    {pullRequests.length === 1
                      ? "pull request"
                      : "pull requests"}
                  </p>
                  <a
                    className="brief-artifact"
                    href={"/?" + pullsParams}
                    onClick={navigate("/?" + pullsParams)}
                  >
                    Browse all pull requests
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </a>
                </div>
              )}
            </div>
          </details>
          <button
            type="button"
            className="text-button brief-changes"
            onClick={onHistory}
          >
            {brief.changes.length
              ? `${brief.changes.length} ${brief.changes.length === 1 ? "update" : "updates"}`
              : "History"}
            <ArrowUpRight size={13} aria-hidden="true" />
          </button>
        </div>
        <BriefTokenUsage
          usage={brief.generation_usage}
          recorded={brief.basis.synth_at !== null}
        />
      </footer>
    </div>
  );
}
