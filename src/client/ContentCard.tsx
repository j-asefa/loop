import { useState, type ReactNode } from "react";
import {
  AlarmClock,
  Archive,
  ArrowUpRight,
  Bookmark,
  FolderInput,
  MessageSquare,
  MoreHorizontal,
  File,
} from "lucide-react";
import type { Card } from "../shared/cards";
import {
  Avatar,
  RichText,
  ResultPreview,
  resultPresentation,
} from "./components";
import { ResultBody } from "./ArtifactViewer";
import { FilePreview } from "./FilePreview";
import { useSourcePath, useSourceId } from "./SourceContext";
import { ActionSheet, useLongPress, useSwipe } from "./ThreadTools";

export function opensContentCard(
  target: EventTarget | null,
  card: Pick<Element, "contains">,
  selection = "",
) {
  if (selection) return false;
  const control = (target as Partial<Element> | null)?.closest?.(
    "a, button, input, textarea, select, summary, label, video, audio, [role=button]",
  );
  return !control || !card.contains(control);
}
function CardAttachments({ card }: { card: Card }) {
  const path = useSourcePath(),
    source = useSourceId(),
    [preview, setPreview] = useState<Card["attachments"][number]>();
  return (
    <>
      {!!card.attachments.length && (
        <ul className="attachment-list" aria-label="Attached files">
          {card.attachments.map((file) => (
            <li key={file.id}>
              <File size={17} aria-hidden="true" />
              {file.download ? (
                <button
                  className="attachment-open"
                  aria-label={`Preview ${file.name}`}
                  onClick={() => setPreview(file)}
                >
                  {file.name}
                </button>
              ) : (
                <a href={sourceCardHref(file.href, source)}>{file.name}</a>
              )}
            </li>
          ))}
        </ul>
      )}
      {preview?.download && (
        <FilePreview
          url={path(preview.download)}
          name={preview.name}
          mime={preview.mime}
          onClose={() => setPreview(undefined)}
        />
      )}
    </>
  );
}
function sourceCardHref(href: string, source: string) {
  const url = new URL(href, location.origin);
  if (source) url.searchParams.set("source", source);
  else url.searchParams.delete("source");
  return url.pathname + url.search + url.hash;
}
export function CardBody({
  card,
  compact = false,
}: {
  card: Card;
  compact?: boolean;
}) {
  return (
    <>
      {card.type !== "result" ? (
        <RichText content={card.content} compact={compact} />
      ) : compact ? (
        <ResultPreview card={card} />
      ) : (
        <ResultBody card={card} />
      )}
      <CardAttachments card={card} />
    </>
  );
}
/** Shared shell and actions; Results and Messages keep their distinct typed
 * body and attribution. Saved adds its label outside this component. */
