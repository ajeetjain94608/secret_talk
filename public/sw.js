// Service worker: enables push notifications to arrive even when this site
// isn't open in any tab. Deliberately generic — the payload never contains
// who sent a message or what it says.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'amazon', body: 'Your order status has updated.' };
  try {
    if (event.data) data = event.data.json();
  } catch (err) {
    // fall back to the default above
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'amazon', {
      body: data.body || 'Your order status has updated.',
      tag: 'amazon-update', // collapses multiple pending pushes into one
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
