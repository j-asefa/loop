import { ErrorNotice } from "./ErrorNotice";

import {
  AgentId,
  ConversationId,
  MessageId,
  parseId,
} from "../shared/contract-ids.js";
import { literalEntry } from "./textEntry";
import { useSourceRoute, useSourceId } from "./SourceContext";
import { useEffect, useState } from "react";
import {
  AlarmClock,
  Bookmark,
  BookmarkCheck,
  CircleAlert,
  Copy,
  GitBranch,
  Link as LinkIcon,
  MessageSquareQuote,
  PencilLine,
  Reply,
  Search,
  ShieldCheck,
  Sparkles,
  TextQuote,
  User,
} from "lucide-react";

import { CollectionReadNotice, useProjectionQuery } from "./CollectionRead";

import { workspaceApi, type RouteResponse } from "../shared/workspace-api";

import { Sheet, type Action } from "./components";
import type { Agent } from "../shared/types";
import { USAGE_ORIGINS, usageOriginLabel } from "../shared/usage-origin";
import { compactNumber, dayLabel, preview, timeLabel } from "./threadView";

/**
 * A message's menu. Reply, Save and Remind me are the main actions; the rest
 * sit under More, each saying at the point of use what it does.
 */
export function messageActions({
  saved,
  canReply,
  canFork,
  onReply,
  onQuotePart,
  onCopy,
  onSave,
  onLater,
  onFork,
  onReuse,
  onSnippet,
  onShare,
}: {
  saved: boolean;
  canReply: boolean;
  canFork: boolean;
  onReply: () => void;
  onQuotePart: () => void;
  onCopy: () => void;
  onSave: () => void;
  onLater: () => void;
  onFork: () => void;
  onReuse: () => void;
  onSnippet: () => void;
  onShare: () => void;
}): { primary: Action[]; more: Action[] } {
  return {
    primary: [
      ...(canReply
        ? [
            {
              id: "reply",
              label: "Reply",
              icon: <Reply size={20} />,
              onSelect: onReply,
            },
          ]
        : []),
      {
        id: "save",
        label: saved ? "Unsave" : "Save",
        icon: saved ? <BookmarkCheck size={20} /> : <Bookmark size={20} />,
        onSelect: onSave,
      },
      {
        id: "later",
        label: "Remind me",
        icon: <AlarmClock size={20} />,
        onSelect: onLater,
      },
    ],
    more: [
      ...(canReply
        ? [
            {
              id: "quote-part",
              label: "Reply to part",
              hint: "Highlight the lines you mean. Only those are quoted to the agent.",
              icon: <TextQuote size={20} />,
              onSelect: onQuotePart,
            },
          ]
        : []),
      ...(canFork
        ? [
            {
              id: "fork",
              label: "Fork from here",
              hint: "New thread with the conversation up to this message. Files are not rewound.",
              icon: <GitBranch size={20} />,
              onSelect: onFork,
            },
          ]
        : []),
      {
        id: "reuse",
        label: "Reuse as prompt",
        hint: "Puts this text in an editable draft. Nothing is sent until you send it.",
        icon: <PencilLine size={20} />,
        onSelect: onReuse,
      },
      {
        id: "snippet",
        label: "Save as snippet",
        hint: "Stores it as reusable instructions. Type / in any composer to insert it.",
        icon: <Sparkles size={20} />,
        onSelect: onSnippet,
      },
      {
        id: "copy",
        label: "Copy text",
        icon: <Copy size={20} />,
        onSelect: onCopy,
      },
      {
        id: "share",
        label: "Share link",
        hint: "Opens this exact message on any paired device",
        icon: <LinkIcon size={20} />,
        onSelect: onShare,
      },
    ],
  };
}

/**
 * Reply to part of a message: the text is selectable as written, so the
 * excerpt is exactly what the message contains and the server can verify it.
 */
export function QuotePartSheet({
  content,
  onClose,
  onQuote,
}: {
  content: string;
  onClose: () => void;
  onQuote: (excerpt: string) => void;
}) {
  const [excerpt, setExcerpt] = useState("");
  const pick = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    setExcerpt(content.slice(t.selectionStart, t.selectionEnd).trim());
  };
  return (
    <Sheet title="Reply to part" onClose={onClose}>
      <p className="field-hint">
        Highlight the lines you mean. Only those are quoted to the agent.
      </p>
      <textarea
        {...literalEntry}
        className="quote-part-text"
        aria-label="Message text"
        readOnly
        rows={10}
        value={content}
        onSelect={pick}
      />
      <button
        className="primary"
        disabled={!excerpt}
        onClick={() => onQuote(excerpt)}
      >
        <TextQuote size={18} /> Reply to selection
      </button>
    </Sheet>
  );
}

type OutlineItem = RouteResponse<
  typeof workspaceApi.conversationOutline
