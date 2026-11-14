/** Require every member of a closed union to be handled by the caller. */
export function assertNever(_value: never): never {
  throw new Error("Unhandled closed-set variant");
}
