export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
    public diagnostic?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class ExecutionProblem extends Problem {
  constructor(
    status: number,
    message: string,
    public outcome: "refused" | "unknown" | "completed",
  ) {
    super(status, message);
  }
}
