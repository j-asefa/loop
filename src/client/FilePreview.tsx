import { legacyFilePath } from "./legacy-paths";
import { sourceApiPathAt } from "./sourceRouting";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Download, File as FileIcon, Share2 } from "lucide-react";
import { authorizedFetch } from "./api";
import { Sheet } from "./components";
import { isHtmlFile } from "../shared/file-preview";

export function loopFileUrl(href?: string, source?: string) {
  if (!href) return;
  try {
    const url = new URL(href, location.href);
    if (
      url.origin === location.origin &&
      /^\/api\/(?:agent-sources\/[^/]+\/)?(artifacts\/[^/]+\/file|objects\/[^/]+)$/.test(
        url.pathname,
      )
    )
      return source === undefined
        ? url.pathname + url.search
        : sourceApiPathAt(
            url.pathname.replace(/^\/api\/agent-sources\/[^/]+\//, "/api/") +
              url.search,
            source,
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
  md: "text/plain",
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
  truncated?: boolean;
};

export function FilePreview({
  url,
  name,
  mime,
  onClose,
}: {
  url: string;
  name: string;
  mime?: string;
  onClose: () => void;
}) {
  const [ready, setReady] = useState<ReadyFile>(),
    [error, setError] = useState(""),
    [saveError, setSaveError] = useState(""),
    [sharing, setSharing] = useState(false),
    [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
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
        const response = await authorizedFetch(legacyFilePath(url), {
          signal: controller.signal,
        });
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
        const localUrl = loopFileUrl(url);
        const html = isHtmlFile(fileName, type) && localUrl;
        const htmlUrl = html ? new URL(localUrl, location.href) : undefined;
        htmlUrl?.searchParams.set("preview", "html");
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
        if (controller.signal.aborted) return;
        setReady({
          file,
          // HTML is a server-sandboxed document, never an app-origin blob or
          // srcdoc. The full file (including embedded assets) is preserved.
          htmlUrl: htmlUrl ? htmlUrl.pathname + htmlUrl.search : undefined,
          imageUrl: image ? objectUrl(file) : undefined,
          videoUrl: ["video/mp4", "video/webm", "video/quicktime"].includes(
            type,
          )
            ? objectUrl(file)
            : undefined,
          text: content,
          truncated: text && file.size > 100_000,
          downloadUrl: objectUrl(
            new Blob([blob], { type: "application/octet-stream" }),
          ),
        });
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
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
          className={`file-preview-content${ready?.htmlUrl && !error ? " file-preview-html" : ""}`}
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
              <pre>{ready.text}</pre>
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
