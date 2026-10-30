import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { topSheet } from "./components";

/**
 * A brief confirmation with an optional link to what was created and an
 * optional Undo. Undo is only offered while it can still truly reverse the
 * action. For a deferred action, `onExpire` commits it when the toast ends,
 * is replaced, or the page is hidden; Undo then simply never commits it.
 */
export type Toast = {
  text: string;
  tone?: "error";
  link?: { label: string; onSelect: () => void };
  undo?: () => Promise<void> | void;
  onExpire?: () => void;
};
type Shown = Toast & { id: string };

const EVENT = "loop55-toast";
export function notify(toast: Toast) {
  window.dispatchEvent(
    new CustomEvent<Shown>(EVENT, {
      detail: { ...toast, id: crypto.randomUUID() },
    }),
  );
}

// An open modal sheet makes the rest of the page inert, so the toast is
// rendered inside the topmost open sheet, where it can be read and used.
const host = () => topSheet() || document.body;

export function Toasts() {
  const [toast, setToast] = useState<Shown | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const current = useRef<Shown | null>(null);
  const expire = (next: Shown | null) => {
    const previous = current.current;
    current.current = next;
    previous?.onExpire?.();
    setToast(next);
  };
  useEffect(() => {
    const show = (event: Event) => expire((event as CustomEvent<Shown>).detail);
    const hidden = () => {
      // A deferred action must not be lost when the app is closed. Once it
      // is committed, Undo could no longer reverse it, so it is withdrawn
      // from the toast as well.
      const shown = current.current;
      if (document.visibilityState !== "hidden" || !shown?.onExpire) return;
      shown.onExpire();
      current.current = { ...shown, onExpire: undefined, undo: undefined };
      setToast(current.current);
    };
    window.addEventListener(EVENT, show);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", hidden);
    return () => {
      window.removeEventListener(EVENT, show);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", hidden);
      current.current?.onExpire?.();
    };
  }, []);
  // Follow sheets opening and closing while a toast is shown.
  useEffect(() => {
    if (!toast) return;
    setTarget(host());
    const observer = new MutationObserver(() => setTarget(host()));
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, [toast?.id]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(
      () => current.current?.id === toast.id && expire(null),
      toast.undo ? 8000 : 5000,
    );
    return () => clearTimeout(timer);
  }, [toast?.id]);
  if (!toast || !target) return null;
  return createPortal(
    <div
      className={
        "toast action-toast" + (toast.tone === "error" ? " error" : "")
      }
      role={toast.tone === "error" ? "alert" : "status"}
    >
      <span className="toast-text">{toast.text}</span>
      <span className="toast-actions">
        {toast.link && (
          <button
            type="button"
            onClick={() => {
              const link = toast.link!;
              expire(null);
              link.onSelect();
            }}
          >
            {toast.link.label}
          </button>
        )}
        {toast.undo && (
          <button
            type="button"
            onClick={async () => {
              // The live toast decides: Undo may have been withdrawn since
              // this render (its deferred action was committed).
              const live = current.current;
              if (live?.id !== toast.id || !live.undo) return;
              const undo = live.undo;
              // Undo cancels a deferred action instead of committing it.
              current.current = null;
              setToast(null);
              try {
                await undo();
                notify({ text: "Undone." });
              } catch (e) {
                notify({ text: (e as Error).message, tone: "error" });
              }
            }}
          >
            Undo
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="Dismiss"
          onClick={() => expire(null)}
        >
          <X size={16} />
        </button>
      </span>
    </div>,
    target,
  );
}
