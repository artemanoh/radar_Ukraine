/**
 * services/pushService.js
 * Сервіс Web Push сповіщень для системи «РАДАР — Національний моніторинг повітряного простору».
 * 
 * Забезпечує:
 * 1. Управління VAPID-ключами (з .env або автогенерація у .vapid.json).
 * 2. Збереження та фільтрацію push-підписок за територіями (області/райони).
 * 3. Відправку фонових сповіщень при переході станів (NORMAL -> ALERT, ALERT -> CLEAR).
 * 4. Підтримку критичних (urgency: 'high', requireInteraction) та екстрених оповіщень.
 * 5. Дедуплікацію та захист від спаму при опитуванні/реконекті.
 */

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

class PushService {
  constructor() {
    this.vapidPublicKey = '';
    this.vapidPrivateKey = '';
    this.vapidSubject = 'mailto:radar-alerts@monit.ua';
    this.subscriptions = new Map(); // endpoint -> subscriptionRecord
    this.sentFingerprints = new Map(); // fingerprint -> timestamp
    this.activeAlerts = new Map(); // key -> alertState
    this.isInitialSync = true;
    this.storagePath = path.resolve(__dirname, '..', 'data', 'subscriptions.json');
    this.saveTimeout = null;
  }

  init(app) {
    this.setupVapidKeys();
    this.loadSubscriptions();
    this.setupRoutes(app);
    this.startCleanupInterval();
    console.log(`[PUSH-SERVICE] Ініціалізовано. Активних підписок: ${this.subscriptions.size}`);
  }

  setupVapidKeys() {
    let pub = (process.env.VAPID_PUBLIC_KEY || '').trim();
    let priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
    const subj = (process.env.VAPID_SUBJECT || 'mailto:radar-alerts@monit.ua').trim();

    const vapidFile = path.resolve(__dirname, '..', '.vapid.json');

    if (!pub || !priv) {
      if (fs.existsSync(vapidFile)) {
        try {
          const content = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
          pub = content.publicKey;
          priv = content.privateKey;
        } catch (e) {
          console.warn('[PUSH-SERVICE] Не вдалося зчитати .vapid.json:', e.message);
        }
      }
    }

    if (!pub || !priv) {
      console.log('[PUSH-SERVICE] VAPID-ключі не знайдено. Генеруємо нову пару...');
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey;
      priv = keys.privateKey;
      try {
        fs.writeFileSync(vapidFile, JSON.stringify({ publicKey: pub, privateKey: priv }, null, 2), 'utf8');
        console.log('[PUSH-SERVICE] Нову VAPID-пару збережено в .vapid.json');
      } catch (err) {
        console.warn('[PUSH-SERVICE] Не вдалося зберегти .vapid.json:', err.message);
      }
    }

    this.vapidPublicKey = pub;
    this.vapidPrivateKey = priv;
    this.vapidSubject = subj;

    try {
      webpush.setVapidDetails(this.vapidSubject, this.vapidPublicKey, this.vapidPrivateKey);
      console.log('[PUSH-SERVICE] VAPID успішно налаштовано.');
    } catch (err) {
      console.error('[PUSH-SERVICE] Помилка налаштування VAPID details:', err.message);
    }
  }

