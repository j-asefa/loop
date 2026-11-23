import { readArtifactMetadata } from "../shared/artifact-metadata.js";
import { ArtifactId } from "../shared/contract-ids.js";
import { RunId } from "../shared/contract-ids.js";
import { routeUrl } from "./api";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { useSourceId, useSourcePath } from "./SourceContext";
import { useEffect, useRef, useState } from "react";
import { Expand, File } from "lucide-react";

import { useProjectionQuery } from "./CollectionRead";
import type { ResultCard } from "../shared/cards";
import type { Artifact } from "../shared/types";
import { FilePreview } from "./FilePreview";
import { isHtmlFile } from "../shared/file-preview";
type Published = RouteResponse<typeof workspaceApi.runFiles>[number] &
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
  const meta = readArtifactMetadata("file", item.metadata, "fallback").metadata;
  return (
    <PublishedFileView
      id={item.id}
      title={item.title}
      content={item.content}
      preview={preview}
      previewImages={previewImages}
      display={{
        filename: meta.name || item.title,
        mime: meta.mime ?? null,
        text: meta.text === true,
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
  const sourceApiPath = useSourcePath(),
    source = useSourceId();
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
  const url = download
    ? sourceApiPath(download)
    : routeUrl(
        workspaceApi.artifactFile,
        { params: { id: ArtifactId.parse(id) } },
        source,
      );
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
          initialText={
            meta.text &&
            typeof content === "string" &&
            !isHtmlFile(name, meta.mime) &&
            previewsAsText(name, meta.mime)
              ? content
              : undefined
          }
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
  const sourceId = useSourceId();
  const [attempt, setAttempt] = useState(0);
  const { data: files = [], error } = useProjectionQuery(
    workspaceApi.runFiles,
    runId ? { params: { id: RunId.parse(runId) } } : undefined,
    {
      source: sourceId,
      revision: `${active}:${attempt}`,
      resetOnRevision: true,
      collections: ["results"],
      reportRetries: "transient",
    },
  );
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

// Matches the text types FilePreview renders once the download finishes, so
// a file it will show as a placeholder never flashes as text first.
function previewsAsText(name: string, mime = "") {
  const type = mime.split(";")[0].trim().toLowerCase();
  if (!type || type === "application/octet-stream")
    return /\.(md|markdown|txt|csv|tsv|log|json|ya?ml)$/i.test(name);
  return (
    type.startsWith("text/") ||
    ["application/json", "application/xml", "application/yaml"].includes(type)
  );
}
