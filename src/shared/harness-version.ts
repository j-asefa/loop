export function meetsMinimum(version: string | undefined, minimum: string) {
  if (!version) return false;
  const core = version.split("+")[0];
  // Keep prerelease identifiers: stripping them would silently admit betas.
  if (core.includes("-")) return false;
  const parts = core.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const floor = minimum.split(".").map(Number);
  for (let i = 0; i < floor.length; i++) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i];
  }
  return true;
}
