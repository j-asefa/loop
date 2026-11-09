export type FeedPosition = {
  conversation_id: string;
  done_card_key?: string;
  reply_card_key?: string;
  last_activity_at: number;
};

const orderFields = ["at", "conversation", "card"] as const;
type OrderFields<T> = Record<(typeof orderFields)[number], T>;
const position = (item: FeedPosition): OrderFields<string | number> => ({
  at: item.last_activity_at,
  conversation: item.conversation_id,
  card: item.reply_card_key || item.done_card_key || "",
});

export function feedItemOrder(a: FeedPosition, b: FeedPosition) {
  const left = position(a),
    right = position(b);
  for (const field of orderFields) {
    if (left[field] !== right[field])
      return left[field] < right[field] ? 1 : -1;
  }
  return 0;
}

// Callers supply static SQL columns for the same descending tuple.
export const feedOrderSql = (columns: OrderFields<string>) =>
  orderFields.map((field) => `${columns[field]} DESC`).join(",");
