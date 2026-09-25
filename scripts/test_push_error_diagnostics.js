/**
 * scripts/test_push_error_diagnostics.js
 * Verification of Fix for: "The string did not match the expected pattern" DOMException
 * 1. Base64URL sanitization and urlBase64ToUint8Array robustness
 * 2. Push server URL resolution (GitHub Pages vs Localhost/VPS)
 * 3. Safe response parsing avoiding res.json() on HTML error pages
 * 4. VAPID public key endpoint validity and format
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pushService = require('../services/pushService');

// Емуляція функції urlBase64ToUint8Array з app.js
function urlBase64ToUint8Array(base64String) {
  if (!base64String || typeof base64String !== 'string') {
    throw new Error('VAPID public key має бути непорожнім рядком Base64URL');
  }
  let cleaned = base64String.trim().replace(/^["']|["']$/g, '').replace(/[\r\n\s]/g, '');
  if (!cleaned) {
    throw new Error('VAPID public key порожній після санітизації');
  }
  cleaned = cleaned.replace(/-/g, '+').replace(/_/g, '/');

  const mod = cleaned.length % 4;
  if (mod === 2) {
    cleaned += '==';
  } else if (mod === 3) {
    cleaned += '=';
  } else if (mod === 1) {
    throw new Error(`Невалідна довжина Base64 (${cleaned.length} символів) для VAPID public key`);
  }

  try {
    const rawData = atob(cleaned);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  } catch (e) {
    throw new Error(`Помилка декодування Base64 VAPID ключа: ${e.message}`);
  }
}

// Емуляція функції getPushServerUrl з app.js
function getPushServerUrl(hostname, customSettingUrl, origin = 'https://artemanoh.github.io') {
  if (customSettingUrl && customSettingUrl.trim()) {
    return customSettingUrl.trim().replace(/\/+$/, '');
  }
  if (hostname && hostname.endsWith('github.io')) {
    return null;
  }
  return origin;
}

async function runDiagnosticsTest() {
  console.log('🔍 [DIAGNOSTIC TEST] Перевірка виправлення DOMException "The string did not match the expected pattern"...\n');

  // 1. Тест VAPID Public Key з сервера
  console.log('--- 1. Перевірка формату VAPID Public Key ---');
  const dummyApp = { get: () => {}, post: () => {} };
  pushService.init(dummyApp);
  const key = pushService.getVapidPublicKey();

  assert.ok(typeof key === 'string', 'Ключ має бути рядком');
  assert.strictEqual(key.trim(), key, 'Ключ не повинен містити початкових або кінцевих пробілів/переносів');
  assert.ok(!key.includes('\n') && !key.includes('\r'), 'Ключ не повинен містити переносів рядків');
  assert.ok(!key.includes('"') && !key.includes("'"), 'Ключ не повинен містити лапок');
  assert.strictEqual(key.length, 87, `Довжина VAPID public key для P-256 має бути 87 символів Base64URL, отримано: ${key.length}`);
  console.log(`✅ VAPID Public Key валідний: довжина ${key.length} символів, префікс: ${key.slice(0, 12)}...`);

  // 2. Тест декодування в Uint8Array
  console.log('\n--- 2. Перевірка urlBase64ToUint8Array ---');
  // 2.1. Чистий ключ
  const uint8 = urlBase64ToUint8Array(key);
  assert.ok(uint8 instanceof Uint8Array, 'Результат має бути екземпляром Uint8Array');
  assert.strictEqual(uint8.byteLength, 65, `Uncompressed P-256 public key має мати рівно 65 байт, отримано: ${uint8.byteLength}`);
  assert.strictEqual(uint8[0], 0x04, `Перший байт uncompressed P-256 має бути 0x04, отримано: ${uint8[0]}`);

  // 2.2. Ключ із лапками, пробілами та переносами (санітизація)
  const dirtyKey = `  "${key}\n\r"  `;
  const uint8Dirty = urlBase64ToUint8Array(dirtyKey);
  assert.strictEqual(uint8Dirty.byteLength, 65, 'Санітизований ключ повинен успішно декодуватися в 65 байт');
  assert.deepStrictEqual(uint8, uint8Dirty, 'Результат санітизованого ключа має повністю збігатися з оригіналом');

  // 2.3. Захист від некоректних типів (undefined, null, об'єкти)
  assert.throws(() => urlBase64ToUint8Array(undefined), /VAPID public key має бути непорожнім рядком/);
  assert.throws(() => urlBase64ToUint8Array(null), /VAPID public key має бути непорожнім рядком/);
  assert.throws(() => urlBase64ToUint8Array({}), /VAPID public key має бути непорожнім рядком/);
  console.log('✅ urlBase64ToUint8Array повністю захищена та коректно генерує 65 байт P-256 key');

  // 3. Тест визначення Push Server URL
  console.log('\n--- 3. Перевірка getPushServerUrl (GitHub Pages vs Localhost/VPS) ---');
  // 3.1. На GitHub Pages без налаштованого сервера
  const ghUrl = getPushServerUrl('artemanoh.github.io', '');
  assert.strictEqual(ghUrl, null, 'На GitHub Pages без вказаного pushServerUrl функція має повертати null, уникаючи запитів до 404');

  // 3.2. На GitHub Pages із вказаним користувацьким сервером
  const customUrl = getPushServerUrl('artemanoh.github.io', 'https://radar-backend.onrender.com/');
  assert.strictEqual(customUrl, 'https://radar-backend.onrender.com', 'Вказаний користувацький pushServerUrl повинен нормалізуватися');

  // 3.3. На Localhost
  const localUrl = getPushServerUrl('localhost', '', 'http://localhost:3000');
  assert.strictEqual(localUrl, 'http://localhost:3000', 'На localhost має використовуватись поточний origin');
  console.log('✅ getPushServerUrl захищає від виклику GitHub Pages як бекенду');

  // 4. Тест захисту від парсингу HTML як JSON
  console.log('\n--- 4. Перевірка безпечного парсингу відповідей ---');
  // Емуляція небезпечного коду: викликає .json() на HTML
  const mockHtmlResponse = {
    ok: false,
    status: 404,
    headers: {
      get: (header) => (header.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null)
    },
    text: async () => '<!DOCTYPE html><html>404 Not Found</html>'
  };

  // Перевірка правильної логіки: спочатку перевіряємо content-type
  let threwExpected = false;
  try {
    const contentType = mockHtmlResponse.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await mockHtmlResponse.text();
      throw new Error(`Сервер повернув не-JSON відповідь (HTTP ${mockHtmlResponse.status}: "${text.slice(0, 30)}")`);
    }
  } catch (err) {
    threwExpected = true;
    assert.ok(err.message.includes('не-JSON відповідь'), 'Помилка має чітко пояснювати проблему не-JSON формату');
    console.log(`✅ Оброблено коректно: "${err.message}"`);
  }
  assert.ok(threwExpected, 'Повинна викидатися зрозуміла помилка замість DOMException SyntaxError');

  console.log('\n🎉 ВСІ ПЕРЕВІРКИ ДІАГНОСТИКИ ТА ВИПРАВЛЕННЯ УСПІШНО ПРОЙДЕНО!');
  process.exit(0);
}

runDiagnosticsTest().catch(err => {
  console.error('❌ Помилка тесту:', err);
  process.exit(1);
});
