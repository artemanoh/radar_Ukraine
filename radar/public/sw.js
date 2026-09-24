// public/sw.js — Service Worker для PWA «РАДАР — Національний моніторинг повітряного простору»
const CACHE_NAME = 'radar-cache-v2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './assets/icons/app_icon.svg',
  './sounds/notification.mp3',
  './sounds/siren.mp3',
  './sounds/clear.mp3',
  './sounds/urgent.mp3'
];

// Встановлення Service Worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Активація та очищення старого кешу
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Обробка Web Push подій (від сервера/бекенду)
self.addEventListener('push', (event) => {
  let payload = {
    title: 'РАДАР — Сповіщення',
    body: 'Нова подія у повітряному просторі',
    tag: 'radar-alert',
    isUrgent: false
  };

  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (err) {
    if (event.data) {
      payload.body = event.data.text();
    }
  }

  const options = {
    body: payload.body,
    icon: payload.icon || './assets/icons/app_icon.svg',
    badge: './assets/icons/app_icon.svg',
    tag: payload.tag || 'radar-alert',
    renotify: true,
    requireInteraction: payload.isUrgent === true,
    data: {
      url: payload.url || './',
      time: Date.now()
    }
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, options)
  );
});

// Клік по сповіщенню
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
