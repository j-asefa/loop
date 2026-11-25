import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { PairedSession } from "./types";

const SESSION_KEY = "loop.paired.session.v1";

export type ParsedPairingLink = {
  origin: string;
  secret: string;
  ceremonyId?: string;
};

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  if (typeof atob === "function") {
    return atob(padded);
  }
  throw new Error("Base64 decoding is unavailable on this runtime.");
}

/**
 * Parses a standard `loop pair` link (`https://host/#pair=<secret>`) or a
 * combined fleet pairing link (`https://host/#fleet=<base64url-json>`).
 */
export function parsePairingLink(rawInput: string): ParsedPairingLink {
  const trimmed = rawInput.trim();
  if (!trimmed || trimmed.length > 4096) {
    throw new Error("Paste or scan a complete pairing link from `loop pair`.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("That does not look like a valid Loop pairing URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Pairing links must use http:// or https://.");
  }
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const params = new URLSearchParams(hash);

  const pairSecret = params.get("pair");
  if (pairSecret && /^[A-Za-z0-9_-]{32,128}$/.test(pairSecret)) {
    return { origin: url.origin, secret: pairSecret };
  }

  const fleetEncoded = params.get("fleet");
  if (fleetEncoded) {
    let payload: {
      kind?: string;
      origin?: string;
      device?: string;
      ceremonyId?: string;
    };
    try {
      payload = JSON.parse(decodeBase64Url(fleetEncoded));
    } catch {
      throw new Error("This fleet pairing link could not be decoded.");
    }
    if (payload.kind !== "combined" || !payload.device) {
      throw new Error(
        "This link enrolls a machine, not a phone. Run `loop pair` for a phone link.",
      );
    }
    if (payload.origin && payload.origin !== url.origin) {
      throw new Error("The pairing link origin does not match its payload.");
    }
    return {
      origin: url.origin,
      secret: payload.device,
      ceremonyId: payload.ceremonyId,
    };
  }

  throw new Error(
    "Missing `#pair=` token. Run `loop pair` on your machine and scan or paste the full link.",
  );
}

function extractSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  // Match `loop_device=...` or preview `loop_device_<hash>=...`
  const match = /(loop_device(?:_[a-f0-9]+)?=[^;,\s]+)/i.exec(setCookieHeader);
  return match ? match[1] : null;
}

/**
 * Exchanges a single-use `loop pair` link for a durable HttpOnly session cookie
 * + CSRF token, persisted directly into iOS Keychain / Android Keystore.
 */
export async function pairWithCompanion(
  rawLink: string,
  deviceName = Platform.OS === "ios" ? "Loop iPhone" : "Loop Mobile",
): Promise<PairedSession> {
  const parsed = parsePairingLink(rawLink);
  const pairRes = await fetch(`${parsed.origin}/pair`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: parsed.origin,
    },
    body: JSON.stringify({
      secret: parsed.secret,
      name: deviceName,
      ...(parsed.ceremonyId ? { ceremonyId: parsed.ceremonyId } : {}),
    }),
  });

  const pairJson = (await pairRes.json().catch(() => ({}))) as {
    paired?: boolean;
    error?: string;
  };
  if (!pairRes.ok || !pairJson.paired) {
    throw new Error(
      pairJson.error ||
        `Pairing failed (HTTP ${pairRes.status}). Run \`loop pair\` for a fresh link.`,
    );
  }

  const setCookie = pairRes.headers.get("set-cookie");
  const cookie = extractSessionCookie(setCookie) ?? "";

  // Fetch CSRF token and device metadata using the new session cookie
  // (also works via native NSURLSession cookie jar if Set-Cookie was stripped).
  const sessionHeaders: Record<string, string> = {
    Origin: parsed.origin,
    Accept: "application/json",
  };
  if (cookie) sessionHeaders.Cookie = cookie;

  const sessionRes = await fetch(`${parsed.origin}/session`, {
    method: "GET",
    headers: sessionHeaders,
    credentials: "include",
  });
  const sessionJson = (await sessionRes.json().catch(() => ({}))) as {
    csrf?: string;
    device?: { id?: string; name?: string };
    error?: string;
  };
  if (!sessionRes.ok || !sessionJson.csrf) {
    throw new Error(
      sessionJson.error ||
        "Paired, but could not establish session credentials.",
    );
  }

  const session: PairedSession = {
    origin: parsed.origin,
    cookie,
    csrf: sessionJson.csrf,
    deviceId: sessionJson.device?.id,
    deviceName: sessionJson.device?.name || deviceName,
    pairedAt: Date.now(),
  };
  await savePairedSession(session);
  return session;
}

export async function loadPairedSession(): Promise<PairedSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PairedSession>;
    if (!parsed.origin || !parsed.csrf) return null;
    return {
      origin: parsed.origin,
      cookie: parsed.cookie ?? "",
      csrf: parsed.csrf,
      deviceId: parsed.deviceId,
      deviceName: parsed.deviceName || "Loop iPhone",
      pairedAt: parsed.pairedAt || Date.now(),
    };
  } catch {
    return null;
  }
}

export async function savePairedSession(session: PairedSession): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

export async function clearPairedSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SESSION_KEY);
  } catch {
    // Ignore cleanup errors
  }
}
