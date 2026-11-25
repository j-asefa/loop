import { useEffect, useRef, useState } from "react";
import { ArrowUp, ArrowUpRight, RotateCw, X } from "lucide-react";
import { sendInlineReply, type InlineReply } from "./inlineSend";
import {
  appendDraftText,
  saveThreadDraft,
  sourceDraftId,
  threadDraft,
} from "./drafts";
import { viewOwner } from "./viewCache";
import { proseEntry } from "./textEntry";

type Echo = {
  text: string;
  state: "sending" | "sent" | "uncertain";
};

/**
 * Keep text that was not accepted as the thread's draft, for the owner who
 * typed it. An unconfirmed reply kept this way has the composer's signature
 * for the same message, so sending it from the thread repeats its key.
 */
function keepAsDraft(value: string, draftId: string, owner?: string) {
  const text = value.trim();
  if (!text || !owner) return;
  const existing = threadDraft(draftId, owner);
  if (existing.text.includes(text)) return;
  saveThreadDraft(
    draftId,
    appendDraftText(existing.text, text),
    existing.files,
    owner,
  );
}

/**
 * A reply typed on the card itself. Your message shows at once, marked as
 * sending; it is display only (D2). The send keeps the composer's durable
 * receipt, so an unconfirmed send is offered as Retry with the same key and
 * is never sent again on its own. A refusal returns the text to the box.
 * Text that was not accepted is never dropped: closing the box, or the card
 * leaving the list, keeps it as the thread's draft.
 */
export function InlineReplyBox({
  reply,
  agentName,
  autoFocus = true,
  onOpenThread,
  onClose,
}: {
  reply: Omit<InlineReply, "text">;
  /** Focus (and bring into view) on open; not when shown in an open card. */
  autoFocus?: boolean;
  agentName?: string;
  /** The thread's full composer, for files, scheduling and long replies. */
  onOpenThread: () => void;
  /** Absent while the box belongs to a card open in place. */
  onClose?: () => void;
}) {
  const [text, setText] = useState("");
  const [echo, setEcho] = useState<Echo | null>(null);
  const [error, setError] = useState("");
  const [scheduled, setScheduled] = useState(false);
  const mounted = useRef(true);
  const box = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const owner = useRef(viewOwner());
  const draftId = sourceDraftId(reply.conversation, reply.source);
  // What would be lost if the box went away now: unsent text, or a reply
  // whose outcome is unknown. A reply still sending is kept by `send`.
  const unaccepted = useRef({ draftId, text: "" });
  unaccepted.current = {
    draftId,
    text: echo?.state === "uncertain" ? echo.text : text,
  };
  const keepUnaccepted = () => {
    const { draftId, text } = unaccepted.current;
    keepAsDraft(text, draftId, owner.current);
    unaccepted.current = { draftId, text: "" };
  };
  useEffect(() => {
    mounted.current = true;
    if (autoFocus) {
      box.current?.focus({ preventScroll: true });
      // Clear of the bottom bar and the new-message button (scroll-margin).
      root.current?.scrollIntoView({ block: "nearest" });
    }
    return () => {
      mounted.current = false;
      keepUnaccepted();
    };
  }, []);
  const target = JSON.stringify([reply.source, reply.conversation]);
  const sendingFor = useRef(target);
  sendingFor.current = target;
  const close = () => {
    // Saved before the card renders without the box, so it shows the draft.
    keepUnaccepted();
    onClose?.();
  };

  const send = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || echo?.state === "sending") return;
    const sentFor = target,
      sentDraft = draftId;
    const current = () => mounted.current && sendingFor.current === sentFor;
    setError("");
    setEcho({ text: trimmed, state: "sending" });
    setText("");
    const result = await sendInlineReply({ ...reply, text: trimmed }, current);
    if (!current()) {
      // The box went away while this was sending: keep what was not
      // accepted (refused, unconfirmed or never sent) as the draft.
      if (result?.outcome !== "accepted")
        keepAsDraft(trimmed, sentDraft, owner.current);
      return;
    }
    if (!result) {
      setEcho(null);
      setText(trimmed);
      return;
    }
    switch (result.outcome) {
      case "accepted":
        setEcho({ text: trimmed, state: "sent" });
        return;
      case "uncertain":
        setEcho({ text: trimmed, state: "uncertain" });
        return;
      case "scheduled":
        setEcho(null);
        setText(trimmed);
        setScheduled(true);
        return;
      case "refused":
        setEcho(null);
        setText(trimmed);
        setError(result.message);
        box.current?.focus();
    }
  };

  return (
    <div
      ref={root}
      className="inline-reply"
      // The card's own gestures (open, swipe, hold for the menu) stay off the
      // reply box; a long press here selects text as usual.
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {echo && (
        <div
          className={"inline-reply-echo " + echo.state}
          data-state={echo.state}
        >
          <span className="inline-reply-you">You</span>
          <p>{echo.text}</p>
          <span className="inline-reply-status" role="status">
            {echo.state === "sending"
              ? "Sending…"
              : echo.state === "sent"
                ? `Sent${agentName ? ` to @${agentName}` : ""}`
                : "Not confirmed. Loop may have received it."}
          </span>
          {echo.state === "uncertain" && (
            <button
              type="button"
              className="text-button"
              onClick={() => void send(echo.text)}
            >
              <RotateCw size={14} aria-hidden="true" /> Retry
            </button>
          )}
        </div>
      )}
      {echo?.state !== "uncertain" && echo?.state !== "sending" && (
        <form
          className="inline-reply-form"
          onSubmit={(event) => {
            event.preventDefault();
            void send(text);
          }}
        >
          <textarea
            ref={box}
            rows={1}
            value={text}
            {...proseEntry}
            // No "@" handle here: iOS reads it as an email field (textEntry).
            aria-label="Reply"
            placeholder={echo ? "Reply again" : "Reply"}
            onChange={(event) => {
              setText(event.target.value);
              setScheduled(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send(text);
              } else if (event.key === "Escape" && !text) close();
            }}
          />
          <button
            type="submit"
            className="primary inline-reply-send"
            aria-label="Send reply"
            disabled={!text.trim()}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </button>
        </form>
      )}
      {error && (
        <p className="error inline-reply-error" role="alert">
          {error}
        </p>
      )}
      {scheduled && (
        <p className="field-hint" role="status">
          This message is already scheduled from the composer. Open the thread
          to change it.
        </p>
      )}
      {/* While sending, nothing here may leave or drop the reply. */}
      {echo?.state !== "sending" && (
        <div className="inline-reply-links">
          <button
            type="button"
            className="text-button"
            onClick={() => {
              // The composer opens with what was typed here.
              keepUnaccepted();
              onOpenThread();
            }}
          >
            Reply in thread <ArrowUpRight size={14} aria-hidden="true" />
          </button>
          {onClose && (
            <button
              type="button"
              className="text-button"
              aria-label="Close reply"
              onClick={close}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
