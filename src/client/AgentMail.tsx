import { useEffect, useRef, useState } from "react";
import { listenWorkspaceChanges } from "./workspace-changes";
import { ArrowUpRight } from "lucide-react";
import { callRoute, readRoute } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import type { Agent } from "../shared/types";
import { MAIL_STATUS_LABELS, type MailThread } from "../shared/agent-mail";

type Props = {
  target: { kind: "agent" | "team"; id: string };
  ownerKey: string;
  sourceId: string;
  agents: Agent[];
  onOpenConversation: (id: string, sourceId: string) => void;
  onChanged: () => void;
};

// Remount before rendering data from a different owner, source or profile.
export function AgentMailThreads(props: Props) {
  return (
    <MailThreadsView
      key={JSON.stringify([props.ownerKey, props.sourceId, props.target])}
      {...props}
    />
  );
}
function MailThreadsView({
  target,
  sourceId,
  agents,
  onOpenConversation,
  onChanged,
}: Props) {
  const [threads, setThreads] = useState<MailThread[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resuming, setResuming] = useState("");
  const [loading, setLoading] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const request = async <T,>(work: (signal: AbortSignal) => Promise<T>) => {
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      return await work(controller.signal);
    } finally {
      requests.current.delete(controller);
    }
  };
  const load = async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const response = await request((signal) =>
        readRoute(
          target.kind === "team"
            ? workspaceApi.teamMessages
            : workspaceApi.agentMail,
          { params: { id: target.id } },
          sourceId,
          signal,
        ),
      );
      if (active.current && current === generation.current) {
        setThreads(response.threads);
        setError("");
      }
    } catch (failure) {
      if (active.current && current === generation.current)
        setError((failure as Error).message);
    } finally {
      if (active.current && current === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    active.current = true;
    const stopChanges = listenWorkspaceChanges(
      "mail",
      () => void load(),
      sourceId,
    );
    void load();
    return () => {
      stopChanges();
      active.current = false;
      generation.current++;
      for (const request of requests.current) request.abort();
    };
  }, []);
  const resume = async (threadId: string) => {
    if (resuming) return;
    setResuming(threadId);
    setNotice("");
    try {
      const result = await request((signal) =>
        callRoute(
          target.kind === "team"
            ? workspaceApi.teamThreadResume
            : workspaceApi.agentMailResume,
          { params: { id: target.id, threadId }, body: {} },
          sourceId,
          signal,
        ),
      );
      if (!active.current) return;
      setNotice(
        `${result.released} released, ${result.refused} refused, ${result.held} still held.`,
      );
      onChanged();
      await load();
    } catch (failure) {
      if (active.current) setError((failure as Error).message);
    } finally {
      if (active.current) setResuming("");
    }
  };
  const name = (id: string) =>
    "@" + (agents.find((agent) => agent.id === id)?.name ?? "former agent");
  return (
    <section aria-label="Agent mail">
      <p className="muted">
        Messages between agents in this workspace. Accepted mail may wait for
        recipient availability. Paused threads keep their held messages until
        you resume.
      </p>
      <button
        className="secondary"
        disabled={loading || !!resuming}
        onClick={() => void load()}
      >
        Refresh mail
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Loading agent mail…</p>}
      {threads?.length === 0 && (
        <p className="muted">
          No agent mail yet. Ask an agent to discover and contact another agent.
        </p>
      )}
      <div className="team-threads">
        {threads?.map((thread) => (
          <section
            className="team-thread"
            key={thread.id}
            aria-label={`Thread ${thread.subject}`}
          >
            <header>
              <strong>{thread.subject}</strong>
              <small>
                {(thread.scope === "direct"
                  ? "Direct · "
                  : thread.scope === "team"
                    ? "Team · "
                    : "") + thread.participants.map(name).join(" · ")}
              </small>
            </header>
            {thread.paused_at && (
              <div className="team-thread-paused" role="status">
                <span>
                  Paused. {thread.paused_reason} Held messages are sent when you
                  resume.
                </span>
                <button
                  className="secondary"
                  disabled={!!resuming}
                  onClick={() => void resume(thread.id)}
                >
                  {resuming === thread.id ? "Resuming…" : "Resume"}
                </button>
              </div>
            )}
            <ol className="team-thread-messages">
              {thread.messages.map((message) => (
                <li key={message.id}>
                  <div className="team-message-meta">
                    <span>
                      {name(message.from)} → {name(message.to)}
                      {message.kind === "result" ? " · result" : ""}
                    </span>
                    <span
                      className={
                        "team-message-status " +
                        ([
                          "held",
                          "not_delivered",
                          "unconfirmed",
                          "failed",
                        ].includes(message.status)
                          ? "attention"
                          : "")
                      }
                    >
                      {MAIL_STATUS_LABELS[message.status]}
                    </span>
                  </div>
                  <time
                    className="muted"
                    dateTime={new Date(message.created_at).toISOString()}
                  >
                    {new Date(message.created_at).toLocaleString()}
                  </time>
                  <p>{message.preview}</p>
                  {message.status === "pending" && (
                    <p className="muted">
                      Accepted and waiting. No recipient turn has started.
                    </p>
                  )}
                  {message.error && <p className="error">{message.error}</p>}
                  {message.files > 0 && (
                    <small className="muted">
                      {message.files === 1
                        ? "1 file attached"
                        : `${message.files} files attached`}
                    </small>
                  )}
                  {message.conversation_id && (
                    <button
                      className="text-button"
                      onClick={() =>
                        onOpenConversation(message.conversation_id!, sourceId)
                      }
                    >
                      Open in {name(message.to)}'s thread{" "}
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </section>
  );
}
