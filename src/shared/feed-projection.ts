import { z } from "zod";

export type FeedIdentity = {
  conversation_id: string;
  done_card_key?: string | null;
  reply_card_key?: string;
};
export const feedProjectionId = (row: FeedIdentity) =>
  JSON.stringify([row.conversation_id, row.reply_card_key ?? row.done_card_key ?? null]);
export const FeedEntities = z.object({
  selection: z.string(),
  delta: z.boolean(),
  entities: z.array(z.object({ id: z.string(), signature: z.string(), revision: z.number().int().nonnegative().safe() })),
  removed: z.array(z.string()),
});
export type FeedEntities = z.infer<typeof FeedEntities>;
export type FeedProjectionPage<T> = {
  items: T[];
  projection?: { epoch: string; cursor: number };
  projectionRows?: FeedEntities;
};
/** One reducer per retained page, shared with the server's delta-equivalence
 * tests. Page metadata never advances a different page or source's cursor. */
export function reduceFeedPage<
  T extends FeedIdentity,
  P extends FeedProjectionPage<T>,
>(previous: P | undefined, incoming: P): P {
  const delta = incoming.projectionRows;
  if (!delta?.delta) return incoming;
  if (
    !previous?.projection ||
    previous.projection.epoch !== incoming.projection?.epoch
  )
    throw new Error("Feed delta needs its matching snapshot");
  if (incoming.projection.cursor < previous.projection.cursor) return previous;
  const revisions = new Map(
    previous.projectionRows?.entities.map((row) => [row.id, row.revision]),
  );
  const current = new Map(
    previous.items.map((row) => [feedProjectionId(row), row]),
  );
  for (const id of delta.removed) current.delete(id);
  const nextRevisions = new Map(
    delta.entities.map((row) => [row.id, row.revision]),
  );
  for (const row of incoming.items) {
    const id = feedProjectionId(row);
    if ((nextRevisions.get(id) ?? -1) >= (revisions.get(id) ?? -1))
      current.set(id, row);
  }
  return {
    ...incoming,
    items: delta.entities.map((row) => {
      const item = current.get(row.id);
      if (!item) throw new Error("Feed delta has a missing row");
      return item;
    }),
  };
}
