import { expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations";

it("upgrades both scalar grants atomically without losing identities, disclosures, revocations or rate windows", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "loop55-integration-migration-"),
  );
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    for (const name of readdirSync("migrations").filter(
      (name) => name.endsWith(".sql") && name < "135",
    ))
      writeFileSync(
        join(directory, name),
        readFileSync(join("migrations", name)),
      );
    applyMigrations(db, directory);
    for (const [token, grant, revoked] of [
      ["results", "results:read", null],
      ["cards", "cards:read", 123],
    ] as const) {
      db.prepare(
        "INSERT INTO card_tokens VALUES(?, 'owner', ?, ?, ?, 10, ?, 20, 30, 40)",
      ).run(token, token, "digest-" + token, grant, revoked);
      db.prepare("INSERT INTO card_token_ids VALUES(?, 'owner', ?)").run(
        token,
        "digest-" + token,
      );
      db.prepare(
        "INSERT INTO card_token_reads VALUES(?, 'owner', 'a:disclosed')",
      ).run(token);
    }
    db.exec(
      "INSERT INTO card_token_ids VALUES('pruned','owner','digest-pruned'); INSERT INTO card_owner_limits VALUES('owner',30,50)",
    );
    const original = db
      .prepare("SELECT * FROM card_tokens ORDER BY id")
      .all() as { scope: string }[];
    const reads = db
      .prepare("SELECT * FROM card_token_reads ORDER BY token_id")
      .all();
    const ids = db.prepare("SELECT * FROM card_token_ids ORDER BY id").all();
    const migration = "135-integration-token-scopes.sql";
    const sql = readFileSync(join("migrations", migration), "utf8");
    writeFileSync(
      join(directory, migration),
      sql + "\nSELECT * FROM deliberate_failure;",
    );
    expect(() => applyMigrations(db, directory)).toThrow("deliberate_failure");
    expect(db.prepare("SELECT * FROM card_tokens ORDER BY id").all()).toEqual(
      original,
    );
    expect(
      db.prepare("SELECT * FROM card_token_reads ORDER BY token_id").all(),
    ).toEqual(reads);
    expect(
      db
        .prepare(
          "SELECT 1 FROM schema_migrations WHERE name='integration-token-scopes'",
        )
        .get(),
    ).toBeUndefined();
    writeFileSync(join(directory, migration), sql);
    applyMigrations(db, directory);
    applyMigrations(db, directory);
    expect(db.prepare("SELECT * FROM card_tokens ORDER BY id").all()).toEqual(
      original.map((row) => ({ ...row, scope: JSON.stringify([row.scope]) })),
    );
    expect(
      db.prepare("SELECT * FROM card_token_reads ORDER BY token_id").all(),
    ).toEqual(reads);
    expect(
      db.prepare("SELECT * FROM card_token_ids ORDER BY id").all(),
    ).toEqual(ids);
    expect(db.prepare("SELECT * FROM card_owner_limits").get()).toEqual({
      owner_id: "owner",
      window: 30,
      count: 50,
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    for (const invalid of ["read", "[]", '"read"'])
      expect(() =>
        db
          .prepare("UPDATE card_tokens SET scope=? WHERE id='results'")
          .run(invalid),
      ).toThrow();
    db.exec("DELETE FROM card_tokens WHERE id='cards'");
    expect(
      db.prepare("SELECT 1 FROM card_token_reads WHERE token_id='cards'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM card_token_ids WHERE id='cards'").get(),
    ).toBeDefined();
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
