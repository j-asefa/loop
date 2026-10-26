export const UNKNOWN_RUN_FAILURE =
  "Loop could not complete this run. A specific cause was not recorded. Review any saved progress before retrying.";

/** Older workers discarded the cause but promised details that did not exist. */
export function runErrorText(error?: string | null) {
  return error &&
    /^The run stopped during .+ \(Error\)\. Open failure details to inspect the saved progress\.$/.test(
      error,
    )
    ? UNKNOWN_RUN_FAILURE
    : error;
}
