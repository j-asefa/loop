import { createHash } from "node:crypto";
import { z } from "zod";
import { workspaceClock } from "./db.js";
import {
  feedProjectionId,
  type FeedIdentity,
  type FeedEntities,
} from "../shared/feed-projection.js";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const Known = z.object({
  epoch: z.string().max(200),
  selection: z.string().max(64),
  entities: z
    .array(
      z.object({
        id: z.string().max(1000),
        signature: z.string().max(64),
        revision: z.number().int().nonnegative().safe(),
      }),
    )
    .max(200),
});
/** The caller is inside projectionSnapshot. Client signatures select display
 * deltas only; all membership, filtering and authorization are read afresh. */
export function feedProjection<
  T extends FeedIdentity,
  P extends { items: T[] },
>(owner: string, selection: unknown, page: P, known: unknown) {
  const clock = workspaceClock(owner),
    key = digest(selection);
  let previous: z.infer<typeof Known> | undefined;
  if (typeof known === "string" && known.length <= 8192) {
    try {
      const result = Known.safeParse(JSON.parse(known));
      if (result.success) previous = result.data;
    } catch {
      /* Snapshot recovers malformed display state. */
    }
  }
  if (previous?.epoch !== clock.epoch || previous?.selection !== key)
    previous = undefined;
  const prior = new Map(previous?.entities.map((row) => [row.id, row]));
  const items: T[] = [];
  const entities = page.items.map((row) => {
    const id = feedProjectionId(row),
      signature = digest(row),
      old = prior.get(id);
    if (old?.signature !== signature) items.push(row);
    return {
      id,
      signature,
      revision: old?.signature === signature ? old.revision : clock.cursor,
    };
  });
  const present = new Set(entities.map((row) => row.id));
  const projectionRows: FeedEntities = {
    selection: key,
    delta: !!previous,
    entities,
    removed: [...prior.keys()].filter((id) => !present.has(id)),
  };
  return { ...page, items, projection: clock, projectionRows };
}
