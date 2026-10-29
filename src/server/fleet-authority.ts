import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FleetCapabilities,
  FleetDigest,
  FleetDirectory,
  FleetGrantContext,
  FleetHandoffProposal,
  FleetMember,
  FleetOperation,
  MachineIdentity,
  SignedFleetDirectory,
} from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import {
  directoryDigest,
  fleetPayloadDigest,
  identityFromPrivateKey,
  signDirectory,
  verifyApprovedDirectory,
  verifyDirectorySuccessor,
  verifyHandoffProposalSignature,
} from "./fleet-crypto.js";
import { initializeFleetIdentity } from "./fleet-identity.js";
import { FleetHistoryIndex } from "./fleet-history-index.js";

type Secrets = Parameters<typeof initializeFleetIdentity>[1];
const Owner = z.string().min(1).max(256);
const Id = z.string().uuid();
const Binding = z.object({
  owner_id: Owner,
  fleet_id: Id,
  grant_id: Id,
  scope: z.string(),
  head: FleetDigest,
  state: z.enum(["controller", "replica", "handoff_pending", "removed"]),
});
type Binding = z.infer<typeof Binding>;
const Create = z
  .object({
    mutationId: Id,
    name: FleetMember.shape.name,
    origin: FleetMember.shape.origin,
    scope: FleetCapabilities,
  })
  .strict();
const Approval = z
  .object({
    mutationId: Id,
    expected: FleetDigest.nullable(),
    kind: z.enum(["enroll", "recover"]),
    grantId: Id,
    scope: FleetCapabilities,
    controller: MachineIdentity,
    directory: SignedFleetDirectory,
  })
  .strict();
const Revision = z
  .object({
    mutationId: Id,
    expected: FleetDigest,
    members: z.array(FleetMember).min(1).max(128),
  })
  .strict();
const Handoff = z
  .object({
    mutationId: Id,
    expected: FleetDigest,
    destination: MachineIdentity,
  })
  .strict();
const Recovery = Create.extend({ expected: FleetDigest }).strict();

type ActiveGrant = {
  owner_id: string;
  public_key: string;
  scope: string;
  directory_digest: string;
  epoch: number;
  revision: number;
};

/** Server-owned authority. Local consent/admin methods must only be reached
 * through the companion's authenticated local-device administration boundary.
 * Peer callers may relay successors; neither signatures nor URLs create consent. */
export class FleetAuthority {
  readonly identity: MachineIdentity;
  private readonly histories = new Map<string, FleetHistoryIndex>();
  private readonly historyWarm = new Map<string, Set<string>>();
  private readonly observers = new Map<
    string,
    Set<{ state: string; notify: () => void }>
  >();
  private readonly notifications = new Set<string>();
  constructor(
    private readonly db: Database.Database,
    private readonly secrets: Secrets,
    options: { isolated?: boolean } = {},
  ) {
    if (options.isolated)
      throw new Problem(403, "Previews cannot join fleets.");
    this.identity = initializeFleetIdentity(db, secrets);
    // Build once during local startup, before accepting peer history queries.
    // Subsequent committed inserts extend the verified index, independently of
    // an untrusted caller's choice of cursor.
    const binding = db
      .prepare("SELECT owner_id FROM fleet_binding WHERE singleton=1")
      .get() as { owner_id: string } | undefined;
    if (binding && !db.inTransaction) {
      const rows = db
        .prepare(
          "SELECT digest FROM fleet_directory_history WHERE owner_id=? ORDER BY rowid",
        )
        .all(binding.owner_id) as { digest: string }[];
      this.history(binding.owner_id).prime(rows.map((row) => row.digest));
    }
  }

  private history(owner: string) {
    // Never retain observations from a caller's transaction that may roll back.
    if (this.db.inTransaction)
      return new FleetHistoryIndex((digest) => this.saved(owner, digest));
    let index = this.histories.get(owner);
    if (!index)
      this.histories.set(
        owner,
        (index = new FleetHistoryIndex((digest) => this.saved(owner, digest))),
      );
    return index;
  }

