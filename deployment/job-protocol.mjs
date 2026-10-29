import { createHmac, timingSafeEqual } from "node:crypto";

// Bind each message to a fresh connection nonce, its direction and its complete
// payload. Never disclose the rendezvous key to a replacement local listener.
export function signedMessage(key, nonce, direction, body) {
  const mac = createHmac("sha256", key)
    .update(JSON.stringify([nonce, direction, body]))
    .digest("hex");
  return { nonce, body, mac };
}

export function verifiedMessage(key, nonce, direction, message) {
  if (
    !message ||
    !/^[a-f0-9]{64}$/.test(nonce) ||
    message.nonce !== nonce ||
    !message.body ||
    typeof message.body !== "object" ||
    !/^[a-f0-9]{64}$/.test(message.mac)
  )
    return undefined;
  const expected = signedMessage(key, nonce, direction, message.body);
  return timingSafeEqual(Buffer.from(message.mac), Buffer.from(expected.mac))
    ? message.body
    : undefined;
}
