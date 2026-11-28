// A thread page holds up to 50 messages, and long agent answers make each one
// expensive to lay out. The thread renders only its newest messages on open
// and reveals loaded earlier ones a step at a time before fetching more.
export const THREAD_RENDER_STEP = 12;

type WindowMessage = { id: string };

/** Index of the first rendered message. `firstVisibleId` pins the window once
 * the reader reveals earlier messages, so new replies extend it instead of
 * sliding older ones out. */
export function threadWindowStart(
  messages: readonly WindowMessage[],
  firstVisibleId: string | null,
  step = THREAD_RENDER_STEP,
): number {
  if (firstVisibleId) {
    const pinned = messages.findIndex((m) => m.id === firstVisibleId);
    if (pinned >= 0) return pinned;
  }
  return Math.max(0, messages.length - step);
}

/** The message that should start the window after revealing one more step. */
export function revealEarlierId(
  messages: readonly WindowMessage[],
  start: number,
  step = THREAD_RENDER_STEP,
): string | null {
  return messages[Math.max(0, start - step)]?.id ?? null;
}

type RunMessage = {
  id: string;
  role: string;
  run_id: string | null;
  content: string;
  run_state?: string | null;
};

/** Published files are fetched per run. Return only the runs whose newest
 * rendered message changed since the last fetch, with the signature to store. */
export function runFileRequests(
  messages: readonly RunMessage[],
  fetched: ReadonlyMap<string, string>,
): Array<{ runId: string; signature: string }> {
  const latest = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.run_id) continue;
    latest.set(m.run_id, `${m.id}:${m.content.length}:${m.run_state ?? ""}`);
  }
  return Array.from(latest, ([runId, signature]) => ({
    runId,
    signature,
  })).filter(({ runId, signature }) => fetched.get(runId) !== signature);
}
