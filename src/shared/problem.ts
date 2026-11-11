type ProblemKind =
  | { readonly type: "request" }
  | {
      readonly type: "execution";
      readonly outcome: "refused" | "unknown" | "completed";
    };

export class Problem extends Error {
  readonly headers?: Readonly<Record<string, string>>;
  readonly kind: ProblemKind;

  constructor(
    public status: number,
    message: string,
    public diagnostic?: Record<string, unknown>,
    options: {
      headers?: Readonly<Record<string, string>>;
      kind?: ProblemKind;
    } = {},
  ) {
    super(message);
    this.headers = options.headers;
    this.kind = options.kind ?? { type: "request" };
  }
}

export class ExecutionProblem extends Problem {
  constructor(
    status: number,
    message: string,
    public readonly outcome: "refused" | "unknown" | "completed",
  ) {
    super(status, message, undefined, { kind: { type: "execution", outcome } });
  }
}