>["items"][number];
const outlineIcon = {
  prompt: <User size={17} />,
  result: <MessageSquareQuote size={17} />,
  approval: <ShieldCheck size={17} />,
  failure: <CircleAlert size={17} />,
  saved: <Bookmark size={17} />,
};
const outlineLabel = {
  prompt: "You",
  result: "Result",
  approval: "Approval",
  failure: "Failed",
  saved: "Saved",
};

const matchLabel = {
  prompt: "You",
  response: "Agent",
  update: "Update",
  result: "Result",
  failure: "Failed",
};
const matchIcon = {
  prompt: <User size={17} />,
  response: <MessageSquareQuote size={17} />,
  update: <MessageSquareQuote size={17} />,
  result: <MessageSquareQuote size={17} />,
  failure: <CircleAlert size={17} />,
};
const outlineFilters = [
  ["all", "Everything"],
  ["prompt", "Your prompts"],
  ["result", "Results"],
  ["approval", "Approvals"],
  ["failure", "Failures"],
  ["saved", "Saved"],
] as const;

/**
 * Table of contents for a long thread: your prompts plus its decision
 * points, and a search across the text of every message in it.
 */
export function OutlineSheet({
  conversationId: rawConversationId,
  onJump,
  onClose,
}: {
  conversationId: string;
  onJump: (messageId: string) => void;
  onClose: () => void;
}) {
  const source = useSourceId();
  const conversationId = ConversationId.parse(rawConversationId);
  const outline = useProjectionQuery(
    workspaceApi.conversationOutline,
    {
      params: { id: conversationId },
    },
    { source, conversation: conversationId, mode: "once" },
  );
  const items = outline.data?.items;
  const [filter, setFilter] = useState<"all" | OutlineItem["kind"]>("all");
  const [query, setQuery] = useState({ text: "" });
  const text = query.text.trim();
  const [debounced, setDebounced] = useState<typeof query>();
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const ready = !!text && query === debounced;
  const search = useProjectionQuery(
    workspaceApi.conversationOutline,
    {
      params: { id: conversationId },
      query: { q: debounced?.text.trim() ?? "" },
    },
    { source, conversation: conversationId, mode: "once", enabled: ready },
  );
  const matches = ready ? search.data?.matches : undefined;
  const searching = !ready || search.loading || search.busy;
  const searchError = ready ? search.error : "";
  const visible = (items || []).filter(
    (item) => filter === "all" || item.kind === filter,
  );
  const filterName =
    outlineFilters.find(([value]) => value === filter)?.[1] || "Everything";
  const jump = (messageId: string) => {
    onClose();
    onJump(messageId);
  };
  let previous: number | undefined;
  return (
    <Sheet title="Jump to…" onClose={onClose} className="outline-sheet">
      <form
        className="search-box outline-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !search.busy) void search.retry();
        }}
      >
        <Search size={18} aria-hidden="true" />
        <input
          {...literalEntry}
          type="search"
          enterKeyHint="search"
          aria-label="Search this thread"
          placeholder="Search this thread"
          maxLength={200}
          value={query.text}
          onChange={(e) => setQuery({ text: e.target.value })}
        />
      </form>
      {text ? (
        <>
          <p className="outline-status" role="status">
            {searching || (!matches && !searchError)
              ? "Searching…"
              : searchError
                ? "Search unavailable"
                : `${plural(matches!.length, "match", "matches")} for “${text}”`}
          </p>
          {searchError && (
            <div>
              <ErrorNotice role="alert">{searchError}</ErrorNotice>
              <button
                type="button"
                className="secondary"
                onClick={() => void search.retry()}
                disabled={search.busy}
              >
                Try again
              </button>
            </div>
          )}
          <ol className="outline-list">
            {(matches || []).map((match) => (
              <li key={match.kind + match.message_id} data-kind={match.kind}>
                <button type="button" onClick={() => jump(match.message_id)}>
                  <span className="outline-icon" aria-hidden="true">
                    {matchIcon[match.kind]}
                  </span>
                  <span className="outline-copy">
                    <small>
                      {matchLabel[match.kind]}
                      {match.saved ? " · Saved" : ""} ·{" "}
                      {dayLabel(match.created_at)} {timeLabel(match.created_at)}
                    </small>
                    <span>{match.preview || "(no text)"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <>
          <div className="chip-row" role="group" aria-label="Show">
            {outlineFilters.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="chip"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {/* The chips can scroll out of view; this line always says what is shown. */}
          {items && (
            <p className="outline-status" role="status">
              Showing {filterName.toLowerCase()} · {visible.length}
            </p>
          )}
          {!items && !outline.error && <p role="status">Loading outline…</p>}
          {items && !visible.length && (
            <p className="note">Nothing to show in this view yet.</p>
          )}
          <ol className="outline-list">
            {visible.map((item) => {
              const day =
                previous === undefined ||
                dayLabel(previous) !== dayLabel(item.created_at);
              previous = item.created_at;
              return (
                <li key={item.kind + item.message_id} data-kind={item.kind}>
                  {day && (
                    <h3 className="day-label">{dayLabel(item.created_at)}</h3>
                  )}
                  <button type="button" onClick={() => jump(item.message_id)}>
                    <span className="outline-icon" aria-hidden="true">
                      {outlineIcon[item.kind]}
                    </span>
                    <span className="outline-copy">
                      <small>
                        {outlineLabel[item.kind]} · {timeLabel(item.created_at)}
                      </small>
                      <span>{preview(item.preview, 160) || "(no text)"}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {!text && <CollectionReadNotice {...outline} />}
    </Sheet>
  );
}

const plural = (count: number, word: string, multiple = `${word}s`) =>
  `${count} ${count === 1 ? word : multiple}`;

/**
 * Fork a thread from one message into a new conversation. Before it is
 * created, the sheet shows the message, the agent and the project, and that
 * only the conversation is copied: files are not rewound.
 */
export function ForkSheet({
  conversationId,
  messageId,
  source,
  projectName,
  agents,
  defaultAgentId,
  onClose,
  onForked,
}: {
  conversationId: string;
  messageId: string;
  /** The message the fork copies through. */
  source: { role: string; content: string; created_at: number };
  projectName?: string;
  agents: Agent[];
  defaultAgentId?: string;
  onClose: () => void;
  onForked: (conversationId: string, agentId: string) => void;
}) {
  const call = useSourceRoute();
  const choices = agents.filter((a) => a.connection_id && !a.retired_at);
  const [agentId, setAgentId] = useState(
    choices.find((a) => a.id === defaultAgentId)?.id || choices[0]?.id || "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Sheet title="Fork from here" onClose={onClose}>
      <figure className="fork-source">
        <figcaption>
          Copies the conversation through this{" "}
          {source.role === "user" ? "prompt of yours" : "message"} ·{" "}
          {dayLabel(source.created_at)} {timeLabel(source.created_at)}
        </figcaption>
        <blockquote>{preview(source.content, 220) || "(no text)"}</blockquote>
      </figure>
      <label>
        Continue with
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {choices.map((agent) => (
            <option key={agent.id} value={agent.id}>
              @{agent.name}
              {agent.id === defaultAgentId ? " (same agent)" : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="fork-project">
        Project: <strong>{projectName || "Unfiled"}</strong>
      </p>
      <ul className="fork-notes">
        <li>
          The new thread starts with the messages up to this point. The original
          thread is not changed.
        </li>
        <li>
          <strong>Files are not rewound.</strong> The fork copies conversation
          context only; the agent works with files as they are now.
        </li>
        {agentId !== defaultAgentId && (
          <li>
            @{choices.find((a) => a.id === agentId)?.name || "The agent"}{" "}
            receives the copied messages as context with your next prompt.
          </li>
        )}
      </ul>
      {error && <ErrorNotice role="alert">{error}</ErrorNotice>}
      <button
        type="button"
        className="primary"
        disabled={busy || !agentId}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const result = await call(workspaceApi.conversationFork, {
              params: { id: ConversationId.parse(conversationId) },
              body: {
                messageId: parseId(MessageId, messageId),
                agentId: parseId(AgentId, agentId),
              },
            });
            onForked(result.id, result.agentId);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <GitBranch size={17} /> {busy ? "Forking…" : "Create fork"}
      </button>
    </Sheet>
  );
}

type UsageTokens = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
};
// Harnesses count cached input inside input_tokens, so this is a share of it.
function usageText(usage: UsageTokens) {
  const cached =
    usage.cache_read_tokens && usage.input_tokens > 0
      ? Math.min(
          100,
          Math.round((usage.cache_read_tokens / usage.input_tokens) * 100),
        )
      : 0;
  return `${compactNumber(usage.input_tokens)} in${cached > 0 ? ` (${cached}% cached)` : ""} · ${compactNumber(usage.output_tokens)} out tokens`;
}
export function UsageLine({ usage }: { usage?: UsageTokens }) {
  if (!usage || usage.input_tokens + usage.output_tokens === 0) return null;
  return (
    <p className="usage-line" title="Recorded token usage for this response">
      {usageText(usage)}
    </p>
  );
}

/** Recorded tokens for the whole thread, grouped by what started each turn. */
export function ThreadUsage({
  usage,
}: {
  usage?: RouteResponse<typeof workspaceApi.conversationUsage>;
}) {
  if (!usage || usage.total.input_tokens + usage.total.output_tokens === 0)
    return null;
  const origins = USAGE_ORIGINS.flatMap((origin) => {
    const group = usage.origins[origin];
    return group ? [{ origin, group }] : [];
  }).sort((a, b) => b.group.input_tokens - a.group.input_tokens);
  return (
    <small aria-label="Thread usage">
      {usageText(usage.total)}
      {origins.map(({ origin, group }) => (
        <span key={origin} className="thread-usage-origin">
          {usageOriginLabel(origin)} · {group.turns}{" "}
          {group.turns === 1 ? "turn" : "turns"} · {usageText(group)}
        </span>
      ))}
    </small>
  );
}
