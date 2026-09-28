import { activityKey, type ActivityRecord } from "../agent-activities";
export type ActivitySnapshot = {
  record: ActivityRecord;
  run_id: string | null;
};
/** Merge paginated durable snapshots without dropping previously loaded turns. */
export function mergeActivitySnapshots(
  previous: ActivitySnapshot[] = [],
  incoming: ActivitySnapshot[] = [],
) {
  const records = new Map(
    previous.map((entry) => [activityKey(entry.record, entry.run_id), entry]),
  );
  for (const entry of incoming) {
    const key = activityKey(entry.record, entry.run_id);
    const current = records.get(key);
    if (
      !current ||
      current.record.generation !== entry.record.generation ||
      current.record.revision <= entry.record.revision
    )
      records.set(key, entry);
  }
  return [...records.values()];
}
