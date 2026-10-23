export const LOGIN_START_MS = 45_000;
export const LOGIN_COMPLETE_MS = 10 * 60_000;

export class LoginTimeoutError extends Error {}

// Starting the CLI must be quick; allow the full browser/code window only once
// the user has a link. Never extend that window for repeated output events.
export function loginDeadline(onTimeout: (error: Error) => void) {
  let phase = "starting",
    timer: ReturnType<typeof setTimeout> | undefined,
    expiresAt!: number;
  const arm = (ms: number) => {
    expiresAt = Date.now() + ms;
    timer = setTimeout(() => {
      const message =
        phase === "starting"
          ? "The provider did not return a sign-in link within 45 seconds. Try sign-in again. If it keeps failing, update the runtime on the selected machine."
          : "Sign-in expired. Try sign-in again to get a new link.";
      phase = "expired";
      onTimeout(new LoginTimeoutError(message));
    }, ms);
  };
  arm(LOGIN_START_MS);
  return {
    get expiresAt() {
      return expiresAt;
    },
    ready() {
      if (phase !== "starting") return;
      phase = "waiting";
      clearTimeout(timer);
      arm(LOGIN_COMPLETE_MS);
    },
    clear() {
      phase = "closed";
      clearTimeout(timer);
    },
  };
}
