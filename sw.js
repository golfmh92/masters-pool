// PGA Pool Test - Service Worker for Push Notifications

self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'PGA Pool';
  const options = {
    body: data.body || '',
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
