import { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { api } from "./api";

async function workerRegistration() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Loop’s notification service isn’t ready. Reload the app and try again.",
              ),
            ),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function Notifications() {
  const supported =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [permission, setPermission] = useState(
    supported ? Notification.permission : "default",
  );
  useEffect(() => {
    if (!supported) return;
    let current = true;
    void (async () => {
      const registration = await workerRegistration();
      const subscription = await registration.pushManager.getSubscription();
      const state = await api<{ endpoints: string[] }>("/notifications");
      if (current) {
        setEnabled(
          !!subscription && state.endpoints.includes(subscription.endpoint),
        );
        setReady(true);
      }
    })().catch((e) => {
      if (current) {
        setError(e.message);
        setReady(true);
      }
    });
    return () => {
      current = false;
    };
  }, [supported]);
  async function toggle() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      // Safari requires the permission request to start in this tap handler,
      // before any network or service-worker await consumes user activation.
      const granted = enabled
        ? Notification.permission
        : await Notification.requestPermission();
      setPermission(granted);
      if (!enabled && granted !== "granted") return;
      const registration = await workerRegistration();
      if (!enabled && registration.waiting) {
        const waiting = registration.waiting;
        // The newly installed worker contains the push handler; don't leave
        // it waiting behind an older open tab after enabling notifications.
        waiting.postMessage({ type: "ACTIVATE" });
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            if (
              waiting.state === "activated" ||
              waiting.state === "redundant"
            ) {
              clearTimeout(timer);
              waiting.removeEventListener("statechange", done);
              waiting.state === "activated"
                ? resolve()
                : reject(
                    new Error("Reload Loop to finish enabling notifications."),
                  );
            }
          };
          const timer = setTimeout(() => {
            waiting.removeEventListener("statechange", done);
            reject(new Error("Reload Loop to finish enabling notifications."));
          }, 10000);
          waiting.addEventListener("statechange", done);
          done();
        });
      }
      let subscription = await registration.pushManager.getSubscription();
      if (enabled) {
        if (subscription) {
          await api(
            "/notifications/subscriptions",
            { endpoint: subscription.endpoint },
            "DELETE",
          );
          await subscription.unsubscribe();
        }
        setEnabled(false);
      } else {
        const { publicKey } = await api<{ publicKey: string }>(
          "/notifications",
        );
        const key = Uint8Array.from(
          atob(publicKey.replaceAll("-", "+").replaceAll("_", "/")),
          (c) => c.charCodeAt(0),
        );
        const previousKey = subscription?.options.applicationServerKey;
        if (
          subscription &&
          previousKey &&
          !new Uint8Array(previousKey).every((v, i) => v === key[i])
        ) {
          await subscription.unsubscribe();
          subscription = null;
        }
        subscription ||= await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
        await api("/notifications/subscriptions", subscription.toJSON());
        setEnabled(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="notification-settings">
      <p>
        Get a notification on this device when an agent creates a new result,
        even when Loop is closed.
      </p>
      {!supported ? (
        <p className="note">
          On iPhone, add Loop to your Home Screen from the Share menu, open it
          there, then enable notifications. Other devices need a browser that
          supports web notifications.
        </p>
      ) : (
        <>
          <p role="status">
            {enabled
              ? "Result notifications are on for this device."
              : "Result notifications are off for this device."}
          </p>
          {permission === "denied" && (
            <p className="note">
              Notifications are blocked. Allow them in your device’s
              notification settings, then try again.
            </p>
          )}
          <button
            className="primary"
            disabled={!ready || busy}
            onClick={() => void toggle()}
          >
            {enabled ? <BellOff size={18} /> : <Bell size={18} />}
            {busy
              ? "Updating…"
              : enabled
                ? "Turn off notifications"
                : "Enable notifications"}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
