import { useEffect, useState } from "react";
export function PwaStatus() {
  const [online, setOnline] = useState(navigator.onLine),
    [update, setUpdate] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    // Catch a network transition between the initial render and subscription.
    changed();
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          if (reg.waiting) setUpdate(reg.waiting);
          reg.addEventListener("updatefound", () => {
            const worker = reg.installing;
            worker?.addEventListener("statechange", () => {
              if (
                worker.state === "installed" &&
                navigator.serviceWorker.controller
              )
                setUpdate(worker);
            });
          });
        })
        .catch(() => {});
    const viewport = () => {
      const v = window.visualViewport;
      const obscuredHeight = innerHeight - (v?.height || innerHeight);
      const inset = Math.max(0, obscuredHeight - (v?.offsetTop || 0));
      const active = document.activeElement;
      const textEntryFocused =
        ((active instanceof HTMLTextAreaElement ||
          (active instanceof HTMLInputElement &&
            [
              "text",
              "search",
              "email",
              "url",
              "tel",
              "password",
              "number",
            ].includes(active.type))) &&
          !active.readOnly &&
          !active.disabled) ||
        (active instanceof HTMLElement && active.isContentEditable);
      // Safari can retain the keyboard's viewport size after blur without a
      // resize event. Don't leave the dock raised when no text field is focused.
      // Panning to the focused field changes offsetTop, not the keyboard's
      // height. Using the bottom inset here expands the sheet off-screen as
      // Safari pans, hiding the original message and agent header.
      const keyboardOpen =
        textEntryFocused && obscuredHeight > 100 && (v?.scale || 1) === 1;
      document.documentElement.dataset.keyboard = keyboardOpen
        ? "open"
        : "closed";
      document.documentElement.style.setProperty(
        "--visual-viewport-height",
        (keyboardOpen ? v!.height : innerHeight) + "px",
      );
      document.documentElement.style.setProperty(
        "--keyboard-inset",
        (keyboardOpen ? inset : 0) + "px",
      );
    };
    let viewportFrame = 0;
    const scheduleViewport = () => {
      cancelAnimationFrame(viewportFrame);
      // Let focus settle first, including showModal() and dialog restoration.
      viewportFrame = requestAnimationFrame(viewport);
    };
    viewport();
    window.visualViewport?.addEventListener("resize", scheduleViewport);
    window.visualViewport?.addEventListener("scroll", scheduleViewport);
    window.addEventListener("resize", scheduleViewport);
    window.addEventListener("pageshow", scheduleViewport);
    document.addEventListener("focusin", scheduleViewport);
    document.addEventListener("focusout", scheduleViewport);
    return () => {
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
      cancelAnimationFrame(viewportFrame);
      window.visualViewport?.removeEventListener("resize", scheduleViewport);
      window.visualViewport?.removeEventListener("scroll", scheduleViewport);
      window.removeEventListener("resize", scheduleViewport);
      window.removeEventListener("pageshow", scheduleViewport);
      document.removeEventListener("focusin", scheduleViewport);
      document.removeEventListener("focusout", scheduleViewport);
    };
  }, []);
  if (online && !update) return null;
  return (
    <div className="pwa-status" role="status">
      {!online
        ? "You’re offline. This screen and drafts stay here; reconnect to send new work."
        : "An update is ready."}
      {online && update && (
        <button
          onClick={() => {
            navigator.serviceWorker.addEventListener(
              "controllerchange",
              () => location.reload(),
              { once: true },
            );
            update.postMessage({ type: "ACTIVATE" });
          }}
        >
          Reload to update
        </button>
      )}
    </div>
  );
}
