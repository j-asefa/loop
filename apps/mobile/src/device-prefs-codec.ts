export type ThemeMode = "system" | "light" | "dark";

export type DevicePrefs = {
  themeMode: ThemeMode;
  hapticsEnabled: boolean;
};

export const DEFAULT_DEVICE_PREFS: DevicePrefs = {
  themeMode: "light",
  hapticsEnabled: true,
};

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function parseDevicePrefs(raw: string): DevicePrefs {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_DEVICE_PREFS };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      themeMode: isThemeMode(obj.themeMode)
        ? obj.themeMode
        : DEFAULT_DEVICE_PREFS.themeMode,
      hapticsEnabled:
        typeof obj.hapticsEnabled === "boolean"
          ? obj.hapticsEnabled
          : DEFAULT_DEVICE_PREFS.hapticsEnabled,
    };
  } catch {
    return { ...DEFAULT_DEVICE_PREFS };
  }
}

export function serializeDevicePrefs(prefs: DevicePrefs): string {
  return JSON.stringify({
    themeMode: isThemeMode(prefs.themeMode)
      ? prefs.themeMode
      : DEFAULT_DEVICE_PREFS.themeMode,
    hapticsEnabled: Boolean(prefs.hapticsEnabled),
  });
}

export function resolveThemeDark(
  mode: ThemeMode,
  systemScheme: "light" | "dark" | null | undefined,
): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return systemScheme === "dark";
}
