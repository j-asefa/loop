import { listenWorkspaceChanges } from "./workspace-changes";
import { useSourceId, useSourceApi, useSourcePath } from "./SourceContext";
import { useEffect, useState } from "react";
import { Expand, File } from "lucide-react";
import { parse, retryAfter, isRateLimited } from "./api";
import type { ResultCard } from "../shared/cards";
import type { Artifact } from "../shared/types";
import { FilePreview } from "./FilePreview";
import { isHtmlFile } from "../shared/file-preview";
type Published = Pick<Artifact, "id" | "title" | "metadata"> &
  Partial<Pick<Artifact, "content">>;
export function PublishedFile({
  item,
  preview = true,
}: {
  item: Published;
  preview?: boolean;
}) {
  const meta = parse<any>(item.metadata, {});
  return (
    <PublishedFileView
      id={item.id}
      title={item.title}
      content={item.content}
      preview={preview}
      display={{
        filename: meta.name || item.title,
        mime: meta.mime,
        text: meta.text,
        size: meta.size || 0,
      }}
    />
  );
}
export function CardFile({ card }: { card: ResultCard }) {
  if (!card.display.download)
    return (
      <div className="published-file">
        <strong>{card.display.filename || card.title}</strong>
        {card.content && (
          <pre className="file-text-preview">{card.content}</pre>
        )}
        <p>File preview is unavailable from this source.</p>
      </div>
    );
  return (
    <PublishedFileView
      id={card.source.artifact_id!}
      title={card.title}
      content={card.content}
      display={card.display}
      download={card.display.download || undefined}
    />
  );
}
function PublishedFileView({
  id,
  title,
  content,
  display,
  download,
  preview = true,
}: {
  id: string;
  title: string;
  content?: string;
  preview?: boolean;
  download?: string;
  display: Pick<ResultCard["display"], "filename" | "mime" | "text" | "size">;
}) {
  const sourceApiPath = useSourcePath();
  const [open, setOpen] = useState(false);
  const meta = {
    ...display,
    name: display.filename,
    size: display.size || 0,
    mime: display.mime || "",
  };
  const image = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
    meta.mime,
  );
  const name = meta.name || title;
  const url = sourceApiPath(download || "/api/artifacts/" + id + "/file");
  return (
    <div className="published-file">
      {image && (
        <button
          type="button"
          className="published-file-image"
          aria-label={`Preview image ${name}`}
          onClick={() => setOpen(true)}
        >
          <img src={url + "?preview=1"} alt={name} loading="lazy" />
        </button>
      )}
      {preview && meta.text && !isHtmlFile(name, meta.mime) && (
        <pre className="file-text-preview">{content}</pre>
      )}
      <button
        type="button"
        className="published-file-open"
        aria-label={`Preview ${name}`}
        onClick={() => setOpen(true)}
      >
        <File size={20} aria-hidden="true" />
        <span>
          <strong>{name}</strong>
          <small>
            {meta.size >= 1024 * 1024
              ? (meta.size / (1024 * 1024)).toFixed(1) + " MB"
              : Math.max(1, Math.ceil((meta.size || 0) / 1024)) + " KB"}
          </small>
        </span>
        <Expand size={18} aria-hidden="true" />
      </button>
      {open && (
        <FilePreview
          url={url}
          name={name}
          mime={meta.mime}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
export function RunFiles({
  runId,
  excludeId,
  active = false,
}: {
  runId?: string | null;
  excludeId?: string;
  active?: boolean;
}) {
  const api = useSourceApi();
  const sourceId = useSourceId();
  const [files, setFiles] = useState<Published[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setFiles([]);
    setError("");
    const refresh = () => {
      if (live && runId)
        void api<Published[]>("/runs/" + runId + "/files")
          .then((files) => {
            if (live) {
              clearTimeout(retry);
              setFiles(files);
              setError("");
            }
          })
          .catch((e) => {
            if (!live) return;
            if (isRateLimited(e)) {
              // The thread keeps its cached transcript and one quiet status.
              // Static file lists also recover once the source allows reads.
              clearTimeout(retry);
              retry = setTimeout(refresh, Math.min(2_147_483_647, retryAfter(e)));
            } else setError(e.message);
          });
    };
    refresh();
    const timer = active ? setInterval(refresh, 5000) : undefined;
    const stopChanges = listenWorkspaceChanges("results", refresh, sourceId);
    return () => {
      live = false;
      clearInterval(timer);
      clearTimeout(retry);
      stopChanges();
    };
  }, [runId, active, api, sourceId]);
  const visible = files.filter((file) => file.id !== excludeId);
  if (!visible.length && !error) return null;
  return (
    <section className="published-files" aria-label="Files from this run">
      <h3>Files</h3>
      {error && <p role="alert">Could not load files: {error}</p>}
      {visible.map((file) => (
        <PublishedFile key={file.id} item={file} preview={false} />
      ))}
    </section>
  );
}
