import { SourceCard } from "./Sharing";
import { Chart } from "./Chart";
const McpApp = lazy(() =>
  import("./McpApp").then((m) => ({ default: m.McpApp })),
);
import { useState, lazy, Suspense } from "react";
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
import { PublishedFile, RunFiles } from "./PublishedFiles";
import { FileLink } from "./FilePreview";
import { Diagram } from "./Diagram";
import { api, parse } from "./api";
import type { Agent, Artifact, Connection } from "../shared/types";
export function ArtifactContent({ item }: { item: Artifact }) {
  if (parse<any>(item.metadata, {}).uploaded)
    return <PublishedFile item={item} />;
  if (item.kind === "image") {
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
  if (item.kind === "chart") return <Chart content={item.content} />;
  if (item.kind === "diagram") return <Diagram source={item.content} />;
  if (item.kind === "code")
    return (
      <pre className="code-artifact">
        <code>{item.content}</code>
      </pre>
    );
  if (item.kind === "table") {
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
  }
  return <RichText content={item.content} />;
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
  onWorkflow,
  onReply,
}: {
  item: Artifact;
  connections: Connection[];
  agent?: Agent;
  onProfile: (agent: Agent) => void;
  onClose: () => void;
  onFile: () => void;
  onConversation: () => void;
  onChanged: () => void;
  onRun: (text: string) => void;
  onWorkflow: (source: string) => void;
  onReply: () => void;
}) {
  const meta = parse<any>(item.metadata, {}),
    [editing, setEditing] = useState(false),
    [text, setText] = useState(item.content),
    [error, setError] = useState("");
  async function save() {
    try {
      await api(
        "/artifacts/" + item.id,
        { content: text, version: item.version },
        "PATCH",
      );
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const author = agent?.name || item.name;
  return (
    <Sheet
      wide
      swipeToClose
      className="result-sheet"
      title={item.title}
      onClose={onClose}
      heading={
        <div className="result-header">
          <ResultIdentity
            name={author}
            model={runModelName(meta, connections)}
            createdAt={item.created_at}
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
              {item.feed_hidden === 1 && (
                <button
                  onClick={async () => {
                    try {
                      await api("/feed/" + item.id, { hidden: false }, "PATCH");
                      onChanged();
                      onClose();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Restore to feed
                </button>
              )}
              {meta.connectionId && (
                <button
                  onClick={async () => {
                    try {
                      await api("/artifacts/" + item.id + "/refresh", {
                        idempotencyKey: crypto.randomUUID(),
                      });
                      setError(
                        "Refresh queued. Approve the request in Running; this snapshot stays saved.",
                      );
                    } catch (e) {
                      setError((e as Error).message);
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
              {item.conversation_id && (
                <button onClick={onConversation}>
                  <MessageSquare size={16} />
                  Source conversation
                </button>
              )}
              {(meta.objectId || meta.rawObjectId) && (
                <FileLink
                  className="text-button"
                  url={"/api/objects/" + (meta.objectId || meta.rawObjectId)}
                  name={meta.name || item.title}
                  mime={meta.mime}
                >
                  <Download size={16} />
                  Original file
                </FileLink>
              )}
              <button
                onClick={() => {
                  const blob = new Blob([item.content], { type: "text/plain" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download =
                    item.title.replace(/[^a-zA-Z0-9._-]/g, "-") + ".md";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                <Download size={16} />
                Download
              </button>
              <button
                onClick={() => navigator.clipboard.writeText(item.content)}
              >
                <Copy size={16} />
                Copy
              </button>
              <button onClick={() => setEditing(!editing)}>
                <Code size={16} />
                {editing ? "Preview" : "Edit"}
              </button>
              <button
                onClick={() =>
                  onWorkflow(text.replace(/^```(?:json)?\s*|\s*```$/g, ""))
                }
              >
                Open as workflow source
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
        <h3 className="result-title">{item.title}</h3>
        {meta.source && <SourceCard source={meta.source} />}
        {meta.appResource && (
          <Suspense fallback={<p>Loading isolated app…</p>}>
            <McpApp artifactId={item.id} metadata={meta} />
          </Suspense>
        )}
        <div className="artifact-body">
          {editing ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={16}
            />
          ) : (
            <ArtifactContent item={item} />
          )}
        </div>
        {meta.partial && (
          <p className="note">
            Partial output. This run did not finish normally.
          </p>
        )}
        <RunFiles runId={item.run_id} excludeId={item.id} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      {!editing &&
        agent &&
        item.conversation_id &&
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
