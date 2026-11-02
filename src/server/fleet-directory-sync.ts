import * as fleetEnrollmentsQueries from "./sql/fleet-enrollments.js";
import * as fleetRemovalHistoryQueries from "./sql/fleet-removal-history.js";
import type Database from "better-sqlite3";
import { MachineIdentity, SignedFleetDirectory } from "../shared/fleet.js";
import {
  SignedFleetDirectoryAck,
  SignedFleetDirectoryPush,
  SignedFleetHistoryPage,
  SignedFleetHistoryQuery,
} from "../shared/fleet-directory-sync.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import {
  directoryDigest,
  fleetPayloadDigest,
  verifyApprovedDirectory,
  verifyDirectorySuccessor,
} from "./fleet-crypto.js";
import { FleetProof, verifyFleetProof } from "./fleet-proof.js";
import type { initializeFleetIdentity } from "./fleet-identity.js";

const same = (a: unknown, b: unknown) =>
  fleetPayloadDigest(a) === fleetPayloadDigest(b);
const refused = () =>
  new Problem(403, "The directory exchange is outside an enrolled grant.");

/** Prove a sender's admission from current trust without installing the proof. */
export function fleetDirectoryIntroduces(
  local: SignedFleetDirectory,
  sender: MachineIdentity,
  admission: SignedFleetDirectory[] | undefined,
) {
  if (!admission || local.document.tombstones.includes(sender.machineId))
    return false;
  const head = directoryDigest(local.document);
  let last = local,
    connected = false;
  for (const entry of admission) {
    if (!connected) {
      if (directoryDigest(entry.document) === head) {
        connected = true;
        continue;
      }
      if (entry.document.parent !== head) continue;
      connected = true;
    }
    last = verifyDirectorySuccessor(entry, last.document);
  }
  return (
    connected &&
    last.document.members.some(
      (m) =>
        m.machineId === sender.machineId && m.publicKey === sender.publicKey,
    )
  );
}

/** Authenticate a page against the caller's exact request. This does not make
 * an unanchored page authoritative; install only a chain reaching local trust. */
export function verifyFleetHistoryResponse(
  input: SignedFleetHistoryQuery,
  response: unknown,
): SignedFleetHistoryPage {
  const { query } = SignedFleetHistoryQuery.parse(input);
  const value = SignedFleetHistoryPage.parse(response),
    page = value.page;
  if (
    !same(page.destination, query.destination) ||
    page.queryDigest !== fleetPayloadDigest(query) ||
    !verifyFleetProof(
      query.destination,
      "directory-history",
      page,
      value.signature,
    ) ||
    directoryDigest(page.entries[0].document) !== (query.cursor ?? page.head)
  )
    throw refused();
  for (let i = page.entries.length - 1; i >= 0; i--) {
    const entry = verifyApprovedDirectory(page.entries[i]);
    if (i + 1 < page.entries.length)
      verifyDirectorySuccessor(entry, page.entries[i + 1].document);
  }
  const last = page.entries.at(-1)!;
  const next = last.document.kind === "recovery" ? null : last.document.parent;
  if (page.next !== next) throw refused();
  return value;
}

/** An acknowledgement proves receipt of this exact signed chain, not global
 * freshness. A higher remote head still needs independently verified history. */
export function verifyFleetDirectoryAck(
  input: SignedFleetDirectoryPush,
  anchor: SignedFleetDirectory,
  response: unknown,
): SignedFleetDirectoryAck {
  const { push } = SignedFleetDirectoryPush.parse(input);
  const value = SignedFleetDirectoryAck.parse(response),
    ack = value.ack;
  if (
    push.anchor !== directoryDigest(anchor.document) ||
    !same(ack.destination, push.destination) ||
    ack.requestDigest !== fleetPayloadDigest(push) ||
    !verifyFleetProof(push.destination, "directory-ack", ack, value.signature)
  )
    throw refused();
  let last = anchor;
  for (const entry of push.entries)
    last = verifyDirectorySuccessor(entry, last.document);
  if (ack.requested !== directoryDigest(last.document)) throw refused();
  const accepted = [anchor, ...push.entries].find(
    (entry) => directoryDigest(entry.document) === ack.accepted,
  );
  if (
    !accepted ||
    (ack.accepted !== ack.requested &&
      (ack.state !== "removed" ||
        !accepted.document.tombstones.includes(push.destination.machineId)))
  )
    throw refused();
  return value;
}