  loadSubscriptions() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item && item.endpoint && item.subscription) {
              this.subscriptions.set(item.endpoint, item);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[PUSH-SERVICE] Помилка завантаження subscriptions.json:', err.message);
    }
  }

  saveSubscriptionsDebounced() {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      try {
        const dir = path.dirname(this.storagePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const data = Array.from(this.subscriptions.values());
        fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf8');
      } catch (err) {
        console.warn('[PUSH-SERVICE] Помилка збереження subscriptions.json:', err.message);
      }
    }, 1000);
  }

  startCleanupInterval() {
    // Очищення старих відбитків подій раз на 4 години
    const timer = setInterval(() => {
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000;
      for (const [fp, time] of this.sentFingerprints.entries()) {
        if (now - time > maxAge) {
          this.sentFingerprints.delete(fp);
        }
      }
    }, 4 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  setupRoutes(app) {
    // 1. Отримати публічний VAPID-ключ для створення підписки у клієнті
    app.get('/api/v1/push/vapid-public-key', (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.json({
        status: 'ok',
        publicKey: this.vapidPublicKey
      });
    });

    // 2. Зберегти або оновити Push-підписку
    app.post('/api/v1/push/subscribe', (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const { subscription, territory, district, showEntireRegion, filters } = req.body || {};

      if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ error: 'Некоректний об’єкт підписки PushSubscription' });
      }

      const endpoint = subscription.endpoint;
      const record = {
        endpoint,
        subscription,
        territory: (territory || 'all').trim(),
        district: (district || 'all').trim(),
        showEntireRegion: showEntireRegion !== false,
        filters: {
          notificationsEnabled: filters?.notificationsEnabled !== false,
          criticalAlertsEnabled: filters?.criticalAlertsEnabled !== false,
          officialAlertsEnabled: filters?.officialAlertsEnabled !== false,
          urgentThreatsEnabled: filters?.urgentThreatsEnabled !== false,
          targetAlertsEnabled: filters?.targetAlertsEnabled !== false,
          infoMessagesEnabled: filters?.infoMessagesEnabled !== false,
          aiNotificationsEnabled: filters?.aiNotificationsEnabled === true,
          quietHours: filters?.quietHours === true
        },
        updatedAt: Date.now()
      };

      this.subscriptions.set(endpoint, record);
      this.saveSubscriptionsDebounced();

      res.status(200).json({
        status: 'ok',
        message: 'Push-підписку успішно зареєстровано',
        totalSubscriptions: this.subscriptions.size
      });
    });

    // 3. Видалити Push-підписку (відписка)
    app.post('/api/v1/push/unsubscribe', (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const { endpoint } = req.body || {};
      if (endpoint && this.subscriptions.has(endpoint)) {
        this.subscriptions.delete(endpoint);
        this.saveSubscriptionsDebounced();
      }
      res.json({ status: 'ok', message: 'Підписку видалено' });
    });

    // 4. Тестовий Push для перевірки доставки при закритій вкладці
    app.post('/api/v1/push/test', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const { endpoint, isUrgent, title, body } = req.body || {};

      let targets = [];
      if (endpoint && this.subscriptions.has(endpoint)) {
        targets.push(this.subscriptions.get(endpoint));
      } else {
        targets = Array.from(this.subscriptions.values());
      }

      if (targets.length === 0) {
        return res.status(404).json({
          status: 'error',
          error: 'Не знайдено жодної активної підписки. Спочатку увімкніть сповіщення в налаштуваннях.'
        });
      }

      const testPayload = {
        title: title || (isUrgent ? '🚨 ТЕСТ КРИТИЧНОГО ОПОВІЩЕННЯ RADAR' : 'РАДАР — Тестове сповіщення'),
        body: body || 'Тестове push-сповіщення: система фонового моніторингу повітряного простору активна.',
        isCritical: isUrgent === true,
        priority: isUrgent ? 'CRITICAL' : 'NORMAL',
        type: isUrgent ? 'OFFICIAL_ALERT' : 'INFO',
        territory: 'Україна',
        tag: `test-push-${Date.now()}`,
        timestamp: Date.now()
      };

      let sentCount = 0;
      let failedCount = 0;

      for (const target of targets) {
        try {
          await this.sendToSubscriber(target, testPayload);
          sentCount++;
        } catch (e) {
          failedCount++;
        }
      }

      res.json({
        status: 'ok',
        message: `Тестове сповіщення відправлено: успішно ${sentCount}, помилок ${failedCount}`,
        sent: sentCount
      });
    });

    // 5. Статус push-сервісу
    app.get('/api/v1/push/status', (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.json({
        status: 'ok',
        subscribersCount: this.subscriptions.size,
        hasVapidKey: Boolean(this.vapidPublicKey),
        fingerprintsTracked: this.sentFingerprints.size
      });
    });
  }

  /**
   * Перевіряє, чи підходить територія події під фільтри конкретного підписника
   */
  matchesSubscriber(subscriber, territoryName, districtName = null) {
    if (!subscriber || !subscriber.filters || subscriber.filters.notificationsEnabled === false) {
      return false;
    }

    const subTerritory = (subscriber.territory || 'all').toLowerCase();
    if (subTerritory === 'all') {
      return true; // Користувач слухає всю Україну
    }

    const tNorm = (territoryName || '').toLowerCase();
    const dNorm = (districtName || '').toLowerCase();

    // Якщо користувач підписаний на конкретний район
    const subDistrict = (subscriber.district || 'all').toLowerCase();
    if (subDistrict !== 'all') {
      // Подія для конкретного району
      if (dNorm && (dNorm === subDistrict || dNorm.includes(subDistrict) || subDistrict.includes(dNorm))) {
        return true;
      }
      if (tNorm && (tNorm === subDistrict || tNorm.includes(subDistrict) || subDistrict.includes(tNorm))) {
        return true;
      }
      // Якщо це загальна обласна тривога, і увімкнено showEntireRegion
      if (subscriber.showEntireRegion !== false) {
        if (tNorm.includes(subTerritory) || subTerritory.includes(tNorm)) {
          return true;
        }
      }
      return false;
    }

    // Підписка на область
    if (tNorm && (tNorm.includes(subTerritory) || subTerritory.includes(tNorm))) {
      return true;
    }
    if (dNorm && (dNorm.includes(subTerritory) || subTerritory.includes(dNorm))) {
      return true;
    }

    return false;
  }

  /**
   * Відправка повідомлення одному підписнику
   */
  async sendToSubscriber(subscriber, payload) {
    const jsonStr = JSON.stringify(payload);
    const options = {
      TTL: 3600, // 1 година
      urgency: payload.isCritical ? 'high' : 'normal'
    };

    try {
      await webpush.sendNotification(subscriber.subscription, jsonStr, options);
    } catch (err) {
      // Якщо підписка недійсна або відкликана браузером (410 або 404), видаляємо її
      if (err.statusCode === 410 || err.statusCode === 404) {
        this.subscriptions.delete(subscriber.endpoint);
        this.saveSubscriptionsDebounced();
      }
      throw err;
    }
  }

  /**
   * Широкомовна відправка push-події підписникам з урахуванням фільтрації території
   */
  async broadcastEvent(eventData) {
    const { type, territory, district, title, body, isCritical, tag, fingerprint } = eventData;

    // Дедуплікація: перевіряємо стабільний fingerprint
    if (fingerprint) {
      if (this.sentFingerprints.has(fingerprint)) {
        return; // Подію вже було відправлено, ігноруємо дубль
      }
      this.sentFingerprints.set(fingerprint, Date.now());
    }

    const payload = {
      title,
      body,
      isCritical: isCritical === true,
      priority: isCritical ? 'CRITICAL' : 'NORMAL',
      type: type || 'INFO',
      territory: territory || '',
      tag: tag || `radar-${Date.now()}`,
      timestamp: Date.now()
    };

    const promises = [];
    for (const sub of this.subscriptions.values()) {
      if (this.matchesSubscriber(sub, territory, district)) {
        // Перевіряємо тип події у фільтрах підписника
        if (type === 'OFFICIAL_ALERT' && sub.filters.officialAlertsEnabled === false) continue;
        if (type === 'EMERGENCY_THREAT' && sub.filters.urgentThreatsEnabled === false) continue;
        if (isCritical && sub.filters.criticalAlertsEnabled === false) continue;

        promises.push(this.sendToSubscriber(sub, payload).catch(() => null));
      }
    }

    await Promise.all(promises);
  }

  /**
   * Обробка реальної зміни станів офіційних тривог (з NEPTUN / alerts.in.ua).
   * Викликається при отриманні актуального snapshot тривог.
   */
  handleAlertStateTransitions(incomingAlerts) {
    // incomingAlerts: масив об'єктів { key, name, oblast, since, level, status }
    if (!incomingAlerts || !Array.isArray(incomingAlerts)) return;

    const incomingMap = new Map();
    for (const a of incomingAlerts) {
      const key = a ? (a.key || a.location_uid || a.name) : null;
      if (key) {
        incomingMap.set(key, { ...a, key });
      }
    }

    // При першому запуску сервера зберігаємо початковий стан без спаму підписникам
    if (this.isInitialSync) {
      this.activeAlerts = incomingMap;
      this.isInitialSync = false;
      return;
    }

    // 1. Поява нових тривог (NORMAL -> ACTIVE ALERT)
    for (const [key, alert] of incomingMap.entries()) {
      if (!this.activeAlerts.has(key)) {
        // Нова тривога!
        const territoryName = alert.name || alert.oblast || 'Україна';
        const fp = `ALERT:${key}:${alert.since || alert.started_at || 'now'}`;

        this.broadcastEvent({
          type: 'OFFICIAL_ALERT',
          territory: alert.oblast || alert.name,
          district: alert.name && alert.name.toLowerCase().includes('район') ? alert.name : null,
          title: '🚨 ПОВІТРЯНА ТРИВОГА',
          body: `${territoryName} — оголошено повітряну тривогу! Прямуйте в укриття.`,
          isCritical: true,
          tag: `alert-${key}`,
          fingerprint: fp
        });
      }
    }

    // 2. Відбій тривог (ACTIVE ALERT -> FINISHED / CLEAR)
    for (const [key, oldAlert] of this.activeAlerts.entries()) {
      if (!incomingMap.has(key)) {
        // Відбій тривоги!
        const territoryName = oldAlert.name || oldAlert.oblast || 'Україна';
        const fp = `CLEAR:${key}:${Date.now()}`;

        this.broadcastEvent({
          type: 'CLEAR',
          territory: oldAlert.oblast || oldAlert.name,
          district: oldAlert.name && oldAlert.name.toLowerCase().includes('район') ? oldAlert.name : null,
          title: '✅ ВІДБІЙ ТРИВОГИ',
          body: `${territoryName} — відбій повітряної тривоги.`,
          isCritical: false,
          tag: `clear-${key}`,
          fingerprint: fp
        });
      }
    }

    this.activeAlerts = incomingMap;
  }

  /**
   * Обробка екстреної критичної загрози (наприклад, реальна ціль у зоні небезпеки)
   */
  handleEmergencyThreat(threat) {
    if (!threat || !threat.id) return;
    const fp = `EMERGENCY:${threat.id}:${threat.region || ''}:${threat.time || ''}`;

    this.broadcastEvent({
      type: 'EMERGENCY_THREAT',
      territory: threat.region || threat.oblast || '',
      district: threat.district || null,
      title: '⚠️ ЕКСТРЕНА НЕБЕЗПЕКА RADAR',
      body: `Повітряна ціль (${threat.title || threat.type || 'БпЛА/ракета'}) зафіксована у вашому напрямку!`,
      isCritical: true,
      tag: `emergency-${threat.id}`,
      fingerprint: fp
    });
  }

  getVapidPublicKey() {
    return this.vapidPublicKey;
  }

  getAllSubscriptions() {
    return Array.from(this.subscriptions.values());
  }

  saveSubscription(subscription, territory = 'all', district = 'all', showEntireRegion = true, filters = {}) {
    if (!subscription || !subscription.endpoint) return null;
    const endpoint = subscription.endpoint;
    const record = {
      endpoint,
      subscription,
      territory: (territory || 'all').trim(),
      district: (district || 'all').trim(),
      showEntireRegion: showEntireRegion !== false,
      filters: {
        notificationsEnabled: filters?.notificationsEnabled !== false,
        criticalAlertsEnabled: filters?.criticalAlertsEnabled !== false,
        officialAlertsEnabled: filters?.officialAlertsEnabled !== false,
        urgentThreatsEnabled: filters?.urgentThreatsEnabled !== false,
        targetAlertsEnabled: filters?.targetAlertsEnabled !== false,
        infoMessagesEnabled: filters?.infoMessagesEnabled !== false,
        aiNotificationsEnabled: filters?.aiNotificationsEnabled === true,
        quietHours: filters?.quietHours === true
      },
      updatedAt: Date.now()
    };
    this.subscriptions.set(endpoint, record);
    this.saveSubscriptionsDebounced();
    return record;
  }

  isSubscriptionMatchingTerritory(subscriber, territoryName, districtName = null) {
    return this.matchesSubscriber(subscriber, territoryName, districtName);
  }
}

const pushService = new PushService();
module.exports = pushService;

