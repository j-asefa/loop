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
      const inset = Math.max(
        0,
        innerHeight - (v?.height || innerHeight) - (v?.offsetTop || 0),
      );
      document.documentElement.dataset.keyboard =
        inset > 100 && (v?.scale || 1) === 1 ? "open" : "closed";
      document.documentElement.style.setProperty(
        "--visual-viewport-height",
        (v?.height || innerHeight) + "px",
      );
      document.documentElement.style.setProperty(
        "--keyboard-inset",
        inset + "px",
      );
    };
    viewport();
    window.visualViewport?.addEventListener("resize", viewport);
    window.visualViewport?.addEventListener("scroll", viewport);
    window.addEventListener("resize", viewport);
    return () => {
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
      window.visualViewport?.removeEventListener("resize", viewport);
      window.visualViewport?.removeEventListener("scroll", viewport);
      window.removeEventListener("resize", viewport);
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
