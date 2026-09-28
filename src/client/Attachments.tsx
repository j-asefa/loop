import { useEffect, useRef, useState } from "react";
import { Paperclip, File, X, Plus, Camera, Image } from "lucide-react";
import { Sheet } from "./components";
import { FilePreview } from "./FilePreview";
import { authorizedFetch, parse } from "./api";
import {
  MAX_MESSAGE_FILES,
  MAX_UPLOAD_BYTES,
  type UploadedFile,
} from "../shared/uploads";

export function useAttachments(key: string) {
  const [files, setFiles] = useState<UploadedFile[]>(() =>
    parse(sessionStorage.getItem(key) || "", []),
  );
  useEffect(() => {
    setFiles(parse(sessionStorage.getItem(key) || "", []));
  }, [key]);
  const change = (files: UploadedFile[]) => {
    setFiles(files);
    sessionStorage.setItem(key, JSON.stringify(files));
  };
  return [files, change] as const;
}
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export function AttachmentList({
  files,
  onRemove,
}: {
  files: UploadedFile[];
  onRemove?: (id: string) => void;
}) {
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
          url={`/api/objects/${preview.objectId}`}
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
  disabled,
  remaining,
  label = "Attach files",
  menu = false,
}: {
  onUploaded: (file: UploadedFile) => void;
  onBusy?: (busy: boolean) => void;
  folderId?: string | null;
  agentId?: string | null;
  disabled?: boolean;
  remaining?: number;
  label?: string;
  menu?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null),
    photos = useRef<HTMLInputElement>(null),
    camera = useRef<HTMLInputElement>(null),
    locked = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [open, setOpen] = useState(false);
  async function upload(element: HTMLInputElement) {
    const files = [...(element.files || [])];
    element.value = "";
    if (locked.current || !files.length) return;
    setOpen(false);
    if (remaining !== undefined && files.length > remaining) {
      setError(`Attach up to ${MAX_MESSAGE_FILES} files per message.`);
      return;
    }
    if (files.some((file) => file.size > MAX_UPLOAD_BYTES)) {
      setError("Files can be up to 25 MB each.");
      return;
    }
    locked.current = true;
    setBusy(true);
    onBusy?.(true);
    setError("");
    try {
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        if (folderId) form.append("folderId", folderId);
        if (agentId) form.append("agentId", agentId);
        const response = await authorizedFetch("/api/uploads", {
          method: "POST",
          body: form,
        });
        const result = await response
          .json()
          .catch(() => ({ error: "Upload failed. Try again." }));
        if (!response.ok)
          throw new Error(result.error || "Upload failed. Try again.");
        onUploaded(result);
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
      onBusy?.(false);
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
      {menu && (
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
        aria-haspopup={menu ? "dialog" : undefined}
        aria-expanded={menu ? open : undefined}
        disabled={busy || disabled || remaining === 0}
        onClick={() => (menu ? setOpen(true) : input.current?.click())}
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
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
