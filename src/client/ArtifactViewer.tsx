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
} from "lucide-react";
import { Sheet, RichText, Badge } from "./components";
import { Diagram } from "./Diagram";
import { api, parse } from "./api";
import type { Artifact, Folder } from "../shared/types";
import { folderPath } from "./Workspace";
export function ArtifactContent({ item }: { item: Artifact }) {
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
  folders,
  onClose,
  onFile,
  onConversation,
  onChanged,
  onRun,
  onWorkflow,
}: {
  item: Artifact;
  folders: Folder[];
  onClose: () => void;
  onFile: () => void;
  onConversation: () => void;
  onChanged: () => void;
  onRun: (text: string) => void;
  onWorkflow: (source: string) => void;
}) {
  const meta = parse<any>(item.metadata, {}),
    [editing, setEditing] = useState(false),
    [text, setText] = useState(item.content),
    [error, setError] = useState("");
  return (
    <Sheet wide title={item.title} onClose={onClose}>
      {meta.source && <SourceCard source={meta.source} />}
      <div className="artifact-meta">
        <Badge provider={meta.provider || item.provider} />
        <span>
          {meta.origin === "import" ? "Imported history" : "Created in Loop"}
        </span>
        <span>
          {item.folder_id
            ? folderPath(item.folder_id, folders)
            : "Workspace inbox"}
        </span>
      </div>
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
      {error && <p className="error">{error}</p>}
      <div className="actions">
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
          <a
            className="text-button"
            href={"/api/objects/" + (meta.objectId || meta.rawObjectId)}
          >
            <Download size={16} />
            Download original
          </a>
        )}
        <button
          onClick={() => {
            const blob = new Blob([item.content], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = item.title.replace(/[^a-zA-Z0-9._-]/g, "-") + ".md";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download size={16} />
          Download
        </button>
        <button onClick={() => navigator.clipboard.writeText(item.content)}>
          <Copy size={16} />
          Copy
        </button>
        <button onClick={() => setEditing(!editing)}>
          <Code size={16} />
          {editing ? "Preview" : "Edit"}
        </button>
        {editing && (
          <button
            onClick={async () => {
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
            }}
          >
            Save version
          </button>
        )}
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
    </Sheet>
  );
}