/** Verified replica exchange. It has no device session, owner parameter on the
 * wire, directory signing power or network transport. Unknown histories and
 * unbound destinations require explicit local consent instead of implicit join. */
export class FleetDirectorySync {
  private readonly proof: FleetProof;
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly owner: string,
    secrets: Parameters<typeof initializeFleetIdentity>[1],
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
  }
  private member(directory: SignedFleetDirectory, peer: MachineIdentity) {
    return directory.document.members.some(
      (m) => m.machineId === peer.machineId && m.publicKey === peer.publicKey,
    );
  }

  private removalHead(local: SignedFleetDirectory, sender: MachineIdentity) {
    if (!local.document.tombstones.includes(sender.machineId)) throw refused();
    const rows = fleetRemovalHistoryQueries.forPeer(
      this.db,
      this.owner,
      sender.machineId,
      sender.publicKey,
      local.document.fleetId,
    ) as { digest: string; parent_digest: string }[];
    for (const row of rows) {
      const parent = this.authority.directory(this.owner, row.parent_digest),
        removed = this.authority.directory(this.owner, row.digest);
      if (
        !parent ||
        !removed ||
        !this.member(parent, sender) ||
        this.member(removed, sender) ||
        !removed.document.tombstones.includes(sender.machineId)
      )
        continue;
      // The migration indexes stored history too. Recheck its authority before
      // using that index as an authorization exception for a removed caller.
      verifyDirectorySuccessor(removed, parent.document);
      return row.digest;
    }
    throw refused();
  }

  /** Already signed history may be obtained from any currently authorized
   * replica, without a phone, controller or unexpired access credential. The
   * machine proof cannot grant workspace reads or enlarge local scope. */
  history(input: SignedFleetHistoryQuery): SignedFleetHistoryPage {
    const value = SignedFleetHistoryQuery.parse(input),
      query = value.query;
    const local = this.authority.status(this.owner);
    if (
      !local.directory ||
      local.state === "removed" ||
      !same(query.destination, this.authority.identity) ||
      query.sender.machineId === this.authority.identity.machineId ||
      !verifyFleetProof(query.sender, "directory-query", query, value.signature)
    )
      throw refused();
    const enrolled =
      this.member(local.directory, query.sender) ||
      fleetDirectoryIntroduces(local.directory, query.sender, query.admission);
    const head = enrolled
      ? local.head!
      : this.removalHead(local.directory, query.sender);
    const approved = enrolled
      ? local.directory
      : this.authority.directory(this.owner, head)!;
    // An explicit cursor cannot cross a recovery reset or expose a different
    // retained lineage, even to a member enrolled in the current directory.
    if (
      query.cursor &&
      !(
        approved.document.kind !== "recovery" &&
        approved.document.parent === query.cursor
      ) &&
      !this.authority.ancestor(this.owner, head, query.cursor)
    )
      throw refused();
    let cursor: string | null = query.cursor ?? head;
    const entries: SignedFleetDirectory[] = [];
    let bytes = 0;
    for (let count = 0; cursor && count < 32; count++) {
      const entry = this.authority.directory(this.owner, cursor);
      if (!entry) {
        if (!entries.length)
          throw new Problem(404, "The directory cursor is not stored here.");
        // Explicit enrollment/recovery can pin a head without its predecessors.
        // Absence is not evidence of a genesis or of another replica's state.
        break;
      }
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      // Keep room below the signing primitive's one-MiB input ceiling even
      // with a full roster, long canonical origins and retained tombstones.
      if (bytes + size > 768 * 1024) {
        if (!entries.length)
          throw new Problem(
            503,
            "The directory exceeds the history page limit.",
          );
        break;
      }
      bytes += size;
      entries.push(entry);
      // Recovery is an explicit trust reset. Keep its named prior lineage in
      // the document, but never advertise that edge as an ordinary successor.
      cursor =
        entry.document.kind === "recovery" ? null : entry.document.parent;
    }
    const page = SignedFleetHistoryPage.shape.page.parse({
      version: 1,
      queryDigest: fleetPayloadDigest(query),
      destination: this.authority.identity,
      head,
      entries,
      next: cursor,
    });
    return { page, signature: this.proof.sign("directory-history", page) };
  }

  private authorizePush(push: SignedFleetDirectoryPush["push"]) {
    const local = this.authority.status(this.owner);
    if (!local.directory)
      throw new Problem(
        409,
        "Directory synchronization requires completed local enrollment.",
      );
    const anchor = this.authority.directory(this.owner, push.anchor);
    if (
      !anchor ||
      anchor.document.fleetId !== local.directory.document.fleetId ||
      local.directory.document.tombstones.includes(push.sender.machineId)
    )
      throw refused();
    let predecessor = anchor;
    let connects = push.anchor === local.head;
    for (const entry of push.entries) {
      predecessor = verifyDirectorySuccessor(entry, predecessor.document);
      if (directoryDigest(predecessor.document) === local.head) connects = true;
    }
    // A new sender may relay its admission only through the current local
    // authority. Membership in a retained, pre-recovery roster is insufficient.
    if (
      !this.member(local.directory, push.sender) &&
      !(connects && this.member(predecessor, push.sender)) &&
      !fleetDirectoryIntroduces(local.directory, push.sender, [
        ...push.entries,
        ...(push.admission ?? []),
      ])
    )
      throw refused();
    return predecessor;
  }

  /** All successors and the sender's proof are verified before changing local
   * grants. Known ancestors are harmless; a fork never becomes a partial update.
   * A removal is the final grant update for the removed destination. */
  receive(input: SignedFleetDirectoryPush): SignedFleetDirectoryAck {
    const value = SignedFleetDirectoryPush.parse(input),
      push = value.push;
    if (
      !same(push.destination, this.authority.identity) ||
      push.sender.machineId === this.authority.identity.machineId ||
      !verifyFleetProof(push.sender, "directory-sync", push, value.signature)
    )
      throw refused();
    // Reads authenticate membership before acquiring the database writer lock.
    // The transaction repeats the decision against the current accepted head.
    this.authorizePush(push);
    return this.db
      .transaction(() => {
        const predecessor = this.authorizePush(push);
        let accepted = push.anchor;
        for (const entry of push.entries) {
          const digest = directoryDigest(entry.document);
          const current = this.authority.status(this.owner);
          if (
            current.state === "removed" &&
            !this.authority.directory(this.owner, digest)
          )
            break;
          this.authority.accept(this.owner, entry);
          accepted = digest;
        }
        const current = this.authority.status(this.owner);
        if (!current.directory) throw refused();
        if (current.state === "removed") {
          // Pending repairs must not retain usable consent after local removal.
          fleetEnrollmentsQueries.cancelPreparedDestinations(
            this.db,
            this.owner,
          );
        }
        const ack = SignedFleetDirectoryAck.shape.ack.parse({
          version: 1,
          requestDigest: fleetPayloadDigest(push),
          destination: this.authority.identity,
          requested: directoryDigest(predecessor.document),
          accepted,
          head: current.head,
          state: current.state,
        });
        return { ack, signature: this.proof.sign("directory-ack", ack) };
      })
      .immediate();
  }
}
