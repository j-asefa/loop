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

export function normalizeWorkspaceUrl(rawInput: string): URL {
  const trimmed = rawInput.trim();
  if (!trimmed || trimmed.length > 4096) {
    throw new Error("Enter a Loop workspace URL or `loop pair` link.");
  }
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("That does not look like a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Workspace URLs must use http:// or https://.");
  }
  return url;
}

/**
 * Parses a `loop pair` link (`https://host/#pair=<secret>`, `?pair=<secret>`,
 * or `/#fleet=<base64url-json>`). Returns `null` if the URL is a valid bare
 * workspace URL without a pairing token.
 */
export function tryParsePairingLink(rawInput: string): {
  origin: string;
  pairing: ParsedPairingLink | null;
} {
  const url = normalizeWorkspaceUrl(rawInput);
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const hashParams = new URLSearchParams(hash);
  const queryParams = url.searchParams;

  const pairSecret = hashParams.get("pair") || queryParams.get("pair");
  if (pairSecret && /^[A-Za-z0-9_-]{32,128}$/.test(pairSecret)) {
    return {
      origin: url.origin,
      pairing: { origin: url.origin, secret: pairSecret },
    };
  }

  const fleetEncoded = hashParams.get("fleet") || queryParams.get("fleet");
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
      pairing: {
        origin: url.origin,
        secret: payload.device,
        ceremonyId: payload.ceremonyId,
      },
    };
  }

  return { origin: url.origin, pairing: null };
}

export function parsePairingLink(rawInput: string): ParsedPairingLink {
  const { pairing } = tryParsePairingLink(rawInput);
  if (!pairing) {
    throw new Error(
      "Missing `#pair=` token. Run `loop pair` on your machine and paste the full link or pairing code.",
    );
  }
  return pairing;
}

function extractSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const match = /(loop_device(?:_[a-f0-9]+)?=[^;,\s]+)/i.exec(setCookieHeader);
  return match ? match[1] : null;
}

/**
 * Checks whether a bare workspace URL is a reachable Loop server and whether
 * this device already holds an active session cookie for it.
 */
export async function probeWorkspaceUrl(rawUrl: string): Promise<{
  origin: string;
  session: PairedSession | null;
}> {
  const { origin } = tryParsePairingLink(rawUrl);
  const capRes = await fetch(`${origin}/api/capabilities`, {
    method: "GET",
    headers: { Accept: "application/json", Origin: origin },
  });
  if (!capRes.ok) {
    throw new Error(
      `Reached ${origin}, but it did not respond as a Loop workspace (HTTP ${capRes.status}).`,
    );
  }

  const sessionRes = await fetch(`${origin}/session`, {
    method: "GET",
    headers: { Accept: "application/json", Origin: origin },
    credentials: "include",
  });
  if (sessionRes.ok) {
    const data = (await sessionRes.json().catch(() => ({}))) as {
      csrf?: string;
      device?: { id?: string; name?: string };
    };
    if (data.csrf) {
      const session: PairedSession = {
        origin,
        cookie: "",
        csrf: data.csrf,
        deviceId: data.device?.id,
        deviceName: data.device?.name || "Loop iPhone",
        pairedAt: Date.now(),
      };
      await savePairedSession(session);
      return { origin, session };
    }
  }
  return { origin, session: null };
}

async function redeemPairing(
  parsed: ParsedPairingLink,
  deviceName = Platform.OS === "ios" ? "Loop iPhone" : "Loop Mobile",
): Promise<PairedSession> {
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

export async function pairWithCompanion(
  rawLink: string,
  deviceName?: string,
): Promise<PairedSession> {
  return redeemPairing(parsePairingLink(rawLink), deviceName);
}

export async function pairWithOriginAndToken(
  rawOrigin: string,
  rawToken: string,
  deviceName?: string,
): Promise<PairedSession> {
  const trimmedToken = rawToken.trim();
  // Allow user to paste a full link into the token field too
  if (trimmedToken.includes("#pair=") || trimmedToken.includes("#fleet=")) {
    return pairWithCompanion(trimmedToken, deviceName);
  }
  const url = normalizeWorkspaceUrl(rawOrigin);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(trimmedToken)) {
    throw new Error(
      "Paste the full `loop pair` URL or the pairing token after `#pair=`.",
    );
  }
  return redeemPairing(
    { origin: url.origin, secret: trimmedToken },
    deviceName,
  );
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
