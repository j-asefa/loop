import { Problem } from "../shared/problem.js";

/** Only pre-dispatch guards may use this: no native effect was attempted.
 * Transport errors and failures after dispatch must retain an unknown receipt. */
export class ExecutionRefused extends Problem {
  constructor(
    status: number,
    message: string,
    diagnostic?: Record<string, unknown>,
  ) {
    super(status, message, diagnostic, {
      kind: { type: "execution", outcome: "refused" },
    });
  }
}
