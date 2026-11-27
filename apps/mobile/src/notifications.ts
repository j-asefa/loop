import { Platform } from "react-native";
import { File as ExpoFile, Paths } from "expo-file-system";
import * as Notifications from "expo-notifications";
import { draftWorkspaceBucket } from "./drafts-codec";
import {
  DEFAULT_NOTIFICATION_PREFS,
  parseNotificationPrefs,
  serializeNotificationPrefs,
  type NotificationEvent,
  type NotificationPrefs,
} from "./notifications-prefs";

export {
  buildNotificationSnapshot,
  DEFAULT_NOTIFICATION_PREFS,
  detectNotificationEvents,
  parseNotificationTapTarget,
  type NotificationEvent,
  type NotificationPrefs,
  type NotificationSnapshot,
  type NotificationTapTarget,
} from "./notifications-prefs";

export type NotificationPermissionState =
  "granted" | "denied" | "undetermined" | "unavailable";

const ANDROID_CHANNEL_ID = "loop-updates";

let handlerConfigured = false;
let channelConfigured = false;

const prefsMemory = new Map<string, NotificationPrefs>();
const prefsEpoch = new Map<string, number>();

function prefsFileForBucket(bucket: string): ExpoFile {
  return new ExpoFile(Paths.cache, `loop-notif-prefs-${bucket}.json`);
}

export function configureNotificationsHandler(): void {
  if (handlerConfigured) return;
  handlerConfigured = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  } catch {
    // Graceful no-op when running on platforms without native notifications.
  }
}

export async function ensureNotificationChannel(): Promise<void> {
  if (channelConfigured || Platform.OS !== "android") return;
  channelConfigured = true;
  try {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: "Loop updates",
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 180, 120, 180],
    });
  } catch {
    channelConfigured = false;
  }
}

function mapPermissionStatus(
  settings: Notifications.NotificationPermissionsStatus,
): NotificationPermissionState {
  if (
    settings.granted ||
    settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
  ) {
    return "granted";
  }
  if (settings.canAskAgain === false || settings.status === "denied") {
    return "denied";
  }
  return "undetermined";
}

export async function getNotificationPermissionStatus(): Promise<NotificationPermissionState> {
  try {
    const settings = await Notifications.getPermissionsAsync();
    return mapPermissionStatus(settings);
  } catch {
    return "unavailable";
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  try {
    await ensureNotificationChannel();
    const settings = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
    return mapPermissionStatus(settings);
  } catch {
    return "unavailable";
  }
}

export async function loadNotificationPrefs(
  origin: string | null | undefined,
): Promise<NotificationPrefs> {
  const bucket = draftWorkspaceBucket(origin);
  const cached = prefsMemory.get(bucket);
  if (cached) return { ...cached };
  const epochAtStart = prefsEpoch.get(bucket) ?? 0;
  try {
    const file = prefsFileForBucket(bucket);
    if (file.exists) {
      const raw = await file.text();
      if ((prefsEpoch.get(bucket) ?? 0) !== epochAtStart) {
        return { ...(prefsMemory.get(bucket) ?? DEFAULT_NOTIFICATION_PREFS) };
      }
      const parsed = parseNotificationPrefs(raw);
      prefsMemory.set(bucket, parsed);
      return { ...parsed };
    }
  } catch {
    // Fall back to defaults on unreadable cache file.
  }
  if ((prefsEpoch.get(bucket) ?? 0) === epochAtStart) {
    prefsMemory.set(bucket, { ...DEFAULT_NOTIFICATION_PREFS });
  }
  return { ...DEFAULT_NOTIFICATION_PREFS };
}

export function saveNotificationPrefs(
  origin: string | null | undefined,
  prefs: NotificationPrefs,
): void {
  const bucket = draftWorkspaceBucket(origin);
  const next: NotificationPrefs = {
    enabled: Boolean(prefs.enabled),
    needsYou: Boolean(prefs.needsYou),
    completed: Boolean(prefs.completed),
    replies: Boolean(prefs.replies),
  };
  prefsEpoch.set(bucket, (prefsEpoch.get(bucket) ?? 0) + 1);
  prefsMemory.set(bucket, next);
  try {
    const file = prefsFileForBucket(bucket);
    file.write(serializeNotificationPrefs(next));
  } catch {
    // Best-effort local preference persistence.
  }
}

export function clearWorkspaceNotificationPrefs(
  origin: string | null | undefined,
): void {
  const bucket = draftWorkspaceBucket(origin);
  prefsEpoch.set(bucket, (prefsEpoch.get(bucket) ?? 0) + 1);
  prefsMemory.delete(bucket);
  try {
    const file = prefsFileForBucket(bucket);
    if (file.exists) file.delete();
  } catch {
    // ignore
  }
}

export async function deliverLocalNotifications(
  origin: string | null | undefined,
  events: NotificationEvent[],
  shouldContinue?: () => boolean,
): Promise<void> {
  if (!origin || events.length === 0) return;
  if (shouldContinue && !shouldContinue()) return;
  const permission = await getNotificationPermissionStatus();
  if (permission !== "granted") return;
  if (shouldContinue && !shouldContinue()) return;
  await ensureNotificationChannel();
  if (shouldContinue && !shouldContinue()) return;
  const originBucket = draftWorkspaceBucket(origin);
  for (const ev of events) {
    if (shouldContinue && !shouldContinue()) return;
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: ev.title,
          body: ev.body,
          sound: "default",
          data: {
            conversationId: ev.conversationId,
            title: ev.title,
            agentName: ev.agentName,
            originBucket,
            kind: ev.kind,
          },
        },
        trigger: null,
      });
    } catch {
      // Never crash app state updates if local scheduling fails.
    }
  }
}

export function subscribeNotificationTaps(
  onTap: (data: unknown) => void,
): () => void {
  let sub: { remove: () => void } | null = null;
  try {
    const initial = Notifications.getLastNotificationResponse();
    if (initial?.notification?.request?.content?.data) {
      onTap(initial.notification.request.content.data);
      try {
        Notifications.clearLastNotificationResponse();
      } catch {
        // ignore
      }
    }
    sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response?.notification?.request?.content?.data;
      if (data) onTap(data);
    });
  } catch {
    // Graceful fallback if notifications module is unavailable.
  }
  return () => {
    try {
      sub?.remove();
    } catch {
      // ignore
    }
  };
}
