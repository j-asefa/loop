import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ArtifactCard, Empty } from "./components";
import { FeedPager, type FeedPage, type FeedUpdates } from "./feed";
import type { Agent, Artifact, Connection } from "../shared/types";

type ProjectOutput = Artifact & { cursor: number };

type Props = {
  projectId: string;
  agents: Agent[];
  connections: Connection[];
  revision: number;
  onOpen: (item: Artifact) => void;
  onReply: (item: Artifact) => void;
  onConversation: (id: string) => void;
  onAgent: (agent: Agent) => void;
  onFile: (item: Artifact) => void;
};

export function ProjectActivity(props: Props) {
  // A project owns its displayed cards, cursor and errors, even while the next
  // project's request is pending or fails. Never reuse another project's view.
  return <ProjectActivityFeed key={props.projectId} {...props} />;
}

function ProjectActivityFeed({
  projectId,
  agents,
  connections,
  revision,
  onOpen,
  onReply,
  onConversation,
  onAgent,
  onFile,
}: Props) {
  const [items, setItems] = useState<Artifact[]>([]),
    [next, setNext] = useState<number | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const request = useRef(0);
  const pager = useRef(new FeedPager<ProjectOutput>());
  async function load(more = false) {
    const ticket = ++request.current;
    setLoading(true);
    setError("");
    try {
      const query = () =>
        new URLSearchParams({ folder: projectId, view: "all" });
      const page = await pager.current.load(
        projectId,
        more,
        (before) => {
          const params = query();
          if (before !== null) params.set("before", String(before));
          return api<FeedPage<ProjectOutput>>(`/feed?${params}`);
        },
        (after, through) => {
          const params = query();
          params.set("after", String(after));
          params.set("through", String(through));
          return api<FeedUpdates<ProjectOutput>>(`/feed/updates?${params}`);
        },
      );
      // The pager serializes refreshes with appends and discards stale scopes.
      // An overlapping no-op refresh must not suppress an appended page.
      if (!page) return;
      setItems(page.items);
      setNext(page.next);
    } catch (e) {
      if (ticket === request.current) setError((e as Error).message);
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [projectId, revision]);
  return (
    <div className="feed" aria-label="Project activity">
      {error && (
        <p className="error" role="alert">
          {error}
          <button onClick={() => void load()}>Try again</button>
        </p>
      )}
      {loading && !items.length && (
        <p role="status">Loading project activity…</p>
      )}
      {!loading && !error && !items.length && (
        <Empty title="No completed work yet.">
          Final answers from this project appear here. Active tasks are in
          Running.
        </Empty>
      )}
      {items.map((item) => (
        <ArtifactCard
          key={item.id}
          item={item}
          connections={connections}
          onOpen={() =>
            item.conversation_id
              ? onConversation(item.conversation_id)
              : onOpen(item)
          }
          onArtifact={() => onOpen(item)}
          onReply={() => onReply(item)}
          onProfile={() => {
            const agent = agents.find((a) => a.id === item.agent_id);
            if (agent) onAgent(agent);
          }}
          onFile={() => onFile(item)}
        />
      ))}
      {next !== null && (
        <button
          className="secondary"
          disabled={loading}
          onClick={() => void load(true)}
        >
          {loading ? "Loading…" : "Earlier activity"}
        </button>
      )}
    </div>
  );
}
