// Shared with the thread Feed and the bulk project Status projection. `c` is
// an owner-scoped conversation; @now is the read's single observation time.
export const feedNeeds = `(c.feed_run_state IN ('awaiting_approval','paused') OR (c.feed_run_raw_state IN ('failed','interrupted') AND c.feed_run_dismissed_at IS NULL) OR COALESCE(c.feed_approval_until,0)>@now)`;
export const feedWorking = `c.feed_run_state IN ('running','pausing','waiting_children')`;
