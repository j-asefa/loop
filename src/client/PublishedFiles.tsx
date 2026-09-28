import { useEffect, useState } from "react";
import { Expand, File } from "lucide-react";
import { api, parse } from "./api";
import type { Artifact } from "../shared/types";
import { FilePreview } from "./FilePreview";
type Published = Pick<Artifact, "id" | "title" | "metadata"> &
  Partial<Pick<Artifact, "content">>;
export function PublishedFile({
  item,
  preview = true,
}: {
  item: Published;
  preview?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const meta = parse<any>(item.metadata, {});
  const image = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
    meta.mime,
  );
  const name = meta.name || item.title;
  const url = "/api/artifacts/" + item.id + "/file";
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
      {preview && meta.text && (
        <pre className="file-text-preview">{item.content}</pre>
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
  const [files, setFiles] = useState<Published[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setFiles([]);
    setError("");
    const refresh = () => {
      if (runId)
        void api<Published[]>("/runs/" + runId + "/files")
          .then((files) => {
            if (live) {
              setFiles(files);
              setError("");
            }
          })
          .catch((e) => {
            if (live) setError(e.message);
          });
    };
    refresh();
    const timer = active ? setInterval(refresh, 5000) : undefined;
    window.addEventListener("loop-workspace-change", refresh);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("loop-workspace-change", refresh);
    };
  }, [runId, active]);
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
