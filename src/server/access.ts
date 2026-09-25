import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import ipaddr from "ipaddr.js";
import { fromNodeHeaders } from "better-auth/node";
import { auth, workspaceAccounts } from "./auth.js";
import { config } from "./config.js";
import { db, id } from "./db.js";
import { Problem } from "./domain.js";

const localAuthority = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
let personalUser: { id: string; name: string } | undefined;

export function initializeAccess() {
  if (!["single-user", "multi-user"].includes(config.authMode))
    throw new Error("LOOP_AUTH_MODE must be single-user or multi-user");
  if (config.authMode === "multi-user") return;
  if (config.gatewayToken && config.gatewayToken.length < 32)
    throw new Error("LOOP_GATEWAY_TOKEN must have at least 32 characters");
  if (!localAuthority.test(new URL(config.url).host) && !config.gatewayToken)
    throw new Error(
      "Remote single-user access needs an authenticated gateway and LOOP_GATEWAY_TOKEN. Use LOOP_AUTH_MODE=multi-user for Loop account sign-in.",
    );
  if (config.loopbackProxy && !localAuthority.test(config.bindAddress))
    throw new Error(
      "LOOP_LOOPBACK_PROXY requires a loopback-only published port",
    );

  const accounts = workspaceAccounts();
  personalUser = db
    .transaction(() => {
      const saved = db
        .prepare("SELECT owner_id FROM installation WHERE id=1")
        .get() as { owner_id: string } | undefined;
      const chosen = config.singleUserEmail
        ? accounts.find(
            (a) =>
              a.email.toLowerCase() === config.singleUserEmail.toLowerCase(),
          )
        : undefined;
      if (config.singleUserEmail && !chosen)
        throw new Error(
          "LOOP_SINGLE_USER_EMAIL must identify an existing Loop account",
        );
      if (!chosen && !saved && accounts.length > 1)
        throw new Error(
          "Multiple Loop accounts exist. Set LOOP_SINGLE_USER_EMAIL to select a workspace, or LOOP_AUTH_MODE=multi-user to keep separate sign-ins.",
        );
      const owner = chosen?.id || saved?.owner_id || accounts[0]?.id || id();
      db.prepare(
        "INSERT INTO installation(id,owner_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id",
      ).run(owner);
      return {
        id: owner,
        name: accounts.find((a) => a.id === owner)?.name || "Your workspace",
      };
    })
    .immediate();
}

// Docker's loopback-published port arrives from its private host bridge. This
// exception is opt-in and is never based on client-controlled forwarded headers.
export function localRequest(req: Pick<Request, "headers" | "socket">) {
  if (!localAuthority.test(req.headers.host || "")) return false;
  try {
    const range = ipaddr.process(req.socket.remoteAddress || "").range();
    return (
      range === "loopback" ||
      (config.loopbackProxy && ["private", "uniqueLocal"].includes(range))
    );
  } catch {
    return false;
  }
}

export function allowedOrigin(req: Request) {
  const origin = req.headers.origin;
  if (config.authMode === "multi-user")
    return origin === new URL(config.url).origin;
  if (origin === new URL(config.url).origin) return true;
  if (!localRequest(req)) return false;
  return (
    origin === "http://" + req.headers.host ||
    origin === "https://" + req.headers.host
  );
}

function authorizePersonalAccess(req: Request) {
  const callback =
    req.method === "GET" &&
    req.originalUrl?.split("?")[0] === "/api/mcp/oauth/callback" &&
    req.headers["sec-fetch-mode"] === "navigate" &&
    typeof req.query.state === "string" &&
    !!db
      .prepare(
        "SELECT 1 FROM oauth_states WHERE state=? AND owner_id=? AND expires_at>?",
      )
      .get(req.query.state, personalUser?.id || "", Date.now());
  if (
    !callback &&
    ((req.headers.origin && !allowedOrigin(req)) ||
      req.headers["sec-fetch-site"] === "cross-site")
  )
    throw new Problem(
      403,
      "Open Loop directly from its local address or authenticated access link.",
    );
  if (localRequest(req)) return;
  const supplied = req.get("x-loop-gateway-token") || "";
  const expected = config.gatewayToken;
  if (
    !expected ||
    req.headers.host?.toLowerCase() !==
      new URL(config.url).host.toLowerCase() ||
    Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  )
    throw new Problem(403, "Open Loop through its authenticated access link.");
}

export async function workspaceSession(req: Request) {
  if (config.authMode === "single-user") {
    authorizePersonalAccess(req);
    if (!personalUser)
      throw new Error("Workspace identity was not initialized");
    return { mode: "single-user", user: personalUser };
  }
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  return session ? { ...session, mode: "multi-user" } : null;
}
