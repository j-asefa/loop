import { ArtifactId, ObjectId } from "../shared/contract-ids.js";
import { fetchStream, routeUrl } from "./api";
import { workspaceApi } from "../shared/workspace-api";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Download, File as FileIcon, Share2 } from "lucide-react";
import { RichText, Sheet } from "./components";
import { isHtmlFile } from "../shared/file-preview";
import { viewGeneration } from "./viewCache";

export function loopFileUrl(href?: string, source?: string, preview?: "html") {
  if (!href) return;
  try {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return;
    const artifact =
      /^\/api\/(?:agent-sources\/([^/]+)\/)?artifacts\/([^/]+)\/file$/.exec(
        url.pathname,
      );
    const object =
      /^\/api\/(?:agent-sources\/([^/]+)\/)?objects\/([^/]+)$/.exec(
        url.pathname,
      );
    const target = artifact ?? object;
    if (!target) return;
    const query: Record<string, string | string[]> = Object.create(null);
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key);
      query[key] = values.length === 1 ? values[0] : values;
    }
    if (preview) query.preview = preview;
    const id = decodeURIComponent(target[2]);
    const sourceId = source ?? decodeURIComponent(target[1] ?? "");
    return artifact
      ? routeUrl(
          workspaceApi.artifactFile,
          {
            params: { id: ArtifactId.parse(id) },
            query,
          },
          sourceId,
        )
      : routeUrl(
          workspaceApi.objectFile,
          { params: { id: ObjectId.parse(id) }, query },
          sourceId,
        );
  } catch {
    // Other links keep the normal Markdown link behaviour.
  }
}

