import test, { after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import {
  withFleetAction,
  assertFleetAction,
  currentFleetAction,
} from "../src/server/fleet-action-context.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-effect-storage-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db } = await import("../src/server/db.js");
const secrets = await import("../src/server/secrets.js");
const {
  recordFleetEffect,
  recordFleetEffectEdit,
  discardFleetEffectEdit,
  assertFleetEffect,
  authorizeFleetEffect,
  inheritFleetEffect,
  withFleetEffect,
} = await import("../src/server/fleet-effect-authorizations.js");
const owner = "local-workspace";
const authority = new FleetAuthority(db, secrets);
authority.create(owner, {
  mutationId: randomUUID(),
  name: "Local",
  origin: "https://local.example",
  scope: ["act"],
});
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function peer() {
  const storage = new Database(":memory:");
  applyMigrations(storage);
  storage.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  const identity = new FleetAuthority(storage, secrets).identity;
  storage.close();
  const current = authority.directory(owner)!;
  const directory = authority.revise(owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(current.document),
    members: [
      ...current.document.members,
      {
        ...identity,
        name: "Peer",
        origin: `https://${randomUUID()}.example`,
        grantId: randomUUID(),
      },
    ],
  });
  const grant = {
    fleetId: directory.document.fleetId,
    grantId: directory.document.members[0].grantId,
    destination: authority.identity.machineId,
    peer: identity.machineId,
    directory: directoryDigest(directory.document),
    operation: "act" as const,
  };
  return {
    act<T>(commandId: string, apply: () => T) {
      return withFleetAction(
        { owner, commandId, grant },
        () => authorizeFleetEffect(owner, grant),
        apply,
      );
    },
    revoke() {
      const current = authority.directory(owner)!;
      authority.revise(owner, {
        mutationId: randomUUID(),
        expected: directoryDigest(current.document),
        members: current.document.members.filter(
          (member) => member.machineId !== identity.machineId,
        ),
      });
    },
  };
}

test("effect constraints share the owning transaction and cannot cross owners", () => {
  const sender = peer(),
    effect = randomUUID(),
    command = randomUUID();
  assert.throws(
    () => sender.act(command, () => recordFleetEffect(owner, "run", effect)),
    /owner transaction/,
  );
  assert.throws(
    () =>
      sender.act(command, () =>
        db
          .transaction(() => recordFleetEffect("another-owner", "run", effect))
          .immediate(),
      ),
    /owner transaction/,
  );
  assert.throws(
    () =>
      sender.act(command, () =>
        db
          .transaction(() => {
            recordFleetEffect(owner, "run", effect);
            throw new Error("fixture rollback");
          })
          .immediate(),
      ),
    /fixture rollback/,
  );
  assert.equal(
    db
      .prepare("SELECT 1 FROM fleet_effect_authorizations WHERE effect_id=?")
      .get(effect),
    undefined,
  );
  sender.act(command, () =>
    db.transaction(() => recordFleetEffect(owner, "run", effect)).immediate(),
  );
  const child = randomUUID();
  db.transaction(() =>
    inheritFleetEffect(owner, "run", effect, child),
  ).immediate();
  assert.throws(
    () =>
      sender.act(randomUUID(), () =>
        db
          .transaction(() =>
            inheritFleetEffect("another-owner", "run", effect, randomUUID()),
          )
          .immediate(),
      ),
    /another owner/,
  );
  sender.revoke();
  assert.throws(
    () => assertFleetEffect(owner, "run", effect),
    /no longer permits/,
  );
  assert.throws(
    () => assertFleetEffect(owner, "run", child),
    /no longer permits/,
  );
  assert.doesNotThrow(() => assertFleetEffect("another-owner", "run", effect));
});

test("definitive non-delivery discards only the newly inserted edit", () => {
  const accepted = peer(),
    rejected = peer(),
    effect = randomUUID();
  const retained = accepted.act(randomUUID(), () =>
    db
      .transaction(() => recordFleetEffectEdit(owner, "run", effect))
      .immediate(),
  );
  const attempt = rejected.act(randomUUID(), () =>
    db
      .transaction(() => recordFleetEffectEdit(owner, "run", effect))
      .immediate(),
  );
  assert(retained && attempt);
  assert.throws(() => discardFleetEffectEdit(attempt), /owner transaction/);
  db.transaction(() => discardFleetEffectEdit(attempt)).immediate();
  rejected.revoke();
  assert.doesNotThrow(() => assertFleetEffect(owner, "run", effect));
  accepted.revoke();
  assert.throws(
    () => assertFleetEffect(owner, "run", effect),
    /no longer permits/,
  );
});

