import { errorFacts } from "../shared/diagnostics.js";

export function reportBackgroundFailure(task: string, error: unknown) {
  console.warn(
    JSON.stringify({
      diagnostic: "background-task-failed",
      task,
      ...errorFacts(error),
    }),
  );
}
