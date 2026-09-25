/**
 * sw.js
 * Service Worker для системи «РАДАР — Національний моніторинг повітряного простору».
 * 
 * Забезпечує:
 * 1. Background Web Push сповіщення навіть при повністю закритій вкладці / браузері у фоні.
 * 2. Обробку критичних (Critical / Time-sensitive) та екстрених оповіщень.
 * 3. Дедуплікацію та оновлення за унікальними тегами (tag).
 * 4. Навігацію та фокусування застосунку при натисканні (notificationclick).
 * 5. Підтримку GitHub Pages (динамічний scope).
 */

const SW_VERSION = 'radar-sw-v2.1';

// Встановлення та миттєва активація нового Service Worker
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.clients.claim().then(() => {
      console.log(`[RADAR-SW] Активовано версію ${SW_VERSION}`);
    })
  );
});

// Обробка отриманого Push-повідомлення
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = {
        title: 'РАДАР — Оновлення',
        body: event.data.text()
      };
    }
  } else {
    data = {
      title: 'РАДАР — Оповіщення',
      body: 'Отримано оперативне оновлення повітряного простору.'
    };
  }

  const isCritical = data.isCritical === true || data.priority === 'CRITICAL' || data.priority === 'EMERGENCY';
  const isClear = data.type === 'CLEAR';

  // Базовий шлях для іконок з урахуванням scope (підтримка як localhost, так і /radar_Ukraine/)
  const scopeUrl = new URL(self.registration.scope);
  const basePath = scopeUrl.pathname.endsWith('/') ? scopeUrl.pathname : `${scopeUrl.pathname}/`;
  
  const iconUrl = new URL(`${basePath}assets/icons/app_icon.svg`, self.location.origin).href;
  const badgeUrl = iconUrl;

  const defaultTag = isClear 
    ? `radar-clear-${Date.now()}` 
    : (data.tag || (isCritical ? 'radar-critical-alert' : 'radar-info'));

  // Налаштування для максимального рівня сповіщення на платформі
  const options = {
    body: data.body || '',
    icon: iconUrl,
    badge: badgeUrl,
    tag: defaultTag,
    renotify: isCritical || isClear, // повторна вібрація/звук при оновленні тегу
    requireInteraction: isCritical,   // тримати на екрані для критичних подій
    silent: false,
    timestamp: data.timestamp || Date.now(),
    data: {
      url: data.url || `${basePath}#alerts`,
      priority: data.priority || (isCritical ? 'CRITICAL' : 'NORMAL'),
      type: data.type || 'INFO',
      territory: data.territory || '',
      eventTime: data.eventTime || Date.now()
    },
    // Вібраційні патерни: тактичний тривожний ритм для критичних подій
    vibrate: isCritical
      ? [300, 100, 300, 100, 300, 100, 400]
      : (isClear ? [150, 100, 150] : [200, 100, 200]),
    actions: [
      {
        action: 'open-radar',
        title: 'Відкрити РАДАР'
      },
      {
        action: 'dismiss',
        title: 'Зрозуміло'
      }
    ]
  };

  const title = data.title || (isCritical ? '🚨 КРИТИЧНЕ ОПОВІЩЕННЯ RADAR' : 'РАДАР');

  event.waitUntil(
    self.registration.showNotification(title, options)
      .then(() => {
        // Оповіщаємо активні вкладки (якщо відкриті) про отримання push
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      })
      .then((clientList) => {
        for (const client of clientList) {
          client.postMessage({
            type: 'RADAR_PUSH_RECEIVED',
            payload: data,
            isCritical
          });
        }
      })
  );
});

// Обробка натискання на сповіщення
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') {
    return;
  }

  const notificationData = event.notification.data || {};
  const targetUrl = notificationData.url || self.registration.scope;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Якщо вкладка вже відкрита — фокусуємо її
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({
            type: 'RADAR_NOTIFICATION_CLICKED',
            data: notificationData
          });
          return;
        }
      }
      // Якщо жодної вкладки не відкрито — відкриваємо нове вікно
      if (self.clients.openWindow) {
        const fullTargetUrl = new URL(targetUrl, self.registration.scope).href;
        return self.clients.openWindow(fullTargetUrl);
      }
    })
  );
});

// Слухач повідомлень від клієнта
self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
