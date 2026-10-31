import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  MessageSquare,
  Paperclip,
} from "lucide-react";
import { workspaceApi } from "../shared/workspace-api";
import {
  MAIL_STATUS_LABELS,
  type PublicMailAgentReference,
} from "../shared/agent-mail";
import { useFleet } from "./FleetContext";
import { mailConversationTarget, mailReferenceName } from "./mailReferences";
import type {
  AgentThreadDetail,
  AgentThreadMessage,
} from "../shared/agent-thread-feed";
import { Avatar, RichText, Sheet } from "./components";
import { readRoute } from "./workspace-api";
import { relativeTime, preview } from "./threadView";
import { viewGeneration } from "./viewCache";
import { sourceUrl } from "./sourceRouting";
import { listenWorkspaceChanges } from "./workspace-changes";
import { SourceProvider, useSourceCapabilities } from "./SourceContext";
import {
  AGENT_THREAD_SURFACES,
  type SourcedAgentThread,
} from "./useAgentThreadFeed";

export function AgentThreadCard({
  thread,
  environment,
  onOpen,
}: {
  thread: SourcedAgentThread;
  environment?: string;
  onOpen: () => void;
}) {
  const fleet = useFleet();
  const name = (id: string, reference?: PublicMailAgentReference) =>
    mailReferenceName(
      reference,
      thread.participants.find((person) => person.id === id)?.name ??
        "former agent",
      fleet.state,
    );
  return (
    <li className="agent-thread-feed-row">
      <article
        className="feed-card inbox-card agent-thread-card"
        data-agent-thread={thread.id}
      >
        <header className="agent-thread-byline">
          <span className="agent-thread-avatars" aria-hidden="true">
            {thread.participants.slice(0, 2).map((person) => (
              <Avatar key={person.id} name={person.name} />
            ))}
          </span>
          <span className="agent-thread-people">
            {thread.participants
              .map((person) => `@${name(person.id, person.reference)}`)
              .join(" · ")}
          </span>
          <time dateTime={new Date(thread.updated_at).toISOString()}>
            {relativeTime(thread.updated_at)}
          </time>
        </header>
        <div
          className="card-content inbox-row"
          role="button"
          tabIndex={0}
          onClick={onOpen}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpen();
            }
          }}
        >
          <span className="done-thread-eyebrow">
            <MessageSquare size={13} /> Agent thread · {thread.message_count}{" "}
            {thread.message_count === 1 ? "message" : "messages"}
          </span>
          <h2>{thread.subject}</h2>
          <p className="agent-thread-direction">
            @{name(thread.latest.from, thread.latest.from_ref)}{" "}
            <ArrowRight size={12} aria-hidden="true" /> @
            {name(thread.latest.to, thread.latest.to_ref)}
          </p>
          <p className="preview">{preview(thread.latest.preview, 300)}</p>
          <span className="field-hint">
            {MAIL_STATUS_LABELS[thread.latest.status]}
            {environment ? ` · ${environment}` : ""}
          </span>
        </div>
        <footer className="card-actions">
          <button onClick={onOpen}>
            Open thread <ArrowUpRight size={15} aria-hidden="true" />
          </button>
        </footer>
      </article>
    </li>
  );
}

