import { errorFacts } from "../shared/diagnostics.js";

// Reports the task name and sanitized error type/code facts, never the thrown
// message.
export function reportBackgroundFailure(task: string, error: unknown) {
  console.warn(
    JSON.stringify({
      diagnostic: "background-task-failed",
      task,
      ...errorFacts(error),
    }),
  );
}