export function FileLink({
  url,
  children,
  name = "File preview",
  mime,
  className,
}: {
  url: string;
  children: ReactNode;
  name?: string;
  mime?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <a
        href={url}
        className={className}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </a>
      {open && (
        <FilePreview
          url={url}
          name={name}
          mime={mime}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function responseName(response: Response) {
  const value = response.headers
    .get("content-disposition")
    ?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (value) {
    try {
      return decodeURIComponent(value);
    } catch {
      /* Keep the supplied name. */
    }
  }
}

const previewMime: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/plain",
  tsv: "text/plain",
  log: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
};

type ReadyFile = {
  file: File;
  downloadUrl: string;
  imageUrl?: string;
  videoUrl?: string;
  htmlUrl?: string;
  text?: string;
  markdown?: boolean;
  truncated?: boolean;
};

export function FilePreview(props: FilePreviewProps) {
  const identity = JSON.stringify([props.url, viewGeneration()]);
  const [opened] = useState(identity);
  const current = opened === identity;
  useEffect(() => {
    if (!current) props.onClose();
  }, [current, props.onClose]);
  // A mounted preview belongs to the file and owner that opened it. Closing
  // also aborts the old read; changing sources never starts a replacement read.
  return current ? <FilePreviewBody {...props} /> : null;
}
type FilePreviewProps = {
  url: string;
  name: string;
  mime?: string;
  onClose: () => void;
};
function FilePreviewBody({ url, name, mime, onClose }: FilePreviewProps) {
  const [ready, setReady] = useState<ReadyFile>(),
    [error, setError] = useState(""),
    [saveError, setSaveError] = useState(""),
    [sharing, setSharing] = useState(false),
    [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const generation = viewGeneration();
    const current = () =>
      !controller.signal.aborted && generation === viewGeneration();
    const urls: string[] = [];
    const objectUrl = (blob: Blob) => {
      const result = URL.createObjectURL(blob);
      urls.push(result);
      return result;
    };
    setReady(undefined);
    setError("");
    setSaveError("");
    void (async () => {
      try {
        const artifact =
          /^\/api\/(?:agent-sources\/([^/]+)\/)?artifacts\/([^/?#]+)\/file(?:\?[^#]*)?$/.exec(
            url,
          );
        const object =
          /^\/api\/(?:agent-sources\/([^/]+)\/)?objects\/([^/?#]+)(?:\?[^#]*)?$/.exec(
            url,
          );
        const target = artifact ?? object;
        if (!target) throw new Error("File address is unavailable");
        const previews = new URL(url, location.href).searchParams.getAll(
          "preview",
        );
        const id = decodeURIComponent(target[2]);
        const sourceId = decodeURIComponent(target[1] ?? "");
        const query = { preview: previews.length > 1 ? previews : previews[0] };
        const response = await (artifact
          ? fetchStream(
              workspaceApi.artifactFile,
              {
                params: { id: ArtifactId.parse(id) },
                query,
              },
              sourceId,
              controller.signal,
            )
          : fetchStream(
              workspaceApi.objectFile,
              {
                params: { id: ObjectId.parse(id) },
                query,
              },
              sourceId,
              controller.signal,
            ));
        if (response.redirected || response.status === 401)
          throw new Error("Sign in to Loop to open this file.");
        if (!response.ok)
          throw new Error("Could not load this file. Please try again.");
        const blob = await response.blob();
        const fileName = responseName(response) || name;
        const responseType = (mime || blob.type).split(";")[0].toLowerCase();
        const type =
          !responseType || responseType === "application/octet-stream"
            ? previewMime[fileName.split(".").at(-1)?.toLowerCase() || ""] ||
              "application/octet-stream"
            : responseType;
        const file = new File([blob], fileName, { type });
        const htmlUrl = isHtmlFile(fileName, type)
          ? loopFileUrl(url, undefined, "html")
          : undefined;
        const html = !!htmlUrl;
        const image = [
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
        ].includes(type);
        const text =
          !html &&
          (type.startsWith("text/") ||
            [
              "application/json",
              "application/xml",
              "application/yaml",
            ].includes(type));
        const content = text ? await file.slice(0, 100_000).text() : undefined;
        if (!current()) return;
        setReady({
          file,
          // HTML is a server-sandboxed document, never an app-origin blob or
          // srcdoc. The full file (including embedded assets) is preserved.
          htmlUrl,
          imageUrl: image ? objectUrl(file) : undefined,
          videoUrl: ["video/mp4", "video/webm", "video/quicktime"].includes(
            type,
          )
            ? objectUrl(file)
            : undefined,
          text: content,
          markdown:
            type === "text/markdown" || /\.(md|markdown)$/i.test(fileName),
          truncated: text && file.size > 100_000,
          downloadUrl: objectUrl(
            new Blob([blob], { type: "application/octet-stream" }),
          ),
        });
      } catch (error) {
        if (current()) setError((error as Error).message);
      }
    })();
    return () => {
      controller.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [url, name, mime, attempt]);

  let canShare = false;
  try {
    canShare = !!(
      ready &&
      typeof navigator.share === "function" &&
      navigator.canShare?.({ files: [ready.file] })
    );
  } catch {
    // Some browsers expose the API without allowing file sharing.
  }
  async function save() {
    if (!ready || sharing) return;
    setSaveError("");
    setSharing(true);
    try {
      // The file is prepared before the tap so iOS retains user activation.
      // Its share sheet offers Save to Files without navigating away from Loop.
      await navigator.share({ files: [ready.file] });
    } catch (error) {
      if ((error as Error).name !== "AbortError")
        setSaveError("Could not save this file. Please try again.");
    } finally {
      setSharing(false);
    }
  }

  return createPortal(
    <div
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <Sheet
        title={ready?.file.name || name}
        className="file-preview-sheet"
        wide
        onClose={onClose}
      >
        <div
          className={`file-preview-content${ready?.htmlUrl && !error ? " file-preview-html" : ""}${ready?.markdown && !error ? " file-preview-markdown" : ""}`}
          aria-busy={!ready && !error}
        >
          {error ? (
            <div className="file-preview-placeholder">
              <FileIcon size={44} aria-hidden="true" />
              <p role="alert">{error}</p>
              {!ready && (
                <button
                  className="secondary"
                  onClick={() => setAttempt(attempt + 1)}
                >
                  Try again
                </button>
              )}
            </div>
          ) : !ready ? (
            <p role="status">Loading preview…</p>
          ) : ready.htmlUrl ? (
            <iframe
              src={ready.htmlUrl}
              title={`Preview of ${ready.file.name}`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          ) : ready.imageUrl ? (
            <img
              src={ready.imageUrl}
              alt={ready.file.name}
              onError={() =>
                setError(
                  "The image preview could not be displayed. You can still save the file.",
                )
              }
            />
          ) : ready.videoUrl ? (
            <video
              src={ready.videoUrl}
              controls
              playsInline
              preload="metadata"
              aria-label={ready.file.name}
              onError={() =>
                setError(
                  "This browser could not play the video. You can still save the file.",
                )
              }
            />
          ) : ready.text !== undefined ? (
            <>
              {ready.markdown ? (
                // The same renderer as chat answers: no raw HTML, and Loop
                // file links open in their own preview.
                <RichText content={ready.text} />
              ) : (
                <pre>{ready.text}</pre>
              )}
              {ready.truncated && (
                <p className="muted">
                  Preview shortened. Save the file to see the full contents.
                </p>
              )}
            </>
          ) : (
            <div className="file-preview-placeholder">
              <FileIcon size={44} aria-hidden="true" />
              <p>Save this file to open it in another app.</p>
            </div>
          )}
        </div>
        {ready && (
          <div className="file-preview-actions">
            {saveError && (
              <p role="alert" className="error">
                {saveError}
              </p>
            )}
            {canShare ? (
              <button
                className="primary"
                onClick={() => void save()}
                disabled={sharing}
              >
                <Share2 size={18} />
                Save or share
              </button>
            ) : (
              <a
                className="primary"
                href={ready.downloadUrl}
                download={ready.file.name}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Download size={18} />
                Download
              </a>
            )}
          </div>
        )}
      </Sheet>
    </div>,
    document.body,
  );
}
