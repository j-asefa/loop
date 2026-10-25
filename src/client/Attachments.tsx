import { callRoute, routeUrl } from "./workspace-api";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { useSourceId } from "./SourceContext";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Paperclip, File, X, Plus, Camera, Image } from "lucide-react";
import { Sheet } from "./components";
import { FilePreview } from "./FilePreview";
import { prepareImage, shouldPrepare } from "./imageUpload";
import {
  MAX_MESSAGE_FILES,
  MAX_UPLOAD_BYTES,
  type UploadedFile,
} from "../shared/uploads";

// Generous for a slow phone connection; a hung request otherwise spins forever.
const UPLOAD_TIMEOUT_MS = 120_000;
const ERROR_MS = 8000;
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export function AttachmentList({
  files,
  onRemove,
  sourceId: requestedSource,
}: {
  files: UploadedFile[];
  sourceId?: string;
  onRemove?: (id: string) => void;
}) {
  const scopedSource = useSourceId();
  const sourceId = requestedSource ?? scopedSource;
  const [preview, setPreview] = useState<UploadedFile>();
  if (!files.length) return null;
  return (
    <>
      <ul className="attachment-list" aria-label="Attached files">
        {files.map((file) => (
          <li key={file.id}>
            <File size={17} aria-hidden="true" />
            <button
              type="button"
              className="attachment-open"
              aria-label={`Preview ${file.name}`}
              onClick={() => setPreview(file)}
            >
              <span>{file.name}</span>
              <small>{size(file.size)}</small>
            </button>
            {onRemove && (
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${file.name}`}
                onClick={() => onRemove(file.id)}
              >
                <X size={17} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {preview && (
        <FilePreview
          url={
            preview.published
              ? routeUrl(workspaceApi.artifactFile, { params: { id: preview.id } }, sourceId)
              : routeUrl(workspaceApi.objectFile, { params: { id: preview.objectId } }, sourceId)
          }
          name={preview.name}
          mime={preview.mime}
          onClose={() => setPreview(undefined)}
        />
      )}
    </>
  );
}
export function UploadButton({
  onUploaded,
  onBusy,
  folderId,
  agentId,
  sourceId: requestedSource,
  disabled,
  remaining,
  label = "Attach files",
  menu = false,
}: {
  onUploaded: (file: UploadedFile) => void;
  onBusy?: (busy: boolean) => void;
  folderId?: string | null;
  agentId?: string | null;
  sourceId?: string;
  disabled?: boolean;
  remaining?: number;
  label?: string;
  menu?: boolean;
}) {
  const scopedSource = useSourceId();
  const sourceId = requestedSource ?? scopedSource;
  const destination = JSON.stringify([sourceId, agentId ?? null, folderId ?? null]);
  // iOS already offers Photo Library, Camera and Files in its native picker.
  // It cannot bypass that menu for an image input, so skip our duplicate sheet.
  // iPadOS can identify as a Mac when requesting desktop websites.
  const sourceMenu =
    menu &&
    !(
      /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  const destinationRef = useRef(destination);
  destinationRef.current = destination;
  const mounted = useRef(true);
  const pending = useRef<{ controller: AbortController; finish: () => void } | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    setBusy(false);
    return () => {
      mounted.current = false;
      pending.current?.controller.abort();
      pending.current?.finish();
    };
  }, [destination]);
  const input = useRef<HTMLInputElement>(null),
    photos = useRef<HTMLInputElement>(null),
    camera = useRef<HTMLInputElement>(null),
    locked = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [open, setOpen] = useState(false);
  // An upload error wraps under the composer's controls, so it never stays
  // in the way: it can be dismissed and clears itself.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(""), ERROR_MS);
    return () => clearTimeout(timer);
  }, [error]);
  async function upload(element: HTMLInputElement) {
    const files = [...(element.files || [])];
    element.value = "";
    if (locked.current || !files.length) return;
    setOpen(false);
    if (remaining !== undefined && files.length > remaining) {
      setError(`Attach up to ${MAX_MESSAGE_FILES} files per message.`);
      return;
    }
    // Images are checked after they are prepared: most shrink well below
    // the limit.
    if (
      files.some((file) => !shouldPrepare(file) && file.size > MAX_UPLOAD_BYTES)
    ) {
      setError("Files can be up to 25 MB each.");
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = { controller, finish: () => {
      clearTimeout(timer);
      if (pending.current !== task) return;
      pending.current = null;
      locked.current = false;
      if (mounted.current) setBusy(false);
      onBusy?.(false);
    } };
    pending.current = task;
    locked.current = true;
    setBusy(true);
    onBusy?.(true);
    setError("");
    try {
      for (const original of files) {
        const file = await prepareImage(original);
        if (controller.signal.aborted) return;
        if (file.size > MAX_UPLOAD_BYTES)
          throw new Error("Files can be up to 25 MB each.");
        let result: RouteResponse<typeof workspaceApi.uploadCreate>;
        timer = setTimeout(() => controller.abort(new DOMException("Upload timed out", "TimeoutError")), UPLOAD_TIMEOUT_MS);
        try {
          result = await callRoute(workspaceApi.uploadCreate, {
            body: { folderId: folderId || undefined, agentId: agentId || undefined }, file,
          }, sourceId, controller.signal);
        } catch (error) {
          if ((error as Error).name === "TimeoutError")
            throw new Error(`Uploading ${file.name} timed out. Check the connection and try again.`);
          throw error;
        }
        clearTimeout(timer);
        if (mounted.current && pending.current === task && destinationRef.current === destination && !controller.signal.aborted) onUploaded(result);
      }
    } catch (error) {
      if (mounted.current && pending.current === task) setError((error as Error).message);
    } finally {
      task.finish();
    }
  }
  return (
    <div className="upload-control">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={label}
        disabled={busy || disabled}
        onChange={(event) => void upload(event.currentTarget)}
      />
      {sourceMenu && (
        <>
          <input
            ref={photos}
            type="file"
            accept="image/*"
            multiple
            hidden
            aria-label="Choose photos"
            disabled={busy || disabled}
            onChange={(event) => void upload(event.currentTarget)}
          />
          <input
            ref={camera}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            aria-label="Take a photo"
            disabled={busy || disabled}
            onChange={(event) => void upload(event.currentTarget)}
          />
        </>
      )}
      <button
        type="button"
        className={menu ? "attachment-trigger icon-button" : "text-button"}
        aria-label={
          menu ? (busy ? "Uploading files" : "Add attachments") : undefined
        }
        aria-haspopup={sourceMenu ? "dialog" : undefined}
        aria-expanded={sourceMenu ? open : undefined}
        disabled={busy || disabled || remaining === 0}
        onPointerDown={(event) => {
          // Keep the focused prompt (and keyboard layout) until the click is
          // delivered. Blurring on pointerdown can move this button away from
          // pointerup and swallow a mouse click on mobile WebKit. Touch taps
          // need their default pointer behavior to produce a click.
          if (event.pointerType === "mouse" && event.button === 0)
            event.preventDefault();
        }}
        onClick={() => (sourceMenu ? setOpen(true) : input.current?.click())}
      >
        {menu ? (
          <Plus size={22} />
        ) : (
          <>
            <Paperclip size={17} />
            {busy ? "Uploading…" : label}
          </>
        )}
      </button>
      {open && (
        <Sheet
          title="Add to message"
          className="attachment-menu-sheet"
          swipeToClose
          onClose={() => setOpen(false)}
        >
          <div className="attachment-options">
            <button type="button" onClick={() => camera.current?.click()}>
              <Camera size={28} />
              <span>Camera</span>
            </button>
            <button type="button" onClick={() => photos.current?.click()}>
              <Image size={28} />
              <span>Photos</span>
            </button>
            <button type="button" onClick={() => input.current?.click()}>
              <File size={28} />
              <span>Files</span>
            </button>
          </div>
        </Sheet>
      )}
      {error && (
        <p role="alert" className="error upload-error">
          <span>{error}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss upload error"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </p>
      )}
    </div>
  );
}
