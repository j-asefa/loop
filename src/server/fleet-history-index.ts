import type { SignedFleetDirectory } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";

type Entry = {
  digest: string;
  depth: number;
  parent?: Entry;
  jumps: Entry[];
  root: { digest: string; missing: string | null };
};

/** An index of immutable, verified local history, never peer-supplied cursors.
 * Each stored document is decoded once; ancestry checks use binary lifting.
 * A recovery has no ancestry edge. Late predecessor retention rebuilds the
 * affected index before it can authorize an older cursor. */
export class FleetHistoryIndex {
  private readonly entries = new Map<string, Entry>();
  private generation = 0;
  constructor(
    private readonly read: (digest: string) => SignedFleetDirectory | undefined,
  ) {}

  private entry(digest: string): Entry | undefined {
    const cached = this.entries.get(digest);
    if (cached) {
      if (!cached.root.missing || !this.read(cached.root.missing))
        return cached;
      // History is append-only. The only change to an existing ancestry path
      // is filling a previously absent predecessor after explicit consent.
      this.entries.clear();
      this.generation++;
    }
    const pending: string[] = [];
    const visiting = new Set<string>();
    let at: string | null = digest;
    let parent: Entry | undefined;
    let missing: string | null = null;
    while (at) {
      if (visiting.has(at))
        throw new Problem(409, "Stored fleet history is cyclic.");
      visiting.add(at);
      const known = this.entries.get(at);
      if (known) {
        parent = this.entry(at);
        break;
      }
      const signed = this.read(at);
      if (!signed) {
        missing = at;
        break;
      }
      const next =
        signed.document.kind === "recovery" ? null : signed.document.parent;
      pending.push(at);
      at = next;
    }
    for (const item of pending.reverse()) {
      const jumps: Entry[] = parent ? [parent] : [];
      for (let level = 0; jumps[level]?.jumps[level]; level++)
        jumps.push(jumps[level].jumps[level]);
      const entry: Entry = {
        digest: item,
        depth: parent ? parent.depth + 1 : 0,
        parent,
        jumps,
        root: parent?.root ?? { digest: item, missing },
      };
      this.entries.set(item, entry);
      parent = entry;
    }
    return this.entries.get(digest);
  }

  prime(digests: Iterable<string>) {
    for (const digest of digests) this.entry(digest);
  }

  knownMissing(head: string, cursor: string) {
    // Preserve the 404 for a predecessor explicitly named by retained history.
    // An arbitrary absent cursor must never cause a new history traversal.
    return this.entries.get(head)?.root.missing === cursor;
  }

  contains(head: string, cursor: string) {
    let node = this.entry(head);
    const generation = this.generation;
    const target = this.entry(cursor);
    if (generation !== this.generation) node = this.entry(head);
    if (
      !node ||
      !target ||
      node.root !== target.root ||
      node.depth < target.depth
    )
      return false;
    let current: Entry = node;
    for (let level = current.jumps.length - 1; level >= 0; level--) {
      const next: Entry | undefined = current.jumps[level];
      if (next && next.depth >= target.depth) current = next;
    }
    return current.digest === cursor;
  }

  lineage(head: string) {
    const result = new Set<string>();
    for (let node = this.entry(head); node; node = node.parent)
      result.add(node.digest);
    return result;
  }
}
