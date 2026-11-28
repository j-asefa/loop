import { File as ExpoFile, Paths } from "expo-file-system";
import {
  DEFAULT_DEVICE_PREFS,
  parseDevicePrefs,
  serializeDevicePrefs,
  type DevicePrefs,
} from "./device-prefs-codec";

export {
  DEFAULT_DEVICE_PREFS,
  parseDevicePrefs,
  resolveThemeDark,
  serializeDevicePrefs,
  type DevicePrefs,
  type ThemeMode,
} from "./device-prefs-codec";

let memoryPrefs: DevicePrefs | null = null;
let prefsEpoch = 0;

function devicePrefsFile(): ExpoFile {
  return new ExpoFile(Paths.document, "loop-device-prefs.json");
}

export async function loadDevicePrefs(): Promise<DevicePrefs> {
  if (memoryPrefs) return { ...memoryPrefs };
  const epochAtStart = prefsEpoch;
  try {
    const file = devicePrefsFile();
    if (file.exists) {
      const raw = await file.text();
      if (prefsEpoch !== epochAtStart) {
        return { ...(memoryPrefs ?? DEFAULT_DEVICE_PREFS) };
      }
      const parsed = parseDevicePrefs(raw);
      memoryPrefs = parsed;
      return { ...parsed };
    }
  } catch {
    // Fall back to defaults on unreadable preference file.
  }
  if (prefsEpoch === epochAtStart) {
    memoryPrefs = { ...DEFAULT_DEVICE_PREFS };
  }
  return { ...DEFAULT_DEVICE_PREFS };
}

export function saveDevicePrefs(prefs: DevicePrefs): void {
  const next: DevicePrefs = {
    themeMode:
      prefs.themeMode === "system" ||
      prefs.themeMode === "light" ||
      prefs.themeMode === "dark"
        ? prefs.themeMode
        : DEFAULT_DEVICE_PREFS.themeMode,
    hapticsEnabled: Boolean(prefs.hapticsEnabled),
  };
  prefsEpoch += 1;
  memoryPrefs = next;
  try {
    const file = devicePrefsFile();
    file.writeSync(serializeDevicePrefs(next));
  } catch {
    // Best-effort device preference persistence.
  }
}
