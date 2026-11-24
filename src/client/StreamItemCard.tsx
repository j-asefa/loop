import {
  AlarmClock,
  ArrowUpRight,
  Bookmark,
  Check,
  Mail,
  MessageSquare,
  MessageSquarePlus,
  X,
} from "lucide-react";
import { SocialStoryId } from "../shared/contract-ids.js";
import { defaultStreamAskPrompt, type StreamItem } from "../shared/stream-item";
import { workspaceApi } from "../shared/workspace-api";
import { routeUrl } from "./api";
import { Sheet } from "./components";
import { FeedMark } from "./FeedMark";
import { useSwipe } from "./gestures";
import { relativeTime } from "./threadView";

const plural = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function streamImageUrl(item: StreamItem): string | null {
  if (item.kind !== "rss" || !item.meta.image) return null;
  const parsed = SocialStoryId.safeParse(item.rawId);
  if (!parsed.success) return null;
  return routeUrl(
    workspaceApi.socialImage,
    { query: { story: parsed.data } },
    "",
  );
}

function StreamMark({ item }: { item: StreamItem }) {
  if (item.kind === "email") {
    return (
      <span
        className="avatar generated news-mark feed-initial"
        role="img"
        aria-label={item.sourceLabel}
      >
        <Mail size={18} aria-hidden="true" />
      </span>
    );
  }
  return (
    <FeedMark
      feed={{
        name: item.sourceLabel,
        color: item.meta.color ?? "#5b6472",
        home: item.meta.home ?? "",
        mark: item.meta.mark,
      }}
    />
  );
}

/**
 * Renders an external stream item (RSS today, Email later) inside Loop's main
 * Feed with unified swipe verbs (swipe left to dismiss, right to remind) and
 * tap-to-read sheet.
 */
