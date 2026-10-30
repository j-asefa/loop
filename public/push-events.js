/* Runs inside Loop55's service worker, including when the app is closed. */
self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data?.json() || {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(message.title || "New result in Loop55", {
      body: message.body || "Your agent has finished some work.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: message.tag || "loop55-result",
      data: { url: message.url || "/" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      let destination;
      try {
        destination = new URL(
          event.notification.data?.url || "/",
          self.location.origin,
        );
      } catch {
        return;
      }
      if (destination.origin !== self.location.origin) return;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Keep the destination in the URL so startup and sign-in can restore
      // it even if the app has no message listener yet. postMessage alone
      // can silently lose a click in a suspended or still-loading window.
      for (const client of windows) {
        if (new URL(client.url).origin !== destination.origin) continue;
        try {
          const opened = await client.navigate(destination.href);
          if (!opened) continue;
          await opened.focus().catch(() => {});
          return;
        } catch {}
      }
      await self.clients.openWindow(destination.href);
    })(),
  );
});
