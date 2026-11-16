import { useEffect, useState } from "react";
import { installViewport } from "./pwa-viewport";
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
    const stopViewport = installViewport();
    return () => {
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
      stopViewport();
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
