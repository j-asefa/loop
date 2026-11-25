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

export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // IPv6 literals contain ":" and have no dots — check them explicitly BEFORE the single-label check.
  if (host.includes(":")) {
    const bare =
      host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
    // IPv6 Unique Local Addresses (fc00::/7)
    return /^f[cd][0-9a-f]{2}:/i.test(bare);
  }
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
    return true;
  }
  // Single-label local LAN hostnames (e.g. "mybox")
  if (!host.includes(".") && /^[a-z0-9-]+$/.test(host)) {
    return true;
  }
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const rfc1918 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (rfc1918 && Number(rfc1918[1]) >= 16 && Number(rfc1918[1]) <= 31) {
    return true;
  }
  // Tailscale / CGNAT 100.64.0.0/10
  const cgnat = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (cgnat && Number(cgnat[1]) >= 64 && Number(cgnat[1]) <= 127) {
    return true;
  }
  return false;
}

export function assertSameOriginResponse(
  res: Pick<Response, "redirected" | "url">,
  expectedOrigin: string,
) {
  if (res.redirected) {
    throw new Error("Workspace server returned an unexpected redirect.");
  }
  if (res.url) {
    let actualOrigin: string;
    try {
      actualOrigin = new URL(res.url).origin;
    } catch {
      throw new Error("Workspace server returned an invalid response URL.");
    }
    if (actualOrigin !== expectedOrigin) {
      throw new Error("Workspace server redirected to a different origin.");
    }
  }
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
    throw new Error(
      "Workspace URLs must use https:// (or http:// on localhost/LAN).",
    );
  }
  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    throw new Error("Public Loop workspaces must use https://.");
  }
  return url;
}

/**
 * Parses a `loop pair` link (`https://host/#pair=<secret>` or
 * `/#fleet=<base64url-json>`). Pairing secrets are read strictly from the URL
 * fragment so they are never sent in query strings. Returns `pairing: null` if
 * the URL is a valid bare workspace URL without a pairing token.
 */
export function tryParsePairingLink(rawInput: string): {
  origin: string;
  pairing: ParsedPairingLink | null;
} {
  const url = normalizeWorkspaceUrl(rawInput);
  if (url.searchParams.has("pair") || url.searchParams.has("fleet")) {
    throw new Error(
      "Pairing secrets must be in the `#pair=` URL fragment, not the query string.",
    );
  }
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const hashParams = new URLSearchParams(hash);

  const pairSecret = hashParams.get("pair");
  if (pairSecret !== null) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(pairSecret)) {
      throw new Error(
        "Invalid `#pair=` token. Run `loop pair` on your machine for a fresh link.",
      );
    }
    return {
      origin: url.origin,
      pairing: { origin: url.origin, secret: pairSecret },
    };
  }

  const fleetEncoded = hashParams.get("fleet");
  if (fleetEncoded !== null) {
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(decodeBase64Url(fleetEncoded));
    } catch {
      throw new Error("This fleet pairing link could not be decoded.");
    }
    if (
      !rawPayload ||
      typeof rawPayload !== "object" ||
      Array.isArray(rawPayload)
    ) {
      throw new Error("This fleet pairing link payload is invalid.");
    }
    const payload = rawPayload as {
      kind?: unknown;
      origin?: unknown;
      device?: unknown;
      ceremonyId?: unknown;
    };
    if (
      payload.kind !== "combined" ||
      typeof payload.device !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(payload.device)
    ) {
      throw new Error(
        "This link enrolls a machine, not a phone. Run `loop pair` for a phone link.",
      );
    }
    if (typeof payload.origin === "string" && payload.origin !== url.origin) {
      throw new Error("The pairing link origin does not match its payload.");
    }
    return {
      origin: url.origin,
      pairing: {
        origin: url.origin,
        secret: payload.device,
        ceremonyId:
          typeof payload.ceremonyId === "string"
            ? payload.ceremonyId
            : undefined,
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

export function extractSessionCookie(
  setCookieHeader: string | null,
): string | null {
  if (!setCookieHeader) return null;
  const match =
    /((?:(?:__Host-loop|loop_local|loop_device)(?:_[a-f0-9]+)?)=[^;,\s]+)/i.exec(
      setCookieHeader,
    );
  return match ? match[1] : null;
}
