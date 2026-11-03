// Only Loop-authored setup guidance belongs here, never raw provider/process
// errors. The worker may safely show this message without exposing credentials.
export class NativeSetupError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeSetupError";
  }
}
