/* Runs inside Loop's service worker, including when the app is closed. */
self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data?.json() || {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(message.title || "New result in Loop", {
      body: message.body || "Your agent has finished some work.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: message.tag || "loop-result",
      data: { url: message.url || "/" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const destination = new URL(
        event.notification.data?.url || "/",
        self.location.origin,
      );
      if (destination.origin !== self.location.origin) return;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // An open Loop window opens the link in place: it is focused, then
      // asked to show the thread. navigate() is not available everywhere
      // (and fails for a window this worker does not control), so it is only
      // a fallback for a window that cannot be messaged.
      for (const client of windows) {
        if (new URL(client.url).origin !== destination.origin) continue;
        await client.focus().catch(() => {});
        if (typeof client.postMessage === "function") {
          client.postMessage({ type: "loop-open", url: destination.href });
          return;
        }
        try {
          await client.navigate(destination.href);
          return;
        } catch {}
      }
      await self.clients.openWindow(destination.href);
    })(),
  );
});
