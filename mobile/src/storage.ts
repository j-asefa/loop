import * as SecureStore from "expo-secure-store";
import type { Pairing } from "./connection";

const KEY = "loop.pairing";
// Kept on this device only: never restored to another phone from a backup.
const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export async function loadPairing(): Promise<Pairing | null> {
  const raw = await SecureStore.getItemAsync(KEY, options);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Pairing;
    return value.origin && value.token && value.deviceId ? value : null;
  } catch {
    return null;
  }
}

export function savePairing(pairing: Pairing) {
  return SecureStore.setItemAsync(KEY, JSON.stringify(pairing), options);
}

export function clearPairing() {
  return SecureStore.deleteItemAsync(KEY, options);
}
