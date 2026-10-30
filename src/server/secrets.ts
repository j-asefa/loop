import "../../runtime/environment.mjs";
import { companionMode } from "./profile.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
function key() {
  const path = join(config.data, "encryption-key");
  let value = process.env.LOOP55_ENCRYPTION_KEY;
  if (!value && !companionMode)
    throw new Error("LOOP55_ENCRYPTION_KEY must be 32 random bytes in hex");
  if (!value) {
    try {
      value = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        writeFileSync(path, randomBytes(32).toString("hex"), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      value = readFileSync(path, "utf8");
    }
    chmodSync(path, 0o600);
  }
  if (!value || !/^[a-f\d]{64}$/i.test(value))
    throw new Error("LOOP55_ENCRYPTION_KEY must be 32 random bytes in hex");
  return Buffer.from(value, "hex");
}
export function seal(value: string, owner: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(owner));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map((x) => x.toString("base64"))
    .join(".");
}
export function unseal(value: string, owner: string) {
  const [iv, tag, data] = value.split(".").map((x) => Buffer.from(x, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(owner));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}
