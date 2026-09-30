export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
    public diagnostic?: Record<string, unknown>,
  ) {
    super(message);
  }
}
