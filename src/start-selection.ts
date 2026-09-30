/** Automatic selection is ephemeral; explicit options and saved choices win. */
export function automaticManagedStart(
  action: string,
  options: { direct?: boolean; providers?: string; execution?: string },
  preferences: { providers?: string; execution?: string },
): boolean {
  return (
    action === "start" &&
    !options.direct &&
    !options.providers &&
    !options.execution &&
    !preferences.providers &&
    !preferences.execution
  );
}
