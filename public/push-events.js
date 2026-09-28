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
      for (const client of windows) {
        if (new URL(client.url).origin !== destination.origin) continue;
        await client.navigate(destination.href);
        await client.focus();
        return;
      }
      await self.clients.openWindow(destination.href);
    })(),
  );
});