export function AgentThreadReader({
  thread,
  onClose,
  onOpen,
}: {
  thread: SourcedAgentThread;
  onClose: () => void;
  onOpen: (
    conversation: string,
    message: string | undefined,
    source: string,
  ) => void;
}) {
  const fleet = useFleet();
  const capabilities = useSourceCapabilities();
  const generation = viewGeneration();
  const [detail, setDetail] = useState<AgentThreadDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const actions = useRef({ refresh: () => {}, older: () => {} });
  useEffect(() => {
    const controller = new AbortController();
    let current: AgentThreadDetail | null = null;
    let busy = false,
      pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = () =>
      !controller.signal.aborted && generation === viewGeneration();
    const schedule = () => {
      pending = true;
      if (busy || timer || !active()) return;
      timer = setTimeout(() => void load(), 300);
    };
    const load = async (older = false) => {
      if (!active()) return;
      if (busy) {
        if (!older) pending = true;
        return;
      }
      busy = true;
      clearTimeout(timer);
      timer = undefined;
      if (!older) pending = false;
      setLoading(true);
      setError("");
      try {
        let before = older ? (current?.next ?? undefined) : undefined;
        const retained =
          !older && current?.messages.length
            ? new Set(current.messages.map((message) => message.id))
            : null;
        const pages: AgentThreadMessage[][] = [];
        let result: AgentThreadDetail;
        // Preserve already-read history while refreshing new messages. Every
        // page is still explicitly restricted to this thread on the server.
        do {
          result = await readRoute(
            workspaceApi.agentThreadDetail,
            { params: { id: thread.id }, query: { before } },
            thread.source,
            controller.signal,
          );
          if (!active()) return;
          pages.unshift(result.messages);
          result.messages.forEach((message) => retained?.delete(message.id));
          before = result.next ?? undefined;
        } while (!older && retained?.size && before);
        const incoming = pages.flat();
        const known = new Set(incoming.map((message) => message.id));
        current = {
          ...result,
          messages: older
            ? [
                ...incoming,
                ...(current?.messages ?? []).filter(
                  (message) => !known.has(message.id),
                ),
              ]
            : incoming,
        };
        setDetail(current);
      } catch (failure) {
        if (active()) setError((failure as Error).message);
      } finally {
        busy = false;
        if (active()) {
          setLoading(false);
          if (pending) schedule();
        }
      }
    };
    actions.current = {
      refresh: () => void load(),
      older: () => void load(true),
    };
    const stops = AGENT_THREAD_SURFACES.map((surface) =>
      listenWorkspaceChanges(surface, schedule, thread.source),
    );
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      stops.forEach((stop) => stop());
    };
  }, [thread.id, thread.source, generation]);
  const name = (id: string, reference?: PublicMailAgentReference) =>
    mailReferenceName(
      reference,
      (detail?.thread ?? thread).participants.find((person) => person.id === id)
        ?.name ?? "former agent",
      fleet.state,
    );
  return (
    <SourceProvider sourceId={thread.source} capabilities={capabilities}>
      <Sheet
        title={thread.subject}
        className="done-thread-sheet agent-thread-sheet"
        wide
        onClose={onClose}
      >
        <p className="field-hint">
          Messages exchanged in this thread. New replies appear here
          automatically.
        </p>
        {detail?.thread.paused_at && (
          <p role="status" className="field-hint">
            Paused: {detail.thread.paused_reason} Open Agent mail to manage held
            messages.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}{" "}
            <button onClick={() => actions.current.refresh()}>Retry</button>
          </p>
        )}
        {!detail && loading && <p role="status">Loading thread…</p>}
        {detail?.next && (
          <button
            className="secondary"
            disabled={loading}
            onClick={() => actions.current.older()}
          >
            Load earlier messages
          </button>
        )}
        {detail?.messages.map((message) => {
          const destination = mailConversationTarget(
            message,
            thread.source,
            fleet.state,
            !!fleet.error,
          );
          return (
            <article
              className="done-thread-message agent-thread-message"
              key={message.id}
              data-mail-id={message.id}
            >
              <header>
                <Avatar name={name(message.from, message.from_ref)} />
                <div>
                  <strong>
                    @{name(message.from, message.from_ref)}{" "}
                    <ArrowRight size={12} aria-hidden="true" /> @
                    {name(message.to, message.to_ref)}
                  </strong>
                  <time dateTime={new Date(message.created_at).toISOString()}>
                    {new Date(message.created_at).toLocaleString()}
                  </time>
                </div>
              </header>
              <RichText content={message.content} />
              {!!message.attachments.length && (
                <ul className="attachment-list" aria-label="Attached files">
                  {message.attachments.map((file) => (
                    <li key={file.id}>
                      <Paperclip size={15} aria-hidden="true" />
                      <a href={sourceUrl(thread.source, { artifact: file.id })}>
                        {file.name}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <p className="field-hint">{MAIL_STATUS_LABELS[message.status]}</p>
              {message.error && <p className="error">{message.error}</p>}
              {(message.conversation_id || message.remote_conversation) && (
                <div className="card-actions">
                  <button
                    disabled={!destination}
                    onClick={() => {
                      if (!destination) return;
                      onClose();
                      onOpen(
                        destination.id,
                        message.remote_conversation
                          ? undefined
                          : (message.message_id ?? undefined),
                        destination.source,
                      );
                    }}
                  >
                    Open original conversation{" "}
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                </div>
              )}
              {message.remote_conversation && !destination && (
                <p className="field-hint">
                  Refresh the fleet directory or open that machine to view this
                  thread.
                </p>
              )}
            </article>
          );
        })}
      </Sheet>
    </SourceProvider>
  );
}
