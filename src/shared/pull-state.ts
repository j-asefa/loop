import { z } from "zod";
/**
 * A thread's pull request as its watch last observed it: which head GitHub
 * reported, what the checks concluded for which head, and when Loop last
 * looked. A card shows this as one line. It is what the watch read, as
 * fresh as its last poll; Loop never claims more than that.
 */
export const PullStateSchema = z.object({
  repo_owner: z.string(),
  repo_name: z.string(),
  number: z.number(),
  watch: z.enum(["watching", "paused", "stopped"]),
  ended_reason: z.string().nullable(),
  error: z.string().nullable(),
  head_sha: z.string().nullable(),
  // Last concluded checks and the head they describe.
  ci: z
    .object({ sha: z.string(), conclusion: z.enum(["success", "failure"]) })
    .nullable(),
  // Checks for the current head had not all finished at the last read.
  pending: z.boolean(),
  // Last successful read; null before any successful read.
  checked_at: z.number().nonnegative().nullable(),
});
export type PullState = z.infer<typeof PullStateSchema>;

export type WatchRow = {
  repo_owner: string;
  repo_name: string;
  number: number;
  state: "watching" | "paused" | "stopped";
  ended_reason: string | null;
  error: string | null;
  head_sha: string | null;
  ci_sha: string | null;
  ci_conclusion: string | null;
  ci_pending: number;
  read_at: number | null;
  /** The result the last read saw, which may still be waiting for delivery. */
  seen_ci_sha: string | null;
  seen_ci_conclusion: string | null;
};

export function pullStateFromWatch(watch: WatchRow): PullState {
  // The card shows what the watch last saw, delivered to the thread or not.
  const sha = watch.seen_ci_sha ?? watch.ci_sha;
  const raw = watch.seen_ci_sha
    ? watch.seen_ci_conclusion
    : watch.ci_conclusion;
  const conclusion =
    raw === "success" || raw === "failure"
      ? (raw as "success" | "failure")
      : null;
  const concluded = sha && conclusion ? { sha, conclusion } : null;
  return {
    repo_owner: watch.repo_owner,
    repo_name: watch.repo_name,
    number: watch.number,
    watch: watch.state,
    ended_reason: watch.ended_reason,
    error: watch.error,
    head_sha: watch.head_sha,
    ci: concluded,
    pending: !!watch.ci_pending,
    checked_at: watch.read_at,
  };
}
