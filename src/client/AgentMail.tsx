import { useEffect, useRef, useState } from "react";
import { listenWorkspaceChanges } from "./workspace-changes";
import { useCollectionRead } from "./CollectionRead";
import { ArrowUpRight } from "lucide-react";
import { callRoute, readRoute } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import type { Agent } from "../shared/types";
import {
  MAIL_STATUS_LABELS,
  type MailThread,
  type PublicMailAgentReference,
} from "../shared/agent-mail";
import { useFleet } from "./FleetContext";
import { useSourceCapabilities } from "./SourceContext";
import { fleetOperationReason } from "./fleetCapabilities";
import {
  mailConversationTarget,
  mailReferenceId,
  mailReferenceName,
} from "./mailReferences";

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
  const fleet = useFleet();
  const resumeRoute =
    target.kind === "team"
      ? workspaceApi.teamThreadResume
      : workspaceApi.agentMailResume;
  const resumeUnavailable = fleetOperationReason(
    sourceId,
    useSourceCapabilities(),
    resumeRoute,
  );
  const [threads, setThreads] = useState<MailThread[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resuming, setResuming] = useState("");
  const collection = useCollectionRead(JSON.stringify([sourceId, target]));
  const loading = collection.busy;
  const active = useRef(false);
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
  const load = () =>
    collection.load(
      (signal, mode) =>
        readRoute(
          target.kind === "team"
            ? workspaceApi.teamMessages
            : workspaceApi.agentMail,
          { params: { id: target.id } },
          sourceId,
          signal,
          undefined,
          mode,
        ),
      (response) => {
        setThreads(response.threads);
        setError("");
      },
    );
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
      for (const request of requests.current) request.abort();
    };
  }, []);
  const resume = async (threadId: string) => {
    if (resuming || resumeUnavailable) return;
    setResuming(threadId);
    setNotice("");
    try {
      const result = await request((signal) =>
        callRoute(
          resumeRoute,
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
  const name = (id: string, reference?: PublicMailAgentReference) =>
    "@" +
    mailReferenceName(
      reference,
      agents.find((agent) => agent.id === id)?.name ?? "former agent",
      fleet.state,
    );
  return (
    <section aria-label="Agent mail">
      <p className="muted">
        Messages between agents in this workspace and authorized fleet machines.
        Accepted mail may wait for recipient availability. Paused threads keep
        their held messages until you resume.
      </p>
      <button
        className="secondary"
        disabled={loading || !!resuming}
        onClick={() => void load()}
      >
        Refresh mail
      </button>
      {(error || collection.error) && (
        <p role="alert" className="error">
          {error || collection.error}
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
                {(thread.scope === "direct" ? "Direct · " : "Team · ") +
                  (thread.participant_refs
                    ? thread.participant_refs.map((reference) =>
                        name(mailReferenceId(reference), reference),
                      )
                    : thread.participants.map((id) => name(id))
                  ).join(" · ")}
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
                  disabled={!!resuming || !!resumeUnavailable}
                  onClick={() => void resume(thread.id)}
                >
                  {resuming === thread.id ? "Resuming…" : "Resume"}
                </button>
                {resumeUnavailable && <small>{resumeUnavailable}</small>}
              </div>
            )}
            <ol className="team-thread-messages">
              {thread.messages.map((message) => {
                const destination = mailConversationTarget(
                  message,
                  sourceId,
                  fleet.state,
                  !!fleet.error,
                );
                return (
                  <li key={message.id}>
                    <div className="team-message-meta">
                      <span>
                        {name(message.from, message.from_ref)} →{" "}
                        {name(message.to, message.to_ref)}
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
                    {(message.conversation_id ||
                      message.remote_conversation) && (
                      <button
                        className="text-button"
                        disabled={!destination}
                        onClick={() =>
                          destination &&
                          onOpenConversation(destination.id, destination.source)
                        }
                      >
                        Open in {name(message.to, message.to_ref)}'s thread{" "}
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </button>
                    )}
                    {message.remote_conversation && !destination && (
                      <small className="muted">
                        Refresh the fleet directory or open that machine to view
                        this thread.
                      </small>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </section>
  );
}
