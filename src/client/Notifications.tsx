import { useEffect, useState } from "react";
import { Bell, BellOff, Info, TriangleAlert } from "lucide-react";
import { callRoute, readRoute } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import { PushSubscription } from "../shared/team-contract-schemas";
import { executionSourceId } from "./sourceRouting";
import {
  defaultNotificationPreferences,
  type NotificationPreferences,
} from "../shared/notifications";
import { SettingsList, SettingsNote, SettingsToggle } from "./SettingsUI";

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
  const [categoriesSupported, setCategoriesSupported] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences>(
    defaultNotificationPreferences,
  );
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [permission, setPermission] = useState(
    supported ? Notification.permission : "default",
  );
  useEffect(() => {
    if (!supported) return;
    let current = true;
    const controller = new AbortController();
    void (async () => {
      const registration = await workerRegistration();
      const subscription = await registration.pushManager.getSubscription();
      const state = await readRoute(
        workspaceApi.notifications,
        {},
        executionSourceId(),
        controller.signal,
      );
      if (current) {
        setCategoriesSupported(state.devices !== undefined);
        const device = state.devices?.find(
          (d) => d.endpoint === subscription?.endpoint,
        );
        if (device) setPreferences(device.preferences);
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
      controller.abort();
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
          await callRoute(
            workspaceApi.notificationUnsubscribe,
            { body: { endpoint: subscription.endpoint } },
            executionSourceId(),
          );
          await subscription.unsubscribe();
        }
        setEnabled(false);
      } else {
        const { publicKey, devices } = await readRoute(
          workspaceApi.notifications,
          {},
          executionSourceId(),
          new AbortController().signal,
        );
        setCategoriesSupported(devices !== undefined);
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
        await callRoute(
          workspaceApi.notificationSubscribe,
          {
            body: {
              ...PushSubscription.parse(subscription.toJSON()),
              ...(devices === undefined ? {} : { preferences }),
            },
          },
          executionSourceId(),
        );
        setEnabled(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function updatePreference(
    key: keyof NotificationPreferences,
    value: boolean,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    const next = { ...preferences, [key]: value };
    try {
      const registration = await workerRegistration();
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription)
        throw new Error("Enable notifications on this device again.");
      await callRoute(
        workspaceApi.notificationSubscribe,
        {
          body: {
            ...PushSubscription.parse(subscription.toJSON()),
            preferences: next,
          },
        },
        executionSourceId(),
      );
      setPreferences(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="notification-settings">
      <p className="settings-intro">On this device.</p>
      {!supported ? (
        <>
          <SettingsNote icon={Info} title="Not available in this browser">
            On iPhone, add Loop to your Home Screen from the Share menu and open
            it there. Other devices need a browser that supports web
            notifications.
          </SettingsNote>
        </>
      ) : (
        <>
          <SettingsList>
            <SettingsToggle
              icon={enabled ? BellOff : Bell}
              title="Enable notifications"
              description={busy ? "Updating…" : "Even when Loop is closed"}
              checked={enabled}
              disabled={!ready || busy}
              onChange={() => void toggle()}
            />
          </SettingsList>
          {enabled && categoriesSupported && (
            <>
              <p className="settings-intro">
                Choose what notifies you. For action-only alerts, leave just
                Needs you on.
              </p>
              <SettingsList label="Notify me about">
                {(
                  [
                    [
                      "needsYou",
                      "Needs you",
                      "Approvals, questions, paused or failed work, and messages that could not be sent",
                    ],
                    [
                      "completed",
                      "Completed work",
                      "New results from your agents",
                    ],
                    ["reminders", "Reminders", "Items returning from Later"],
                    [
                      "social",
                      "Social watches",
                      "New stories matching words you follow",
                    ],
                  ] as const
                ).map(([key, title, description]) => (
                  <SettingsToggle
                    key={key}
                    title={title}
                    description={description}
                    checked={preferences[key]}
                    disabled={busy}
                    onChange={(value) => void updatePreference(key, value)}
                  />
                ))}
              </SettingsList>
            </>
          )}
          <p role="status" className="sr-only">
            {enabled
              ? "Notifications are on for this device."
              : "Notifications are off for this device."}
          </p>
          {permission === "denied" && (
            <SettingsNote
              icon={TriangleAlert}
              tone="attention"
              title="Blocked by this device"
            >
              Allow notifications for Loop in your device’s notification
              settings, then turn this on again.
            </SettingsNote>
          )}
        </>
      )}
      {error && (
        <SettingsNote
          icon={TriangleAlert}
          tone="attention"
          role="alert"
          title="Could not update notifications"
        >
          {error}
        </SettingsNote>
      )}
    </section>
  );
}
