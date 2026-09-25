import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
if (existsSync(".env")) {
  if (!/^LOOP_RUNTIME_TOKEN=.+$/m.test(readFileSync(".env", "utf8"))) {
    appendFileSync(
      ".env",
      `\nLOOP_RUNTIME_TOKEN=${randomBytes(32).toString("hex")}\n`,
    );
    console.log(
      "Added runtime service authentication; existing secrets preserved.",
    );
  }
  console.log(".env already exists; preserved");
  process.exit(0);
}
writeFileSync(
  ".env",
  `LOOP_URL=http://localhost:3000\nPORT=3000\nLOOP_AUTH_MODE=single-user\nBETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}\nLOOP_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}\nLOOP_RUNTIME_TOKEN=${randomBytes(32).toString("hex")}\n`,
  { mode: 0o600 },
);
console.log("Created local configuration.");
