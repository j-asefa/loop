import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";

// Relocking only after a short absence lets people glance at another app.
const GRACE_MS = 30000;

const cancelled = new Set(["user_cancel", "system_cancel", "app_cancel"]);

// Face ID, Touch ID or the device passcode must be confirmed on launch and
// after the app has been in the background, before the paired workspace shows.
export function useDeviceLock() {
  const [locked, setLocked] = useState(true);
  const [error, setError] = useState<string>();
  const authenticating = useRef(false);
  const hiddenAt = useRef<number | null>(null);

  const unlock = useCallback(async () => {
    if (authenticating.current) return;
    authenticating.current = true;
    setError(undefined);
    try {
      // A phone without a passcode or biometrics has no owner to confirm.
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      if (level === LocalAuthentication.SecurityLevel.NONE)
        return setLocked(false);
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock Loop",
        cancelLabel: "Cancel",
      });
      if (result.success) setLocked(false);
      else if (result.error === "lockout")
        setError("Too many attempts. Unlock your phone, then try again.");
      else if (!cancelled.has(result.error))
        setError("Couldn't confirm it's you. Try again.");
    } catch {
      setError("Couldn't confirm it's you. Try again.");
    } finally {
      authenticating.current = false;
    }
  }, []);

  // Pairing a new code already proves access to the computer.
  const release = useCallback(() => setLocked(false), []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      // The system prompt (and Android's passcode screen) moves the app out
      // of the foreground while it is shown.
      if (authenticating.current) return;
      if (state === "background") hiddenAt.current = Date.now();
      else if (state === "active" && hiddenAt.current !== null) {
        if (Date.now() - hiddenAt.current > GRACE_MS) setLocked(true);
        hiddenAt.current = null;
      }
    });
    return () => subscription.remove();
  }, []);

  return { locked, error, unlock, release };
}
