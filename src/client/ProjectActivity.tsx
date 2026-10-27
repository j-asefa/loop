import { Empty } from "./components";
import { ContentCard } from "./ContentCard";
import { cardArtifact } from "./card-actions";
import { useCards } from "./useCards";
import { CollectionReadNotice } from "./CollectionRead";
import { useSourceId } from "./SourceContext";
import type { Agent, Artifact, Connection } from "../shared/types";

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
  const source = useSourceId();
  const { items, next, loading, busy, error, load, retry } = useCards(
    { view: "results", project: projectId },
    revision,
  );
  return (
    <div className="feed" aria-label="Project activity">
      <CollectionReadNotice
        error={error}
        busy={busy}
        retry={() => void retry()}
      />
      {loading && !items.length && (
        <p role="status">Loading project activity…</p>
      )}
      {!loading && !error && !items.length && (
        <Empty title="No completed work yet.">
          Final answers from this project appear here. Active tasks are in
          Running.
        </Empty>
      )}
      {items.map(({ card }) => {
        if (card.type !== "result") return null;
        const item = cardArtifact(card, source);
        return (
          <ContentCard
            key={card.id}
            card={card}
            onOpen={() => onOpen(item)}
            onReply={() => onReply(item)}
            onProfile={
              agents.some((a) => a.id === card.author.id)
                ? () => onAgent(agents.find((a) => a.id === card.author.id)!)
                : undefined
            }
            onFile={() => onFile(item)}
          />
        );
      })}
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
