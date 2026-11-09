export const DONE_CARD_PREFIX = "d:";
export const IDLE_DONE_KEY_PREFIX = "idle:";
export const doneCardId = (key: string) => DONE_CARD_PREFIX + key;
export const idleDoneKey = (conversation: string) =>
  IDLE_DONE_KEY_PREFIX + conversation;
