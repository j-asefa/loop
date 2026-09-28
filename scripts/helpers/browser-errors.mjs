// Playwright's WebKit error parser can shorten Error.message at the URL's
// colon. The first stack line retains the complete browser diagnostic.
export function isWebKitNavigationFetchError(engine, error, base) {
  if (engine !== "webkit") return false;
  const diagnostic = error.stack?.split("\n", 1)[0] || error.message;
  return (
    diagnostic.startsWith(`Fetch API cannot load ${base}/api/`) &&
    diagnostic.endsWith(" due to access control checks.")
  );
}
