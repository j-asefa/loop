// Talks to a Loop desktop workspace. No React Native imports: the root test
// suite exercises this module against a real host.

export type PairingCode = { origin: string; secret: string };
export type Pairing = { origin: string; token: string; deviceId: string };
export type Health = "connected" | "revoked" | "unreachable";

// Matches the `${origin}/#pair=${secret}` URL printed by `loop pair`.
export function parsePairingCode(data: string): PairingCode {
  let url: URL;
  try {
    url = new URL(data.trim());
  } catch {
    throw new Error("That isn't a Loop pairing code.");
  }
  const secret = new URLSearchParams(url.hash.slice(1)).get("pair") ?? "";
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== "/" ||
    !/^[A-Za-z0-9_-]{40,60}$/.test(secret)
  )
    throw new Error(
      "That isn't a Loop pairing code. Run loop pair on your computer and scan the code it shows.",
    );
  return { origin: url.origin, secret };
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function pair(
  code: PairingCode,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Pairing> {
  let response: Response;
  try {
    response = await request(
      code.origin + "/pair",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: code.secret,
          name,
          credential: "bearer",
        }),
      },
      15000,
      fetchImpl,
    );
  } catch {
    throw new Error(
      "Couldn't reach your computer. Check that Loop is running there, then run loop pair again.",
    );
  }
  const data = (await response.json().catch(() => ({}))) as {
    token?: string;
    device?: { id?: string };
    error?: string;
  };
  if (!response.ok || !data.token || !data.device?.id)
    throw new Error(
      data.error || "Pairing failed. Run loop pair and try again.",
    );
  return { origin: code.origin, token: data.token, deviceId: data.device.id };
}

export async function check(
  pairing: Pairing,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<Health> {
  try {
    const response = await request(
      pairing.origin + "/session",
      { headers: { Authorization: "Bearer " + pairing.token } },
      timeoutMs,
      fetchImpl,
    );
    if (response.status === 401) return "revoked";
    // A gateway fallback page or a redirect elsewhere is not this Loop session.
    if (
      !response.ok ||
      (response.url && !sameOrigin(response.url, pairing.origin))
    )
      return "unreachable";
    const session = (await response.json()) as { device?: { id?: string } };
    return session?.device?.id === pairing.deviceId
      ? "connected"
      : "unreachable";
  } catch {
    return "unreachable";
  }
}

// Loaded once with the bearer header; the host sets the web view's cookie, then
// loads the app.
export function openUrl(pairing: Pairing) {
  return pairing.origin + "/session/open";
}

export function sameOrigin(url: string, origin: string) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
