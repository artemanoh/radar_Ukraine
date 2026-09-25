/**
 * scripts/test_push_notifications.js
 * Verification of RADAR Background Notifications & Push Subsystem:
 * 1. VAPID key initialization
 * 2. Subscription storage and matching logic (territory, district, all)
 * 3. State transition engine (NORMAL -> ALERT -> CLEAR)
 * 4. Deduplication and anti-spam suppression
 * 5. Push payload formatting and critical/emergency prioritization
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pushService = require('../services/pushService');

async function runTests() {
  console.log('🧪 [TEST] Запуск тестів системи Web Push та фонових сповіщень RADAR...\n');

  // Тест 1: Перевірка ініціалізації VAPID
  console.log('--- 1. Перевірка VAPID ключів ---');
  const dummyApp = {
    get: () => {},
    post: () => {}
  };
  pushService.init(dummyApp);
  const vapidKey = pushService.getVapidPublicKey();
  assert.ok(vapidKey && typeof vapidKey === 'string' && vapidKey.length > 20, 'VAPID public key must be non-empty base64 string');
  console.log('✅ VAPID Public Key успішно згенеровано/завантажено:', vapidKey.slice(0, 16) + '...');

  // Тест 2: Підписка клієнтів з різними територіями
  console.log('\n--- 2. Реєстрація підписок і фільтрація за районами/областями ---');
  const mockSubKyivDistrict = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-kyiv-district-token',
    keys: { auth: 'authkey123', p256dh: 'p256dhkey123' }
  };
  const mockSubKyivAll = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-kyiv-all-token',
    keys: { auth: 'authkey456', p256dh: 'p256dhkey456' }
  };
  const mockSubOdesa = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-odesa-token',
    keys: { auth: 'authkey789', p256dh: 'p256dhkey789' }
  };
  const mockSubAllUkraine = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-all-token',
    keys: { auth: 'authkeyall', p256dh: 'p256dhkeyall' }
  };

  pushService.saveSubscription(mockSubKyivDistrict, 'Київська область', 'Білоцерківський район', true, {
    notificationsEnabled: true,
    criticalAlertsEnabled: true,
    officialAlertsEnabled: true,
    urgentThreatsEnabled: true
  });

  pushService.saveSubscription(mockSubKyivAll, 'Київська область', 'all', true, {
    notificationsEnabled: true,
    criticalAlertsEnabled: true,
    officialAlertsEnabled: true,
    urgentThreatsEnabled: true
  });

  pushService.saveSubscription(mockSubOdesa, 'Одеська область', 'all', true, {
    notificationsEnabled: true,
    criticalAlertsEnabled: true,
    officialAlertsEnabled: true,
    urgentThreatsEnabled: true
  });

  pushService.saveSubscription(mockSubAllUkraine, 'all', 'all', true, {
    notificationsEnabled: true,
    criticalAlertsEnabled: true,
    officialAlertsEnabled: true,
    urgentThreatsEnabled: true
  });

  // Перевірка збереження
  const subs = pushService.getAllSubscriptions();
  assert.ok(subs.length >= 4, `Очікувалось як мінімум 4 підписки, отримано: ${subs.length}`);
  console.log(`✅ Збережено підписок: ${subs.length}`);

  // Тест 3: Тестування зіставлення територій
  console.log('\n--- 3. Перевірка відповідності територій (Territory Matching) ---');
  const subKyivDist = subs.find(s => s.endpoint === mockSubKyivDistrict.endpoint);
  const subOdesaRecord = subs.find(s => s.endpoint === mockSubOdesa.endpoint);
  const subAllRecord = subs.find(s => s.endpoint === mockSubAllUkraine.endpoint);

  // 3.1. Загроза у Білоцерківському районі: має отримати Київ-район, Вся Україна, не має отримати Одеса
  assert.strictEqual(
    pushService.isSubscriptionMatchingTerritory(subKyivDist, 'Київська область', 'Білоцерківський район'),
    true,
    'Київ-район повинен отримувати тривогу свого району'
  );
  assert.strictEqual(
    pushService.isSubscriptionMatchingTerritory(subOdesaRecord, 'Київська область', 'Білоцерківський район'),
    false,
    'Одеса НЕ повинна отримувати тривогу Білоцерківського району'
  );
  assert.strictEqual(
    pushService.isSubscriptionMatchingTerritory(subAllRecord, 'Київська область', 'Білоцерківський район'),
    true,
    'Вся Україна повинна отримувати тривогу будь-якого району'
  );

  // 3.2. Обласна тривога у Київській області (без конкретного району)
  assert.strictEqual(
    pushService.isSubscriptionMatchingTerritory(subKyivDist, 'Київська область', null),
    true,
    'Користувач району з опцією showEntireRegionWithDistrict=true повинен отримувати загальнообласну тривогу'
  );

  // 3.3. Тривога в іншому районі Київської області (Бориспільський район)
  const subKyivStrict = { ...subKyivDist, showEntireRegion: false };
  assert.strictEqual(
    pushService.isSubscriptionMatchingTerritory(subKyivStrict, 'Київська область', 'Бориспільський район'),
    false,
    'Користувач суворого району НЕ повинен отримувати тривогу іншого району'
  );
  console.log('✅ Усі перевірки фільтрації за територіями та районами пройдено успішно!');

  // Тест 4: Перевірка State Transitions (NORMAL -> ALERT -> CLEAR)
  console.log('\n--- 4. Перевірка переходу станів тривог та дедуплікації ---');
  let dispatchedPushes = [];
  const originalSendToSubscriber = pushService.sendToSubscriber;
  pushService.sendToSubscriber = async (sub, payload) => {
    dispatchedPushes.push({ sub, payload });
    return { statusCode: 201 };
  };

  // Вимикаємо initialSync для емуляції активної роботи
  pushService.isInitialSync = false;

  // 4.1. Перша поява тривоги (NORMAL -> ALERT)
  const incomingAlerts = [
    {
      key: 'kyiv_oblast_alert',
      name: 'Білоцерківський район',
      oblast: 'Київська область',
      status: 'ACTIVE',
      alert_type: 'air_raid',
      since: new Date().toISOString()
    }
  ];

  await pushService.handleAlertStateTransitions(incomingAlerts);
  assert.ok(dispatchedPushes.length > 0, 'Повинно бути відправлено push-сповіщення при вході в тривогу');
  
  const alertPush = dispatchedPushes[0];
  assert.strictEqual(alertPush.payload.isCritical, true, 'Офіційна тривога повинна бути позначена як isCritical=true');
  assert.ok(alertPush.payload.title.includes('ПОВІТРЯНА ТРИВОГА'), 'Заголовок має містити слово ПОВІТРЯНА ТРИВОГА');
  console.log(`✅ Подія початку тривоги успішно сформована: "${alertPush.payload.title}" (${dispatchedPushes.length} пушів відправлено)`);

  // 4.2. Повторне опитування з тими самими тривогами (Дедуплікація / Захист від спаму)
  const initialPushCount = dispatchedPushes.length;
  await pushService.handleAlertStateTransitions(incomingAlerts);
  assert.strictEqual(
    dispatchedPushes.length,
    initialPushCount,
    'При незмінному стані активної тривоги дедуплікація не повинна відправляти повторні пуші'
  );
  console.log('✅ Дедуплікація активна: 0 спам-повідомлень при повторному опитуванні');

  // 4.3. Відбій тривоги (ALERT -> CLEAR)
  await pushService.handleAlertStateTransitions([]); // порожній список активних тривог = відбій
  assert.ok(dispatchedPushes.length > initialPushCount, 'При знятті тривоги має бути відправлено push про відбій');
  
  const clearPush = dispatchedPushes[dispatchedPushes.length - 1];
  assert.ok(clearPush.payload.title.includes('ВІДБІЙ'), 'Заголовок має містити слово ВІДБІЙ');
  console.log(`✅ Подія відбою тривоги успішно сформована: "${clearPush.payload.title}"`);

  // Відновлюємо функцію
  pushService.sendToSubscriber = originalSendToSubscriber;

  // Тест 5: Перевірка Service Worker опцій
  console.log('\n--- 5. Перевірка SW параметрів сповіщень ---');
  const swCode = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  assert.ok(swCode.includes("addEventListener('push'"), 'sw.js повинен слухати подію push');
  assert.ok(swCode.includes("addEventListener('notificationclick'"), 'sw.js повинен слухати подію notificationclick');
  assert.ok(swCode.includes("requireInteraction: isCritical"), 'Критичні тривоги повинні мати requireInteraction: isCritical');
  assert.ok(swCode.includes("vibrate:"), 'sw.js повинен підтримувати вібрацію для тактильного сповіщення');
  console.log('✅ Service Worker містить усі необхідні PWA та Push API обробники!');

  console.log('\n🎉 ВСІ ТЕСТИ ПРОЙДЕНО УСПІШНО!');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n❌ Тести провалилися:', err);
  process.exit(1);
});
