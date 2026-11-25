import { useEffect, useRef, useState } from "react";
import { ArrowUp, ArrowUpRight, RotateCw, X } from "lucide-react";
import { sendInlineReply, type InlineReply } from "./inlineSend";

type Echo = {
  text: string;
  state: "sending" | "sent" | "uncertain";
};

/**
 * A reply typed on the card itself. Your message shows at once, marked as
 * sending; it is display only (D2). The send keeps the composer's durable
 * receipt, so an unconfirmed send is offered as Retry with the same key and
 * is never sent again on its own. A refusal returns the text to the box.
 */
export function InlineReplyBox({
  reply,
  agentName,
  onOpenThread,
  onClose,
}: {
  reply: Omit<InlineReply, "text">;
  agentName?: string;
  /** The thread's full composer, for files, scheduling and long replies. */
  onOpenThread: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [echo, setEcho] = useState<Echo | null>(null);
  const [error, setError] = useState("");
  const [scheduled, setScheduled] = useState(false);
  const mounted = useRef(true);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    mounted.current = true;
    box.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  const target = JSON.stringify([reply.source, reply.conversation]);
  const sendingFor = useRef(target);
  sendingFor.current = target;

  const send = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || echo?.state === "sending") return;
    const sentFor = target;
    const current = () => mounted.current && sendingFor.current === sentFor;
    setError("");
    setEcho({ text: trimmed, state: "sending" });
    setText("");
    const result = await sendInlineReply({ ...reply, text: trimmed }, current);
    if (!current()) return;
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
      className="inline-reply"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
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
            aria-label={`Reply${agentName ? ` to @${agentName}` : ""}`}
            placeholder={echo ? "Reply again" : "Reply"}
            onChange={(event) => {
              setText(event.target.value);
              setScheduled(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send(text);
              } else if (event.key === "Escape" && !text) onClose();
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
      <div className="inline-reply-links">
        <button type="button" className="text-button" onClick={onOpenThread}>
          Open full thread <ArrowUpRight size={14} aria-hidden="true" />
        </button>
        {echo?.state !== "sending" && (
          <button
            type="button"
            className="text-button"
            aria-label="Close reply"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
