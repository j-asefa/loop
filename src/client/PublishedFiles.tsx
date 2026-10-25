import { routeUrl } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import { listenWorkspaceChanges } from "./workspace-changes";
import { useSourceId, useSourceRead, useSourcePath } from "./SourceContext";
import { surfaceFallback } from "./workspace-projections";
import { useEffect, useRef, useState } from "react";
import { Expand, File } from "lucide-react";
import { isRateLimited, parse } from "./api";
import type { ResultCard } from "../shared/cards";
import type { Artifact } from "../shared/types";
import { FilePreview } from "./FilePreview";
import { isHtmlFile } from "../shared/file-preview";
type Published = Pick<Artifact, "id" | "title" | "metadata"> &
  Partial<Pick<Artifact, "content">>;
export function PublishedFile({
  item,
  preview = true,
  previewImages = true,
}: {
  item: Published;
  preview?: boolean;
  previewImages?: boolean;
}) {
  const meta = parse<any>(item.metadata, {});
  return (
    <PublishedFileView
      id={item.id}
      title={item.title}
      content={item.content}
      preview={preview}
      previewImages={previewImages}
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
  previewImages = true,
}: {
  id: string;
  title: string;
  content?: string;
  preview?: boolean;
  previewImages?: boolean;
  download?: string;
  display: Pick<ResultCard["display"], "filename" | "mime" | "text" | "size">;
}) {
  const sourceApiPath = useSourcePath(), source = useSourceId();
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
  const url = download ? sourceApiPath(download) : routeUrl(workspaceApi.artifactFile, { params: { id } }, source);
  return (
    <div className="published-file">
      {previewImages && image && (
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

/** Let the transcript paint and settle at its reading position before file reads. */
export function ConversationFiles({
  runId,
  active,
  ready,
}: {
  runId: string;
  active: boolean;
  ready: boolean;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ready || visible || !slot.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { root: slot.current.closest(".messages"), rootMargin: "200px" },
    );
    observer.observe(slot.current);
    return () => observer.disconnect();
  }, [ready, visible]);
  return (
    <div ref={slot}>
      {/* Once activated, keep the list through transcript anchor reloads. */}
      {visible && (
        <RunFiles runId={runId} active={active} previewImages={false} />
      )}
    </div>
  );
}

export function RunFiles({
  runId,
  excludeId,
  active = false,
  previewImages = true,
}: {
  runId?: string | null;
  excludeId?: string;
  active?: boolean;
  previewImages?: boolean;
}) {
  const read = useSourceRead();
  const sourceId = useSourceId();
  const [files, setFiles] = useState<Published[]>([]),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    let pending = false,
      queued = false;
    const controller = new AbortController();
    setFiles([]);
    setError("");
    const refresh = () => {
      if (!live || !runId) return;
      if (pending) {
        queued = true;
        return;
      }
      pending = true;
      void read<Published[]>(`/runs/${runId}/files`, controller.signal, (error) => {
        // Keep the existing immediate error and manual retry while a bounded
        // transient GET retry is pending. Rate limits remain quiet.
        if (live && !isRateLimited(error)) setError((error as Error).message);
      })
        .then((files) => {
          if (live) {
            setFiles(files);
            setError("");
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        })
        .finally(() => {
          pending = false;
          if (!live) return;
          if (queued) {
            queued = false;
            refresh();
          }
        });
    };
    refresh();
    const stopFallback = active ? surfaceFallback([sourceId], "results", 5000, refresh) : () => {};
    const stopChanges = listenWorkspaceChanges("results", refresh, sourceId);
    return () => {
      live = false;
      controller.abort();
      stopFallback();
      stopChanges();
    };
  }, [runId, active, read, sourceId, attempt]);
  const visible = files.filter((file) => file.id !== excludeId);
  // Empty runs reserve no space, including while their summaries load. A
  // temporary placeholder would move the reading position twice per answer.
  if (!visible.length && !error) return null;
  return (
    <section className="published-files" aria-label="Files from this run">
      <h3>Files</h3>
      {error && (
        <p role="alert">
          Could not load files: {error}{" "}
          <button
            type="button"
            className="text-button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry files
          </button>
        </p>
      )}
      {visible.map((file) => (
        <PublishedFile
          key={file.id}
          item={file}
          preview={false}
          previewImages={previewImages}
        />
      ))}
    </section>
  );
}
