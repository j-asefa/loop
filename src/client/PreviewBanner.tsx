import type { PreviewInfo } from "../shared/preview";

export function PreviewBanner({ preview }: { preview?: PreviewInfo }) {
  if (!preview) return null;
  return (
    <aside className="preview-banner" aria-label="Experiment preview">
      <div>
        <strong>Preview · {preview.name}</strong>
        <span>
          {preview.mode === "design"
            ? "Sample data · Simulated replies"
            : "Working preview · Real execution"}
        </span>
      </div>
      <details>
        <summary>Build details</summary>
        <p>
          {preview.build.branch} · {preview.build.commit.slice(0, 12)}
          {preview.build.dirty ? " · Includes local edits" : ""}
        </p>
        <p>Built {new Date(preview.build.builtAt).toLocaleString()}</p>
        <p className="muted">Build {preview.build.id.slice(0, 8)}</p>
      </details>
    </aside>
  );
}
