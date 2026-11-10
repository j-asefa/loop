import { errorFacts } from "../../runtime/diagnostics.ts";

export function reportBackgroundFailure(task: string, error: unknown) {
  console.warn(
    JSON.stringify({
      diagnostic: "background-task-failed",
      task,
      ...errorFacts(error),
    }),
  );
}