export function ContentCard({
  card,
  onOpen,
  onProfile,
  onReply,
  onSave,
  onFile,
  onArchive,
  onLater,
  footer,
}: {
  card: Card;
  onOpen: () => void;
  onProfile?: () => void;
  onReply?: () => void;
  onSave?: () => void;
  onFile?: () => void;
  onArchive?: () => void;
  onLater?: () => void;
  footer?: ReactNode;
}) {
  const source = useSourceId();
  const [menu, setMenu] = useState(false);
  const swipe = useSwipe({ onLeft: onArchive, onRight: onSave });
  const press = useLongPress(() => setMenu(true));
  const merged = (name: string) => (event: any) => {
    (swipe.handlers as any)[name]?.(event);
    (press as any)[name]?.(event);
  };
  const personal = card.author.kind === "owner";
  const identity = personal ? card.recipient : card.author;
  const name = personal
    ? identity?.name || "Recipient unavailable"
    : identity?.name ||
      (card.author.kind === "system" ? "System" : "Author unavailable");
  const presentation =
    card.type === "result" ? resultPresentation(card, card.display) : null;
  const title =
    card.type === "result"
      ? presentation!.title
      : card.context.conversation_title || "Message";
  const actions = [
    {
      id: "open",
      label: card.type === "result" ? "View full result" : "Open conversation",
      icon: <ArrowUpRight size={18} />,
      onSelect: onOpen,
    },
    ...(onReply
      ? [
          {
            id: "reply",
            label: "Reply",
            icon: <MessageSquare size={18} />,
            onSelect: onReply,
          },
        ]
      : []),
    ...(onSave
      ? [
          {
            id: "save",
            label: card.saved ? "Remove from Saved" : "Save",
            icon: <Bookmark size={18} />,
            onSelect: onSave,
          },
        ]
      : []),
    ...(onFile
      ? [
          {
            id: "file",
            label: "File",
            icon: <FolderInput size={18} />,
            onSelect: onFile,
          },
        ]
      : []),
    ...(onLater
      ? [
          {
            id: "later",
            label: "Remind me",
            icon: <AlarmClock size={18} />,
            onSelect: onLater,
          },
        ]
      : []),
    ...(onArchive
      ? [
          {
            id: "archive",
            label: "Archive",
            icon: <Archive size={18} />,
            onSelect: onArchive,
          },
        ]
      : []),
  ];
  return (
    <div
      className={
        "card-swipe" +
        (swipe.armed ? " armed-" + swipe.armed : "") +
        (swipe.offset ? " swiping" : "")
      }
    >
      {onSave && (
        <span className="swipe-under left" aria-hidden="true">
          <Bookmark size={20} /> {card.saved ? "Unsave" : "Save"}
        </span>
      )}
      {onArchive && (
        <span className="swipe-under right" aria-hidden="true">
          <Archive size={20} /> Archive
        </span>
      )}
      <article
        className={
          "feed-card" +
          (card.type === "message" ? " personal-message-card" : "")
        }
        data-card-id={card.id}
        style={
          swipe.offset
            ? { transform: `translateX(${swipe.offset}px)` }
            : undefined
        }
        onPointerDown={merged("onPointerDown")}
        onPointerMove={merged("onPointerMove")}
        onPointerUp={merged("onPointerUp")}
        onPointerCancel={merged("onPointerCancel")}
        onPointerLeave={(press as any).onPointerLeave}
        onContextMenu={(press as any).onContextMenu}
        onClickCapture={merged("onClickCapture")}
        onClick={(event) => {
          if (
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey &&
            opensContentCard(
              event.target,
              event.currentTarget,
              window.getSelection()?.toString(),
            )
          )
            onOpen();
        }}
      >
        <div className="card-byline">
          <button
            className="identity"
            disabled={!onProfile}
            onClick={onProfile}
          >
            <Avatar name={name} />
            <span>
              {personal && (
                <small className="muted">You sent a message to</small>
              )}
              <strong>{name}</strong>
              <span className="subline">
                {card.type === "result" && card.display.model && (
                  <span className="card-model">{card.display.model}</span>
                )}
                <time dateTime={new Date(card.created_at).toISOString()}>
                  {new Date(card.created_at).toLocaleString()}
                </time>
              </span>
            </span>
          </button>
          <button
            className="icon-button"
            aria-label="More actions"
            onClick={() => setMenu(true)}
          >
            <MoreHorizontal size={20} />
          </button>
        </div>
        <div className="card-content">
          <span className="eyebrow">
            {card.type === "result"
              ? card.role === "import"
                ? "Imported history"
                : card.role === "file" || card.role === "upload"
                  ? "File"
                  : presentation!.eyebrow
              : personal
                ? "Your message"
                : "Message"}
            {card.context.project_name && (
              <span className="card-project">
                {" "}
                · {card.context.project_name}
              </span>
            )}
          </span>
          {card.type === "result" && <h2>{title}</h2>}
          <div className={card.type === "result" ? "preview" : undefined}>
            <CardBody card={card} compact={card.type === "result"} />
          </div>
          {card.type === "message" ? (
            <>
              <p className="personal-message-context">
                {card.context.project_name || "No project"} ·{" "}
                {card.context.conversation_title || "Conversation"}
              </p>
              <a
                className="text-button preview-open"
                href={sourceCardHref(card.href, source)}
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  onOpen();
                }}
              >
                Open conversation <ArrowUpRight size={14} />
              </a>
            </>
          ) : (
            <button className="text-button preview-open" onClick={onOpen}>
              View full result <ArrowUpRight size={14} />
            </button>
          )}
        </div>
        <div className="card-actions">
          {onReply && (
            <button onClick={onReply}>
              <MessageSquare size={16} />
              Reply
            </button>
          )}
          {onSave && (
            <button
              aria-label={card.saved ? "Remove from Saved" : "Save"}
              className={card.saved ? "active" : ""}
              onClick={onSave}
            >
              <Bookmark size={16} fill={card.saved ? "currentColor" : "none"} />
              {card.saved ? "Saved" : "Save"}
            </button>
          )}
          {onLater && (
            <button onClick={onLater}>
              <AlarmClock size={16} />
              Remind me
            </button>
          )}
          {onFile && (
            <button onClick={onFile}>
              <FolderInput size={16} />
              File
            </button>
          )}
          {footer}
        </div>
      </article>
      {menu && (
        <ActionSheet
          title={title}
          onClose={() => setMenu(false)}
          actions={actions}
        />
      )}
    </div>
  );
}
