import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import {
  assertSameOriginResponse,
  extractSessionCookie,
  normalizeWorkspaceUrl,
  parsePairingLink,
  preserveProbedCredentials,
  tryParsePairingLink,
  type ParsedPairingLink,
} from "./pairing-url";
import type { PairedSession } from "./types";

export {
  assertSameOriginResponse,
  extractSessionCookie,
  normalizeWorkspaceUrl,
  parsePairingLink,
  tryParsePairingLink,
  type ParsedPairingLink,
};

const SESSION_KEY = "loop.paired.session.v1";

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
    redirect: "error",
  });
  assertSameOriginResponse(capRes, origin);
  if (!capRes.ok) {
    throw new Error(
      `Reached ${origin}, but it did not respond as a Loop workspace (HTTP ${capRes.status}).`,
    );
  }

  const sessionRes = await fetch(`${origin}/session`, {
    method: "GET",
    headers: { Accept: "application/json", Origin: origin },
    credentials: "include",
    redirect: "error",
  });
  assertSameOriginResponse(sessionRes, origin);
  if (sessionRes.ok) {
    const data = (await sessionRes.json().catch(() => ({}))) as {
      csrf?: string;
      device?: { id?: string; name?: string };
    };
    if (data.csrf) {
      const cookie =
        extractSessionCookie(sessionRes.headers.get("set-cookie")) ?? "";
      const session = preserveProbedCredentials(await loadPairedSession(), {
        origin,
        cookie,
        csrf: data.csrf,
        deviceId: data.device?.id,
        deviceName: data.device?.name || "Loop iPhone",
        pairedAt: Date.now(),
      });
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
    redirect: "error",
    body: JSON.stringify({
      secret: parsed.secret,
      name: deviceName,
      ...(parsed.ceremonyId ? { ceremonyId: parsed.ceremonyId } : {}),
    }),
  });
  assertSameOriginResponse(pairRes, parsed.origin);

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
    redirect: "error",
  });
  assertSameOriginResponse(sessionRes, parsed.origin);
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
  const expectedUrl = normalizeWorkspaceUrl(rawOrigin);
  const trimmedToken = rawToken.trim();
  // Allow user to paste a full link into the token field too, but require it to match the verified origin.
  if (trimmedToken.includes("#pair=") || trimmedToken.includes("#fleet=")) {
    const parsed = parsePairingLink(trimmedToken);
    if (parsed.origin !== expectedUrl.origin) {
      throw new Error(
        `That pairing link is for ${parsed.origin}, not ${expectedUrl.origin}.`,
      );
    }
    return redeemPairing(parsed, deviceName);
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(trimmedToken)) {
    throw new Error(
      "Paste the full `loop pair` URL or the pairing token after `#pair=`.",
    );
  }
  return redeemPairing(
    { origin: expectedUrl.origin, secret: trimmedToken },
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
      ...(typeof parsed.localDataScope === "string"
        ? { localDataScope: parsed.localDataScope }
        : {}),
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