export function StreamItemCard({
  item,
  images,
  onOpen,
  onDismiss,
  onRemind,
  onMarkRead,
  onAsk,
}: {
  item: StreamItem;
  images: boolean;
  onOpen: (item: StreamItem) => void;
  onDismiss: (item: StreamItem) => void;
  onRemind: (item: StreamItem) => void;
  onMarkRead: (item: StreamItem, read: boolean) => void;
  onAsk?: (text: string, item: StreamItem) => void;
}) {
  const swipe = useSwipe({
    onLeft: () => onDismiss(item),
    onRight: () => onRemind(item),
  });

  const eyebrow =
    item.kind === "email"
      ? "Email"
      : (item.meta.feedKind || "story").replace(/^\w/, (c) => c.toUpperCase());
  const originLabel = item.meta.site || item.meta.home || "";

  return (
    <li>
      <div
        className={
          "card-swipe story-swipe" +
          (swipe.armed ? " armed-" + swipe.armed : "") +
          (swipe.offset ? " swiping" : "")
        }
        {...swipe.handlers}
      >
        {swipe.offset > 0 && (
          <span className="swipe-under left" aria-hidden="true">
            <AlarmClock size={20} /> Remind me
          </span>
        )}
        {swipe.offset < 0 && (
          <span className="swipe-under right" aria-hidden="true">
            <X size={20} /> Dismiss
          </span>
        )}
        <div
          className="story-swipe-card"
          style={
            swipe.offset
              ? { transform: `translateX(${swipe.offset}px)` }
              : undefined
          }
        >
          <article
            className="feed-card news-card stream-card"
            data-unread={item.read ? undefined : "true"}
            data-stream-kind={item.kind}
            data-stream-id={item.id}
          >
            <div className="card-byline">
              <span className="identity">
                <StreamMark item={item} />
                <span>
                  <strong>{item.sourceLabel}</strong>
                  <span className="subline">
                    {item.meta.author && <span>by {item.meta.author}</span>}
                    {item.timestamp > 0 && (
                      <time dateTime={new Date(item.timestamp).toISOString()}>
                        {relativeTime(item.timestamp)}
                      </time>
                    )}
                    {!item.read && (
                      <span className="stream-unread-label">Unread</span>
                    )}
                  </span>
                </span>
              </span>
            </div>

            <button
              type="button"
              className="card-content stream-card-open"
              onClick={() => onOpen(item)}
            >
              {images && streamImageUrl(item) && (
                <img
                  className="news-image"
                  src={streamImageUrl(item)!}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              )}
              <span className="eyebrow feed-eyebrow">
                {eyebrow}
                {originLabel && (
                  <span className="card-project"> · {originLabel}</span>
                )}
              </span>
              <h2>{item.title}</h2>
              {item.excerpt && <p className="news-summary">{item.excerpt}</p>}
              {item.meta.media && (
                <p className="field-hint news-media">
                  {item.meta.media.type.startsWith("audio/")
                    ? "Audio"
                    : "Video"}
                  {item.meta.media.seconds
                    ? ` · ${Math.round(item.meta.media.seconds / 60)} min`
                    : ""}
                </p>
              )}
              {(item.meta.points != null || item.meta.comments != null) && (
                <p className="field-hint news-stats">
                  {[
                    item.meta.points != null &&
                      plural(item.meta.points, "point"),
                    item.meta.comments != null &&
                      plural(item.meta.comments, "comment"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </button>

            <div className="card-actions">
              {onAsk && (
                <button
                  type="button"
                  onClick={() => {
                    if (!item.read) onMarkRead(item, true);
                    onAsk(defaultStreamAskPrompt(item), item);
                  }}
                >
                  <MessageSquarePlus size={16} aria-hidden="true" />
                  Ask an agent
                </button>
              )}
              <button
                type="button"
                onClick={() => onRemind(item)}
                aria-label={`Save or remind me about ${item.title}`}
              >
                <Bookmark size={16} aria-hidden="true" />
                Save
              </button>
              {item.url && (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    if (!item.read) onMarkRead(item, true);
                  }}
                >
                  <ArrowUpRight size={16} aria-hidden="true" />
                  Open
                </a>
              )}
              {item.discussionUrl && (
                <a
                  href={item.discussionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    if (!item.read) onMarkRead(item, true);
                  }}
                >
                  <MessageSquare size={16} aria-hidden="true" />
                  Discussion
                </a>
              )}
            </div>
          </article>
        </div>
      </div>
    </li>
  );
}

/** Reading sheet for an external stream item opened from Loop's main Feed. */
export function StreamItemReader({
  item,
  images,
  onClose,
  onDismiss,
  onRemind,
  onMarkRead,
  onAsk,
}: {
  item: StreamItem;
  images: boolean;
  onClose: () => void;
  onDismiss: (item: StreamItem) => void;
  onRemind: (item: StreamItem) => void;
  onMarkRead: (item: StreamItem, read: boolean) => void;
  onAsk?: (text: string, item: StreamItem) => void;
}) {
  const originLabel = item.meta.site || item.meta.home || "";
  return (
    <Sheet
      title={item.sourceLabel}
      onClose={onClose}
      className="result-sheet stream-reader-sheet"
    >
      <div className="stream-reader-header">
        <StreamMark item={item} />
        <div>
          <strong>{item.sourceLabel}</strong>
          <div className="subline">
            {item.meta.author && <span>by {item.meta.author}</span>}
            {originLabel && <span>{originLabel}</span>}
            {item.timestamp > 0 && (
              <time dateTime={new Date(item.timestamp).toISOString()}>
                {relativeTime(item.timestamp)}
              </time>
            )}
          </div>
        </div>
      </div>

      <h2 className="stream-reader-title">{item.title}</h2>

      {images && streamImageUrl(item) && (
        <img
          className="news-image"
          src={streamImageUrl(item)!}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      )}

      {item.excerpt ? (
        <p className="stream-reader-body">{item.excerpt}</p>
      ) : (
        <p className="field-hint">
          This feed did not include an excerpt. Open the source link to read the
          full item.
        </p>
      )}

      {(item.meta.points != null || item.meta.comments != null) && (
        <p className="field-hint news-stats">
          {[
            item.meta.points != null && plural(item.meta.points, "point"),
            item.meta.comments != null && plural(item.meta.comments, "comment"),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      <div className="card-actions stream-reader-actions">
        {onAsk && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              onClose();
              onAsk(defaultStreamAskPrompt(item), item);
            }}
          >
            <MessageSquarePlus size={16} aria-hidden="true" />
            Ask an agent
          </button>
        )}
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="secondary"
          >
            <ArrowUpRight size={16} aria-hidden="true" />
            Open source
          </a>
        )}
        {item.discussionUrl && (
          <a
            href={item.discussionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="secondary"
          >
            <MessageSquare size={16} aria-hidden="true" />
            Discussion
          </a>
        )}
        <button
          type="button"
          onClick={() => {
            onClose();
            onRemind(item);
          }}
        >
          <Bookmark size={16} aria-hidden="true" />
          Save / Remind me
        </button>
        <button type="button" onClick={() => onMarkRead(item, !item.read)}>
          <Check size={16} aria-hidden="true" />
          {item.read ? "Mark unread" : "Mark read"}
        </button>
        <button
          type="button"
          onClick={() => {
            onClose();
            onDismiss(item);
          }}
        >
          <X size={16} aria-hidden="true" />
          Dismiss
        </button>
      </div>
    </Sheet>
  );
}
