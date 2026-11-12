import { proseEntry } from "./textEntry";
import { routeUrl } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import type { ResultCard } from "../shared/cards";
import { resultTarget, type ResultAction } from "./card-actions";
import { CardBody } from "./ContentCard";
import { useSourcePath, useSourceRoute, useSourceId } from "./SourceContext";
import { performStoredEffect, UncertainEffect } from "./pendingCommands";
import { EffectRecovery } from "./EffectRecovery";
import { viewGeneration, viewOwner } from "./viewCache";
import { SourceCard } from "./Sharing";
import { Chart } from "./Chart";
import { PullRequestCards, pullRequestCardData } from "./PullRequestCard";
const McpApp = lazy(() =>
  import("./McpApp").then((m) => ({ default: m.McpApp })),
);
import { useState, useEffect, useRef, lazy, Suspense } from "react";
import {
  Download,
  FolderInput,
  MessageSquare,
  Copy,
  Play,
  Code,
  MoreHorizontal,
} from "lucide-react";
import { Sheet, RichText } from "./components";
import { ResultIdentity } from "./ResultIdentity";
import { runModelName } from "./modelChoices";
import { PublishedFile, CardFile, RunFiles } from "./PublishedFiles";
import { FileLink } from "./FilePreview";
import { Diagram } from "./Diagram";
import { parse } from "./api";
import { AutofillBoundary } from "./AutofillBoundary";
import type { Agent, Artifact, Connection } from "../shared/types";
function ArtifactContent({ item }: { item: Artifact }) {
  if (parse<any>(item.metadata, {}).uploaded)
    return <PublishedFile item={item} />;
  return <ResultContent item={item} />;
}
export function ResultBody({ card }: { card: ResultCard }) {
  if (card.role === "file" || card.role === "upload")
    return <CardFile card={card} />;
  return (
    <ResultContent
      item={{
        id: card.source.artifact_id!,
        conversation_id: card.source.conversation_id,
        title: card.title,
        kind: card.kind,
        content: card.content,
      }}
    />
  );
}
function ResultContent({
  item,
}: {
  item: Pick<Artifact, "id" | "conversation_id" | "kind" | "title" | "content">;
}) {
  // Exhaustive over the artifact kind enum: adding a kind without a rendering
  // branch makes the never assertion below fail typecheck (D1).
  switch (item.kind) {
    case "image": {
      const value = parse<any>(item.content, null);
      if (
        value &&
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          value.mimeType,
        ) &&
        typeof value.data === "string"
      )
        return (
          <img
            className="native-image"
            src={"data:" + value.mimeType + ";base64," + value.data}
            alt={item.title}
          />
        );
      return <p>Image source is available by download.</p>;
    }
    case "chart":
      return <Chart content={item.content} />;
    case "github_pr": {
      const card = pullRequestCardData(item.content);
      if (card)
        return (
          <PullRequestCards
            card={card}
            artifactId={item.id}
            conversationId={item.conversation_id}
          />
        );
      return <RichText content={item.content} />;
    }
    case "diagram":
      return <Diagram source={item.content} />;
    case "table": {
      const d = parse<any>(item.content, null);
      if (d && Array.isArray(d.columns) && Array.isArray(d.rows))
        return (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {d.columns.map((c: any, i: number) => (
                    <th key={i}>{String(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.rows.slice(0, 1000).map((row: any[], i: number) => (
                  <tr key={i}>
                    {row.map((v, j) => (
                      <td key={j}>
                        {typeof v === "object"
                          ? JSON.stringify(v)
                          : String(v ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      return <RichText content={item.content} />;
    }
    case "markdown":
    case "file":
    case "conversation":
      return <RichText content={item.content} />;
    default: {
      // Unknown kinds cannot be stored (D1), so this branch stays unreachable.
      const exhaustive: never = item.kind;
      void exhaustive;
      return <RichText content={item.content} />;
    }
  }
}
export function ArtifactViewer({
  item,
  connections,
  agent,
  onProfile,
  onClose,
  onFile,
  onConversation,
  onChanged,
  onRun,
  onReply,
}: {
  item: ResultAction;
  connections: Connection[];
  agent?: Agent;
  onProfile: (agent: Agent) => void;
  onClose: () => void;
  onFile: () => void;
  onConversation: () => void;
  onChanged: () => void;
  onRun: (text: string) => void;
  onReply: () => void;
}) {
  const target = resultTarget(item);
  const call = useSourceRoute();
  const sourceId = useSourceId();
  const sourceApiPath = useSourcePath();
  const generation = viewGeneration();
  const context = JSON.stringify([sourceId, target.id, generation]);
  const activeContext = useRef(context);
  activeContext.current = context;
  const owner = useRef(viewOwner()),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = () =>
    alive.current &&
    owner.current === viewOwner() &&
    generation === viewGeneration() &&
    context === activeContext.current;
  const card = item.card;
  const meta = card
      ? {
          origin: card.role === "import" ? "import" : undefined,
          refreshable: card.display.refreshable,
          source: card.display.source
            ? {
                url: card.display.source.url,
                title: card.display.source.title || undefined,
                excerpt: card.display.source.excerpt || undefined,
              }
            : null,
          appResource: card.display.app,
          model: card.display.model,
          name: card.display.filename,
          mime: card.display.mime,
        }
      : parse<any>(item.card ? "" : item.metadata, {}),
    [editing, setEditing] = useState(false),
    [text, setText] = useState(target.content),
    [error, setError] = useState("");
  async function save() {
    if (!current()) return;
    try {
      await call(workspaceApi.artifactUpdate, {
        params: { id: target.id },
        body: { content: text, version: target.version },
      });
      if (!current()) return;
      onChanged();
      onClose();
    } catch (e) {
      if (current()) setError((e as Error).message);
    }
  }
  const [recovery, setRecovery] = useState<{
    failure: UncertainEffect;
    key: string;
  }>();
  const author = agent?.name || (item.card ? item.card.author.name : item.name);
  return (
    <Sheet
      wide
      swipeToClose
      className="result-sheet"
      title={target.title}
      onClose={onClose}
      heading={
        <div className="result-header">
          <ResultIdentity
            name={author ?? undefined}
            model={
              card ? card.display.model || "" : runModelName(meta, connections)
            }
            createdAt={target.created_at}
            onProfile={agent ? () => onProfile(agent) : undefined}
          />
          <details className="conversation-options result-options">
            <summary aria-label="Result options">
              <MoreHorizontal size={20} />
            </summary>
            <div
              className="conversation-options-menu result-options-menu"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("button, a"))
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
              }}
            >
              {(item.card ? item.card.hidden : item.feed_hidden === 1) && (
                <button
                  onClick={async () => {
                    try {
                      await call(workspaceApi.resultUpdate, {
                        params: { id: target.id },
                        body: { hidden: false },
                      });
                      if (!current()) return;
                      onChanged();
                      onClose();
                    } catch (e) {
                      if (current()) setError((e as Error).message);
                    }
                  }}
                >
                  Restore to feed
                </button>
              )}
              {(meta.refreshable || meta.connectionId) && (
                <button
                  onClick={async () => {
                    setRecovery(undefined);
                    try {
                      await performStoredEffect(
                        localStorage,
                        owner.current,
                        sourceId,
                        ["artifact-refresh", target.id],
                        current,
                        (idempotencyKey) =>
                          call(workspaceApi.artifactRefresh, {
                            params: { id: target.id },
                            body: { idempotencyKey },
                          }),
                        (error, recovering) => {
                          const failure = error as {
                            status?: number;
                            executionOutcome?: string;
                          };
                          if (failure.executionOutcome)
                            return (
                              failure.executionOutcome === "refused" ||
                              failure.executionOutcome === "completed"
                            );
                          return (
                            !recovering &&
                            failure.status !== undefined &&
                            failure.status >= 400 &&
                            failure.status < 500
                          );
                        },
                      );
                      if (!current()) return;
                      setError(
                        "Refresh queued. Approve the request in Running; this snapshot stays saved.",
                      );
                    } catch (e) {
                      if (current()) {
                        setError((e as Error).message);
                        if (e instanceof UncertainEffect)
                          setRecovery({ failure: e, key: crypto.randomUUID() });
                      }
                    }
                  }}
                >
                  Refresh from source
                </button>
              )}
              <button onClick={onFile}>
                <FolderInput size={16} />
                File
              </button>
              {target.conversation_id && (
                <button onClick={onConversation}>
                  <MessageSquare size={16} />
                  Source conversation
                </button>
              )}
              {(card?.display.download ||
                meta.objectId ||
                meta.rawObjectId) && (
                <FileLink
                  className="text-button"
                  url={
                    card?.display.download
                      ? sourceApiPath(card.display.download)
                      : routeUrl(
                          workspaceApi.objectFile,
                          {
                            params: {
                              id: String(meta.objectId || meta.rawObjectId),
                            },
                          },
                          sourceId,
                        )
                  }
                  name={meta.name || target.title}
                  mime={meta.mime}
                >
                  <Download size={16} />
                  Original file
                </FileLink>
              )}
              <button
                onClick={() => {
                  const blob = new Blob([target.content], {
                    type: "text/plain",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download =
                    target.title.replace(/[^a-zA-Z0-9._-]/g, "-") + ".md";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                <Download size={16} />
                Download
              </button>
              <button
                onClick={() => navigator.clipboard.writeText(target.content)}
              >
                <Copy size={16} />
                Copy
              </button>
              <button onClick={() => setEditing(!editing)}>
                <Code size={16} />
                {editing ? "Preview" : "Edit"}
              </button>
              <button onClick={() => onRun(text)}>
                <Play size={16} />
                Use as prompt
              </button>
            </div>
          </details>
        </div>
      }
    >
      <div className="result-content">
        <h3 className="result-title">{target.title}</h3>
        {meta.source && <SourceCard source={meta.source} />}
        {meta.appResource && (
          <Suspense fallback={<p>Loading isolated app…</p>}>
            <McpApp artifactId={target.id} metadata={card ? undefined : meta} />
          </Suspense>
        )}
        <div className="artifact-body">
          {editing ? (
            <AutofillBoundary>
              <textarea
                {...proseEntry}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={16}
              />
            </AutofillBoundary>
          ) : item.card ? (
            <CardBody card={item.card} />
          ) : (
            <ArtifactContent item={item} />
          )}
        </div>
        <RunFiles runId={target.run_id} excludeId={target.id} />
        {!card &&
          (item as { role?: string }).role === "answer" &&
          ["failed", "cancelled", "interrupted"].includes(
            (item as { run_state?: string | null }).run_state ?? "",
          ) && (
            <p className="note">
              This run did not finish normally; the answer may be incomplete.
            </p>
          )}
        {recovery && (
          <EffectRecovery
            key={recovery.key}
            failure={recovery.failure}
            onReady={() => {
              if (!current()) return;
              setRecovery(undefined);
              setError(
                "No new command was sent. Use Refresh from source when you are ready.",
              );
            }}
          />
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      {!editing &&
        agent &&
        target.conversation_id &&
        meta.origin !== "import" && (
          <div className="result-edit-actions">
            <button className="primary" onClick={onReply}>
              <MessageSquare size={18} />
              Reply
            </button>
          </div>
        )}
      {editing && (
        <div className="result-edit-actions">
          <button className="secondary" onClick={() => setEditing(false)}>
            Cancel editing
          </button>
          <button className="primary" onClick={save}>
            Save version
          </button>
        </div>
      )}
    </Sheet>
  );
}