  private warmHistory(owner: string, digest: string) {
    let pending = this.historyWarm.get(owner);
    if (pending) {
      pending.add(digest);
      return;
    }
    this.historyWarm.set(owner, (pending = new Set([digest])));
    queueMicrotask(() => {
      this.historyWarm.delete(owner);
      if (!this.db.open) return;
      try {
        const index = this.history(owner);
        index.prime(pending!);
        const binding = this.binding(owner);
        if (binding) index.prime([binding.head]);
      } catch {
        // A corrupt committed path must fail the next read, never crash a
        // background notification or leave a partly populated trusted index.
        this.histories.delete(owner);
      }
    });
  }

  ancestor(owner: string, head: string, cursor: string) {
    if (!this.binding(owner)) return false;
    FleetDigest.parse(head);
    FleetDigest.parse(cursor);
    // Random signed cursor probes perform one indexed existence check. They
    // cannot allocate cache entries or initiate a retained-history traversal.
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM fleet_directory_history WHERE owner_id=? AND digest=?",
        )
        .get(owner, cursor)
    )
      return this.history(owner).knownMissing(head, cursor);
    return this.history(owner).contains(head, cursor);
  }

  lineage(owner: string, head?: string): Set<string> {
    const binding = this.binding(owner);
    if (!binding) return new Set();
    return this.history(owner).lineage(
      head === undefined ? binding.head : FleetDigest.parse(head),
    );
  }

  private binding(owner: string): Binding | undefined {
    Owner.parse(owner);
    const value = this.db
      .prepare("SELECT * FROM fleet_binding WHERE singleton=1")
      .get();
    if (!value) return;
    const row = Binding.parse(value);
    if (row.owner_id !== owner)
      throw new Problem(403, "This owner has no fleet grant.");
    return row;
  }

  private saved(
    owner: string,
    digest: string,
  ): SignedFleetDirectory | undefined {
    const row = this.db
      .prepare(
        "SELECT signed FROM fleet_directory_history WHERE owner_id=? AND digest=?",
      )
      .get(owner, digest) as { signed: string } | undefined;
    if (!row) return;
    const signed = verifyApprovedDirectory(JSON.parse(row.signed));
    if (directoryDigest(signed.document) !== digest)
      throw new Problem(409, "Stored fleet directory is inconsistent.");
    // Local consent pins an explicit trust anchor, including recovery into a
    // different lineage. Knowing its named parent does not turn that consent
    // into an assertion that it was an ordinary successor of the old lineage.
    const anchor =
      signed.document.kind === "handoff" &&
      this.db
        .prepare(
          "SELECT 1 FROM fleet_local_consents WHERE owner_id=? AND accepted_head=?",
        )
        .get(owner, digest);
    if (
      signed.document.kind === "handoff" &&
      signed.document.parent &&
      !anchor
    ) {
      const parent = this.db
        .prepare(
          "SELECT signed FROM fleet_directory_history WHERE owner_id=? AND digest=?",
        )
        .get(owner, signed.document.parent) as { signed: string } | undefined;
      if (parent) {
        const previous = verifyApprovedDirectory(JSON.parse(parent.signed));
        if (directoryDigest(previous.document) !== signed.document.parent)
          throw new Problem(409, "Stored fleet predecessor is inconsistent.");
        verifyDirectorySuccessor(signed, previous.document);
      }
    }
    return signed;
  }

  directory(owner: string, digest?: string): SignedFleetDirectory | undefined {
    const binding = this.binding(owner);
    if (!binding) return;
    return this.saved(
      owner,
      digest === undefined ? binding.head : FleetDigest.parse(digest),
    );
  }

  status(owner: string) {
    const binding = this.binding(owner);
    return binding
      ? {
          state: binding.state,
          head: binding.head,
          directory: this.saved(owner, binding.head)!,
        }
      : { state: "standalone" as const, head: null, directory: null };
  }

  private observation(owner: string) {
    const binding = this.binding(owner);
    return JSON.stringify(
      binding
        ? [binding.head, binding.state, binding.grant_id, binding.scope]
        : null,
    );
  }

  /** Observes this process's committed authority changes. SQLite transactions
   * are synchronous, including callers' outer transactions; the microtask reads
   * their final state, so a rolled-back install cannot invalidate a live lease.
   * Dispatch must still recheck current authority at its own boundary. */
  observe(owner: string, notify: () => void) {
    const observer = { state: this.observation(owner), notify };
    let group = this.observers.get(owner);
    if (!group) this.observers.set(owner, (group = new Set()));
    group.add(observer);
    return () => {
      group.delete(observer);
      if (!group.size) this.observers.delete(owner);
    };
  }

  private changed(owner: string) {
    if (!this.observers.has(owner) || this.notifications.has(owner)) return;
    this.notifications.add(owner);
    queueMicrotask(() => {
      this.notifications.delete(owner);
      const group = this.observers.get(owner);
      if (!group) return;
      let state: string;
      try {
        state = this.observation(owner);
      } catch {
        // Consumers must fail closed if the committed binding is unreadable.
        state = "unavailable";
      }
      for (const observer of [...group]) {
        if (observer.state === state) continue;
        observer.state = state;
        try {
          observer.notify();
        } catch {
          // Observer failures cannot alter a committed mutation or its receipt.
        }
      }
    });
  }

  private sign(
    document: FleetDirectory,
    purpose: "directory" | "handoff" = "directory",
  ) {
    const row = this.db
      .prepare(
        "SELECT private_key FROM fleet_machine_identity WHERE singleton=1",
      )
      .get() as { private_key: string };
    const key = this.secrets.unseal(
      row.private_key,
      `fleet:machine:${this.identity.machineId}`,
    );
    if (identityFromPrivateKey(key).machineId !== this.identity.machineId)
      throw new Problem(
        409,
        "Fleet signing identity changed; explicit recovery is required.",
      );
    return signDirectory(document, key, purpose);
  }

  private checkMutation(owner: string, document: FleetDirectory) {
    const digest = directoryDigest(document);
    const prior = this.db
      .prepare(
        "SELECT digest FROM fleet_directory_history WHERE owner_id=? AND fleet_id=? AND mutation_id=?",
      )
      .get(owner, document.fleetId, document.mutationId) as
      { digest: string } | undefined;
    if (prior && prior.digest !== digest)
      throw new Problem(
        409,
        "Fleet mutation ID already belongs to another directory.",
      );
    return digest;
  }

  private remember(owner: string, signed: SignedFleetDirectory) {
    const digest = this.checkMutation(owner, signed.document);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO fleet_directory_history VALUES(?,?,?,?,?,?)",
      )
      .run(
        owner,
        digest,
        signed.document.fleetId,
        signed.document.mutationId,
        JSON.stringify(signed),
        Date.now(),
      );
    this.warmHistory(owner, digest);
    const previous = signed.document.parent
      ? this.saved(owner, signed.document.parent)
      : undefined;
    if (previous && signed.document.kind === "revision") {
      const record = this.db.prepare(
        "INSERT OR IGNORE INTO fleet_removal_history VALUES(?,?,?,?,?,?)",
      );
      for (const peer of previous.document.members) {
        if (
          signed.document.tombstones.includes(peer.machineId) &&
          !signed.document.members.some(
            (member) => member.machineId === peer.machineId,
          )
        )
          record.run(
            owner,
            peer.machineId,
            peer.publicKey,
            signed.document.fleetId,
            digest,
            signed.document.parent,
          );
      }
    }
    return digest;
  }

  private install(
    owner: string,
    signed: SignedFleetDirectory,
    grantId: string,
    scope: FleetOperation[],
  ) {
    const digest = this.remember(owner, signed),
      doc = signed.document;
    const local = doc.members.find(
      (m) => m.machineId === this.identity.machineId,
    );
    if (
      local &&
      (local.grantId !== grantId || local.publicKey !== this.identity.publicKey)
    )
      throw new Problem(
        403,
        "Directory does not match this destination's local consent.",
      );
    const state = !local
      ? "removed"
      : doc.controller.machineId === this.identity.machineId
        ? "controller"
        : "replica";
    this.db
      .prepare(
        `INSERT INTO fleet_binding VALUES(1,?,?,?,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id,fleet_id=excluded.fleet_id,
      grant_id=excluded.grant_id,scope=excluded.scope,head=excluded.head,state=excluded.state`,
      )
      .run(owner, doc.fleetId, grantId, JSON.stringify(scope), digest, state);
    this.db
      .prepare("UPDATE fleet_peer_grants SET active=0 WHERE owner_id=?")
      .run(owner);
    if (local) {
      const grant = this.db
        .prepare(`INSERT INTO fleet_peer_grants VALUES(?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(owner_id,grant_id,peer_id) DO UPDATE SET public_key=excluded.public_key,
        fleet_id=excluded.fleet_id,directory_digest=excluded.directory_digest,epoch=excluded.epoch,
        revision=excluded.revision,scope=excluded.scope,active=1`);
      for (const peer of doc.members)
        if (peer.machineId !== this.identity.machineId)
          grant.run(
            owner,
            grantId,
            peer.machineId,
            peer.publicKey,
            doc.fleetId,
            digest,
            doc.epoch,
            doc.revision,
            JSON.stringify(scope),
          );
    }
    this.changed(owner);
    return signed;
  }

  private admin<T>(
    owner: string,
    mutationId: string,
    action: string,
    input: unknown,
    apply: () => T,
  ): T {
    Owner.parse(owner);
    Id.parse(mutationId);
    const digest = fleetPayloadDigest(input);
    return this.db
      .transaction(() => {
        this.binding(owner);
        const prior = this.db
          .prepare(
            "SELECT action,payload_digest,result FROM fleet_admin_receipts WHERE owner_id=? AND mutation_id=?",
          )
          .get(owner, mutationId) as
          | { action: string; payload_digest: string; result: string }
          | undefined;
        if (prior) {
          if (prior.action !== action || prior.payload_digest !== digest)
            throw new Problem(
              409,
              "Fleet operation ID belongs to different input.",
            );
          return JSON.parse(prior.result) as T;
        }
        const reservation = this.db
          .prepare(
            "SELECT operation_id,revision_digest FROM fleet_admin_reservations WHERE owner_id=?",
          )
          .get(owner) as
          { operation_id: string; revision_digest: string | null } | undefined;
        if (
          reservation &&
          (action !== "revise" ||
            reservation.operation_id !== mutationId ||
            reservation.revision_digest !== digest)
        )
          throw new Problem(
            409,
            "Resolve the pending enrollment before editing the directory.",
          );
        const result = apply();
        this.db
          .prepare("INSERT INTO fleet_admin_receipts VALUES(?,?,?,?,?)")
          .run(owner, mutationId, action, digest, JSON.stringify(result));
        return result;
      })
      .immediate();
  }

  create(owner: string, input: z.infer<typeof Create>): SignedFleetDirectory {
    const value = Create.parse(input);
    return this.admin(owner, value.mutationId, "create", value, () => {
      if (this.binding(owner))
        throw new Problem(409, "This machine already has a fleet binding.");
      const grantId = randomUUID();
      const document: FleetDirectory = {
        version: 1,
        fleetId: randomUUID(),
        epoch: 0,
        revision: 0,
        mutationId: value.mutationId,
        parent: null,
        kind: "genesis",
        controller: this.identity,
        members: [
          { ...this.identity, grantId, name: value.name, origin: value.origin },
        ],
        tombstones: [],
      };
      const signed = verifyApprovedDirectory({
        document,
        signature: this.sign(document),
        acceptance: null,
      });
      this.consent(
        owner,
        value.mutationId,
        "create",
        null,
        signed,
        grantId,
        value.scope,
      );
      return this.install(owner, signed, grantId, value.scope);
    });
  }

  private consent(
    owner: string,
    id: string,
    kind: "create" | "enroll" | "recover",
    previous: string | null,
    signed: SignedFleetDirectory,
    grant: string,
    scope: FleetOperation[],
  ) {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM fleet_local_consents WHERE owner_id=? AND grant_id=?",
        )
        .get(owner, grant)
    )
      throw new Problem(
        409,
        "A new local consent requires a fresh destination grant.",
      );
    this.db
      .prepare("INSERT INTO fleet_local_consents VALUES(?,?,?,?,?,?,?,?)")
      .run(
        owner,
        id,
        kind,
        previous,
        directoryDigest(signed.document),
        grant,
        JSON.stringify(scope),
        Date.now(),
      );
  }

  /** Only explicit local consent can anchor an enrollment or reset. The caller
   * must show and authorize the exact controller, directory and scope supplied. */
  approve(
    owner: string,
    input: z.infer<typeof Approval>,
  ): SignedFleetDirectory {
    const value = Approval.parse(input);
    return this.admin(owner, value.mutationId, "approve", value, () => {
      const old = this.binding(owner);
      if ((old?.head ?? null) !== value.expected)
        throw new Problem(409, "Fleet changed; confirm the current directory.");
      const signed = verifyApprovedDirectory(value.directory),
        doc = signed.document;
      const member = doc.members.find(
        (m) => m.machineId === this.identity.machineId,
      );
      if (
        !member ||
        member.grantId !== value.grantId ||
        doc.controller.machineId !== value.controller.machineId ||
        doc.controller.publicKey !== value.controller.publicKey
      )
        throw new Problem(
          403,
          "Fleet directory does not match the approved identity and grant.",
        );
      if (value.kind === "enroll" ? !!old : !old)
        throw new Problem(
          409,
          "Choose explicit recovery for an existing fleet binding.",
        );
      if (old) {
        const prior = this.saved(owner, old.head)!.document;
        // Explicit consent chooses a lineage, not the largest counter. Another
        // partition can have a higher epoch; its old grants are fenced locally.
        if (
          doc.fleetId !== prior.fleetId ||
          doc.epoch < 1 ||
          doc.kind === "genesis" ||
          value.grantId === old.grant_id
        )
          throw new Problem(
            409,
            "Recovery requires a newly approved authority lineage and local grant.",
          );
      }
      this.consent(
        owner,
        value.mutationId,
        value.kind,
        old?.head ?? null,
        signed,
        value.grantId,
        value.scope,
      );
      return this.install(owner, signed, value.grantId, value.scope);
    });
  }

  private controller(owner: string, expected: string) {
    const binding = this.binding(owner);
    if (!binding || binding.state !== "controller")
      throw new Problem(
        403,
        "Directory administration belongs to the current controller.",
      );
    if (binding.head !== expected)
      throw new Problem(409, "Fleet changed; refresh before editing.");
    return { binding, previous: this.saved(owner, binding.head)!.document };
  }

  /** A local device explicitly starts recovery with this machine alone. Every
   * additional member must separately approve a new destination grant. */
  recover(
    owner: string,
    input: z.infer<typeof Recovery>,
  ): SignedFleetDirectory {
    const value = Recovery.parse(input);
    return this.admin(owner, value.mutationId, "recover", value, () => {
      const binding = this.binding(owner);
      if (!binding || binding.state === "removed")
        throw new Problem(403, "Recovery requires a locally enrolled member.");
      if (binding.head !== value.expected)
        throw new Problem(409, "Fleet changed; confirm the current directory.");
      const previous = this.saved(owner, binding.head)!.document;
      const grantId = randomUUID();
      const document = FleetDirectory.parse({
        version: 1,
        fleetId: previous.fleetId,
        epoch: previous.epoch + 1,
        revision: 0,
        mutationId: value.mutationId,
        parent: binding.head,
        kind: "recovery",
        controller: this.identity,
        members: [
          { ...this.identity, grantId, name: value.name, origin: value.origin },
        ],
        tombstones: previous.tombstones,
      });
      const signed = verifyApprovedDirectory({
        document,
        signature: this.sign(document),
        acceptance: null,
      });
      this.consent(
        owner,
        value.mutationId,
        "recover",
        binding.head,
        signed,
        grantId,
        value.scope,
      );
      return this.install(owner, signed, grantId, value.scope);
    });
  }

  revise(owner: string, input: z.infer<typeof Revision>): SignedFleetDirectory {
    const value = Revision.parse(input);
    return this.admin(owner, value.mutationId, "revise", value, () => {
      const { binding, previous } = this.controller(owner, value.expected);
      const removed = previous.members.filter(
        (old) => !value.members.some((m) => m.machineId === old.machineId),
      );
      const document: FleetDirectory = {
        ...previous,
        kind: "revision",
        revision: previous.revision + 1,
        parent: binding.head,
        mutationId: value.mutationId,
        members: value.members,
        tombstones: [
          ...previous.tombstones,
          ...removed.map((m) => m.machineId),
        ],
      };
      const signed = verifyDirectorySuccessor(
        { document, signature: this.sign(document), acceptance: null },
        previous,
      );
      return this.install(
        owner,
        signed,
        binding.grant_id,
        FleetCapabilities.parse(JSON.parse(binding.scope)),
      );
    });
  }

  prepareHandoff(
    owner: string,
    input: z.infer<typeof Handoff>,
  ): FleetHandoffProposal {
    const value = Handoff.parse(input);
    return this.admin(owner, value.mutationId, "handoff", value, () => {
      const { binding, previous } = this.controller(owner, value.expected);
      if (
        value.destination.machineId === this.identity.machineId ||
        !previous.members.some(
          (m) =>
            m.machineId === value.destination.machineId &&
            m.publicKey === value.destination.publicKey,
        )
      )
        throw new Problem(403, "Choose an enrolled controller destination.");
      const document = FleetDirectory.parse({
        ...previous,
        kind: "handoff",
        epoch: previous.epoch + 1,
        revision: 0,
        parent: binding.head,
        mutationId: value.mutationId,
        controller: value.destination,
      });
      const proposal = FleetHandoffProposal.parse({
        document,
        signature: this.sign(document),
      });
      this.checkMutation(owner, document);
      this.db
        .prepare("INSERT INTO fleet_handoffs VALUES(?,?,?,'prepared',NULL)")
        .run(owner, directoryDigest(document), JSON.stringify(proposal));
      // This transaction commits before any proposal leaves the process. There
      // is deliberately no timeout/automatic abort that could revive this writer.
      this.db
        .prepare(
          "UPDATE fleet_binding SET state='handoff_pending' WHERE singleton=1",
        )
        .run();
      this.changed(owner);
      return proposal;
    });
  }

  acceptHandoff(
    owner: string,
    input: FleetHandoffProposal,
  ): SignedFleetDirectory {
    const proposal = FleetHandoffProposal.parse(input);
    return this.db
      .transaction(() => {
        const binding = this.binding(owner);
        if (!binding)
          throw new Problem(403, "Handoff requires an enrolled destination.");
        const known = this.saved(owner, directoryDigest(proposal.document));
        if (known) {
          if (
            known.signature !== proposal.signature ||
            known.document.controller.machineId !== this.identity.machineId
          )
            throw new Problem(409, "Conflicting fleet handoff.");
          return known;
        }
        if (
          binding.state !== "replica" ||
          proposal.document.controller.machineId !== this.identity.machineId
        )
          throw new Problem(
            403,
            "This machine is not the proposed controller.",
          );
        const previous = this.saved(owner, binding.head)!.document;
        verifyHandoffProposalSignature(proposal, previous);
        const signed = verifyDirectorySuccessor(
          { ...proposal, acceptance: this.sign(proposal.document, "handoff") },
          previous,
        );
        this.install(
          owner,
          signed,
          binding.grant_id,
          FleetCapabilities.parse(JSON.parse(binding.scope)),
        );
        this.db
          .prepare("INSERT INTO fleet_handoffs VALUES(?,?,?,'committed',?)")
          .run(
            owner,
            directoryDigest(signed.document),
            JSON.stringify(proposal),
            JSON.stringify(signed),
          );
        return signed;
      })
      .immediate();
  }

  /** Retain missing predecessors of an explicitly approved head. Each edge is
   * verified backward from current local trust; this never changes a binding,
   * active grant, controller or recovery lineage. Input is newest first. */
  retainAncestors(owner: string, input: SignedFleetDirectory[]): boolean {
    const entries = z.array(SignedFleetDirectory).min(1).max(32).parse(input);
    return this.db
      .transaction(() => {
        const binding = this.binding(owner);
        if (!binding || binding.state === "removed") return false;
        let child = this.saved(owner, binding.head)!;
        for (let count = 0; count < 1024; count++) {
          if (!child.document.parent || child.document.kind === "recovery")
            return false;
          const parent = this.saved(owner, child.document.parent);
          if (!parent) break;
          child = parent;
        }
        if (
          child.document.kind === "recovery" ||
          child.document.parent !== directoryDigest(entries[0].document)
        )
          return false;
        const successor = child;
        for (const parent of entries) {
          verifyApprovedDirectory(parent);
          verifyDirectorySuccessor(child, parent.document);
          child = parent;
        }
        for (const entry of [...entries].reverse()) this.remember(owner, entry);
        // A retained predecessor may complete the existing removal index edge.
        this.remember(owner, successor);
        return true;
      })
      .immediate();
  }

  /** Relay of a signed successor never creates a binding or expands its scope. */
  accept(owner: string, input: SignedFleetDirectory): SignedFleetDirectory {
    const value = SignedFleetDirectory.parse(input);
    return this.db
      .transaction(() => {
        const binding = this.binding(owner);
        if (!binding)
          throw new Problem(403, "Fleet enrollment requires local consent.");
        const digest = directoryDigest(value.document),
          known = this.saved(owner, digest);
        if (known) {
          if (
            known.signature !== value.signature ||
            known.acceptance !== value.acceptance
          )
            throw new Problem(403, "Conflicting fleet signature.");
          return known;
        }
        if (
          this.db
            .prepare("SELECT 1 FROM fleet_admin_reservations WHERE owner_id=?")
            .get(owner)
        )
          throw new Problem(
            409,
            "Resolve the pending enrollment before accepting another directory.",
          );
        if (binding.state === "removed")
          throw new Problem(
            403,
            "This machine was removed; explicit recovery is required.",
          );
        if (
          value.document.kind === "genesis" ||
          value.document.kind === "recovery"
        )
          throw new Problem(
            409,
            "Fleet recovery requires explicit local consent.",
          );
        const signed = verifyDirectorySuccessor(
          value,
          this.saved(owner, binding.head)!.document,
        );
        if (binding.state === "handoff_pending") {
          const prepared = this.db
            .prepare(
              "SELECT digest FROM fleet_handoffs WHERE owner_id=? AND digest=? AND state='prepared'",
            )
            .get(owner, digest);
          if (!prepared)
            throw new Problem(
              409,
              "Resolve the prepared controller handoff first.",
            );
          this.db
            .prepare(
              "UPDATE fleet_handoffs SET state='committed',result=? WHERE owner_id=? AND digest=?",
            )
            .run(JSON.stringify(signed), owner, digest);
        }
        return this.install(
          owner,
          signed,
          binding.grant_id,
          FleetCapabilities.parse(JSON.parse(binding.scope)),
        );
      })
      .immediate();
  }

  authorize(input: FleetGrantContext) {
    const context = FleetGrantContext.parse(input);
    if (
      context.destination !== this.identity.machineId ||
      context.peer === this.identity.machineId
    )
      throw new Problem(
        403,
        "Fleet destination or peer identity does not match.",
      );
    const binding = this.db
      .prepare("SELECT owner_id FROM fleet_binding WHERE singleton=1")
      .get() as { owner_id: string } | undefined;
    if (!binding) throw new Problem(403, "This machine has no fleet grant.");
    const grant = this.acceptedGrant(
      binding.owner_id,
      context.peer,
      context.fleetId,
      context.grantId,
      context.operation,
    );
    if (grant.directory_digest !== context.directory)
      throw new Problem(
        409,
        "Synchronize the signed directory before using this grant.",
      );
    return {
      owner: grant.owner_id,
      publicKey: grant.public_key,
      epoch: grant.epoch,
      revision: grant.revision,
    };
  }

  /** Recheck durable accepted work against current local grants before dispatch.
   * Credential expiry does not itself cancel accepted work; revocation does. */
  acceptedGrant(
    owner: string,
    peer: string,
    fleet: string,
    grantId: string,
    operation: FleetOperation,
  ): ActiveGrant {
    const binding = this.binding(owner);
    const current = binding && this.saved(owner, binding.head);
    const grant = this.db
      .prepare(
        `SELECT * FROM fleet_peer_grants WHERE owner_id=? AND peer_id=? AND fleet_id=? AND grant_id=? AND active=1`,
      )
      .get(owner, peer, fleet, grantId) as ActiveGrant | undefined;
    if (
      !binding ||
      binding.state === "removed" ||
      !grant ||
      !current ||
      grant.directory_digest !== binding.head ||
      grant.epoch !== current.document.epoch ||
      grant.revision !== current.document.revision ||
      grant.scope !== binding.scope ||
      !current.document.members.some(
        (member) =>
          member.machineId === peer && member.publicKey === grant.public_key,
      ) ||
      !FleetCapabilities.parse(JSON.parse(grant.scope)).includes(
        FleetOperation.parse(operation),
      )
    )
      throw new Problem(
        403,
        "Fleet access is absent, revoked, or outside its approved scope.",
      );
    return grant;
  }
}