test("duplicate edit attempts cannot discard an earlier accepted constraint", () => {
  const sender = peer(),
    effect = randomUUID(),
    command = randomUUID();
  const record = () =>
    sender.act(command, () =>
      db
        .transaction(() => recordFleetEffectEdit(owner, "run", effect))
        .immediate(),
    );
  assert(record());
  const duplicate = record();
  assert.equal(duplicate, undefined);
  db.transaction(() => discardFleetEffectEdit(duplicate)).immediate();
  sender.revoke();
  assert.throws(
    () => assertFleetEffect(owner, "run", effect),
    /no longer permits/,
  );
});

test("recovery rollback preserves its original constraint", () => {
  const sender = peer(),
    effect = randomUUID();
  const attempt = sender.act(randomUUID(), () =>
    db
      .transaction(() => recordFleetEffectEdit(owner, "run", effect))
      .immediate(),
  );
  assert.throws(
    () =>
      db
        .transaction(() => {
          discardFleetEffectEdit(attempt);
          throw new Error("fixture recovery failure");
        })
        .immediate(),
    /recovery failure/,
  );
  sender.revoke();
  assert.throws(
    () => assertFleetEffect(owner, "run", effect),
    /no longer permits/,
  );
});

for (const source of ["creator", "editors", "inherited"] as const)
  test(`${source} constraints recheck every retained grant after asynchronous preparation`, async () => {
    const first = peer(),
      second = peer(),
      parent = randomUUID(),
      effect = source === "inherited" ? randomUUID() : parent,
      release = Promise.withResolvers<void>();
    first.act(randomUUID(), () =>
      db
        .transaction(() => {
          if (source === "editors") recordFleetEffectEdit(owner, "run", parent);
          else recordFleetEffect(owner, "run", parent);
        })
        .immediate(),
    );
    second.act(randomUUID(), () =>
      db
        .transaction(() => recordFleetEffectEdit(owner, "run", parent))
        .immediate(),
    );
    if (source === "inherited")
      db.transaction(() =>
        inheritFleetEffect(owner, "run", parent, effect),
      ).immediate();
    let dispatched = false;
    const pending = withFleetEffect(owner, "run", effect, async () => {
      await release.promise;
      assertFleetAction(owner);
      dispatched = true;
    });
    // Revoking the second contributor must be checked even when the first
    // retained contributor supplies the action's durable identity.
    second.revoke();
    release.resolve();
    await assert.rejects(pending, /no longer permits/);
    assert.equal(dispatched, false);
  });

test("unrelated local effects do not inherit the waking request's action context", async () => {
  const sender = peer(),
    release = Promise.withResolvers<void>();
  const pending = sender.act(randomUUID(), () =>
    withFleetEffect(owner, "run", randomUUID(), async () => {
      await release.promise;
      assertFleetAction(owner);
      return currentFleetAction();
    }),
  );
  sender.revoke();
  release.resolve();
  assert.equal(await pending, undefined);
});

for (const kind of ["creator", "editor"] as const)
  test(`an edit cannot reuse a ${kind}'s command for another peer grant`, () => {
    const first = peer(),
      second = peer(),
      effect = randomUUID(),
      command = randomUUID();
    first.act(command, () =>
      db
        .transaction(() => {
          if (kind === "creator") recordFleetEffect(owner, "run", effect);
          else recordFleetEffectEdit(owner, "run", effect);
        })
        .immediate(),
    );
    assert.throws(
      () =>
        second.act(command, () =>
          db
            .transaction(() => recordFleetEffectEdit(owner, "run", effect))
            .immediate(),
        ),
      /different fleet grant/,
    );
    second.revoke();
    assert.doesNotThrow(() => assertFleetEffect(owner, "run", effect));
    first.revoke();
    assert.throws(
      () => assertFleetEffect(owner, "run", effect),
      /no longer permits/,
    );
  });

test("inheritance rejects conflicting target grants and rolls back earlier copied constraints", () => {
  const first = peer(),
    second = peer(),
    parent = randomUUID(),
    child = randomUUID(),
    shared = randomUUID();
  first.act(randomUUID(), () =>
    db.transaction(() => recordFleetEffect(owner, "run", parent)).immediate(),
  );
  second.act(shared, () =>
    db
      .transaction(() => recordFleetEffectEdit(owner, "run", parent))
      .immediate(),
  );
  first.act(shared, () =>
    db
      .transaction(() => recordFleetEffectEdit(owner, "run", child))
      .immediate(),
  );
  const before = db
    .prepare("SELECT * FROM fleet_effect_edit_authorizations WHERE effect_id=?")
    .all(child);
  assert.throws(
    () =>
      db
        .transaction(() => inheritFleetEffect(owner, "run", parent, child))
        .immediate(),
    /different fleet grant/,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT * FROM fleet_effect_edit_authorizations WHERE effect_id=?",
      )
      .all(child),
    before,
  );
});
