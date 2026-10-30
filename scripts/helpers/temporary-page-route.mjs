const pageStops = new WeakMap();

/** Disable an injection without removing the page interceptor. Playwright may
 * continue in-flight context routes when the last page route is removed,
 * bypassing response transforms and making their eventual fulfill fail.
 * Disabled handlers fall through and remain registered until the page closes. */
export async function temporaryPageRoute(page, pattern, handler) {
  let active = true;
  const pending = new Set();
  await page.route(pattern, (route) => {
    if (!active) return route.fallback();
    const request = Promise.resolve().then(() => handler(route));
    pending.add(request);
    return request.finally(() => pending.delete(request));
  });
  const stop = async () => {
    active = false;
    await Promise.all([...pending]);
  };
  const stops = pageStops.get(page) ?? [];
  stops.push(stop);
  pageStops.set(page, stops);
  return stop;
}

/** Drain while interceptors remain registered. unrouteAll(wait) clears its
 * route list first; one finishing callback can then disable interception while
 * another still owns an unfinished response. Only unroute after this settles. */
export async function drainPageRoutes(page) {
  await Promise.all((pageStops.get(page) ?? []).map((stop) => stop()));
  pageStops.delete(page);
}
