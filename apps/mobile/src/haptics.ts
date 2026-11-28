import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

const supported = Platform.OS === "ios" || Platform.OS === "android";

let hapticsEnabled = true;

export function setHapticsEnabled(enabled: boolean): void {
  hapticsEnabled = Boolean(enabled);
}

export function isHapticsEnabled(): boolean {
  return hapticsEnabled;
}

/**
 * Tactile haptic vocabulary for Loop's native gestures.
 * Safely no-ops on unsupported runtimes or when disabled in Settings so
 * simulators and web never throw.
 */
export const haptics = {
  /** Subtle detent tick when a carousel card locks to center or tab switches. */
  selection() {
    if (!supported || !hapticsEnabled) return;
    void Haptics.selectionAsync().catch(() => {});
  },
  /** Light threshold tick when crossing a swipe/dismiss detent or tapping pills. */
  light() {
    if (!supported || !hapticsEnabled) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  },
  /** Crisp physical lift when opening a card stack into the Spotlight Stage. */
  medium() {
    if (!supported || !hapticsEnabled) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
      () => {},
    );
  },
  /** Confirming double-pulse when completing, dismissing, or receiving a card. */
  success() {
    if (!supported || !hapticsEnabled) return;
    void Haptics.notificationAsync(
      Haptics.NotificationFeedbackType.Success,
    ).catch(() => {});
  },
  /** Gentle warning pulse for destructive/empty feedback. */
  warning() {
    if (!supported || !hapticsEnabled) return;
    void Haptics.notificationAsync(
      Haptics.NotificationFeedbackType.Warning,
    ).catch(() => {});
  },
};
