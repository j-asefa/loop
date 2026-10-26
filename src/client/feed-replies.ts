type ReplyPage = {
  items: unknown[];
  next: string | null;
  summary: { replies_unread?: number };
};

/** Confirm an older source through a successful ordinary Feed read. Auth,
 * outages and invalid pagination remain errors, never "no replies". Re-probe
 * on the next refresh so upgrading a source needs no browser reload. */
export async function readReplyFeedPage<P extends ReplyPage>(
  read: (before?: string) => Promise<P>,
  operational: () => Promise<P>,
  before?: string,
): Promise<{ page: P; supported: boolean }> {
  let page: P;
  try {
    page = await read(before);
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (before || (status !== 400 && status !== 404)) throw error;
    page = await operational();
    if (typeof page.summary.replies_unread === "number") throw error;
  }
  const supported = typeof page.summary.replies_unread === "number";
  // Some old sources may accept an unknown filter and return ordinary output.
  // Only a source advertising Replies may supply cards for this tab.
  return {
    page: supported ? page : { ...page, items: [], next: null },
    supported,
  };
}
