import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import Database from "better-sqlite3";
import { join } from "node:path";
import { config } from "./config.js";
if (
  !process.env.BETTER_AUTH_SECRET ||
  process.env.BETTER_AUTH_SECRET.length < 32
)
  throw new Error(
    "Set BETTER_AUTH_SECRET (32+ random characters); run npm run setup",
  );
const db = new Database(join(config.data, "auth.db"));
db.pragma("busy_timeout = 5000");
db.pragma("journal_mode = WAL");
// Keep async auth transactions separate from frequent worker writes. Preserve early installations.
if (
  !db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user'")
    .get()
) {
  db.prepare("ATTACH DATABASE ? AS legacy").run(config.database);
  try {
    db.transaction(() => {
      for (const table of [
        "user",
        "session",
        "account",
        "verification",
        "rateLimit",
      ]) {
        const row = db
          .prepare(
            "SELECT sql FROM legacy.sqlite_master WHERE type='table' AND name=?",
          )
          .get(table) as { sql: string } | undefined;
        if (row) {
          db.exec(row.sql);
          db.exec(
            `INSERT INTO main."${table}" SELECT * FROM legacy."${table}"`,
          );
        }
      }
    }).immediate();
  } finally {
    db.exec("DETACH DATABASE legacy");
  }
}
export const auth = betterAuth({
  database: db,
  baseURL: config.url,
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  socialProviders:
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          },
        }
      : {},
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  advanced: {
    useSecureCookies: config.url.startsWith("https://"),
    ipAddress: { ipAddressHeaders: ["x-loop-client-ip"] },
  },
  rateLimit: { enabled: true, storage: "database" },
  user: { deleteUser: { enabled: false } },
});
export async function migrateAuth() {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
export function workspaceAccounts() {
  return db.prepare("SELECT id,name,email FROM user ORDER BY id").all() as {
    id: string;
    name: string;
    email: string;
  }[];
}
