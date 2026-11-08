import { openModalDialog } from "./modalDialog";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function ProfilePhoto({
  src,
  label,
  onClose,
}: {
  src: string;
  label: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(
    () => openModalDialog(dialog.current!, () => close.current()),
    [],
  );
  return createPortal(
    <dialog
      ref={dialog}
      className="profile-photo-viewer"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        className="icon-button"
        aria-label="Close photo"
        onClick={onClose}
      >
        <X size={28} />
      </button>
      <img src={src} alt={label} />
    </dialog>,
    document.body,
  );
}
