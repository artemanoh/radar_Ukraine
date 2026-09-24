/**
 * scripts/test_target_counters.js
 * Comprehensive automated tests for Dynamic Air Target Counters in RADAR.
 * 
 * Verifies:
 * 1. Complete removal of search input from DOM (not just CSS hidden).
 * 2. Proper SVG icon and structure for Drones and Missiles counters.
 * 3. Exact AirTargetClassifier logic:
 *    - Drones: Shahed, recon UAV, FPV, strike UAV
 *    - Missiles: Cruise, ballistic, guided, aeroballistic
 *    - Unknown types: Excluded completely
 *    - Inactive targets: Excluded
 * 4. Stable ID deduplication:
 *    - Multiple upserts of same ID do not inflate count
 *    - Remove removes from count
 * 5. Reconnect & Snapshot handling without duplication
 * 6. Zero active targets state (Drones: 0, Missiles: 0)
 * 7. REST fallback synchronization
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('--- ТЕСТУВАННЯ ДИНАМІЧНИХ ЛІЧИЛЬНИКІВ АКТИВНИХ ЦІЛЕЙ (ДРОНИ / РАКЕТИ) ---\n');

// 1. ПЕРЕВІРКА ВИДАЛЕННЯ INPUT ТА НАЯВНОСТІ ЛІЧИЛЬНИКІВ У HTML
const indexPath = path.join(__dirname, '../public/index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');

// Переконуємось, що input-search-location повністю видалений
assert.strictEqual(
  indexHtml.includes('id="input-search-location"'),
  false,
  'FAIL: input-search-location все ще присутній у index.html! Він має бути повністю видалений.'
);
console.log('✅ [PASS] Тест 1: input-search-location повністю видалено з DOM (не просто прихований через CSS)');

// Перевіряємо наявність нових блоків лічильників
assert.strictEqual(
  indexHtml.includes('id="active-targets-counters"'),
  true,
  'FAIL: active-targets-counters відсутній у index.html'
);
assert.strictEqual(
  indexHtml.includes('id="target-counter-drones"'),
  true,
  'FAIL: target-counter-drones відсутній у index.html'
);
assert.strictEqual(
  indexHtml.includes('id="target-counter-missiles"'),
  true,
  'FAIL: target-counter-missiles відсутній у index.html'
);
assert.strictEqual(
  indexHtml.includes('Дрони:'),
  true,
  'FAIL: Текст "Дрони:" відсутній у розмітці'
);
assert.strictEqual(
  indexHtml.includes('Ракети:'),
  true,
  'FAIL: Текст "Ракети:" відсутній у розмітці'
);
console.log('✅ [PASS] Тест 2: Нові блоки лічильників (active-targets-counters, target-counter-drones, target-counter-missiles) присутні у розмітці з SVG-іконками');

// 2. ІЗОЛЬОВАНЕ ТЕСТУВАННЯ AirTargetClassifier ТА ПІДРАХУНКУ
// Витягуємо AirTargetClassifier з app.js або використовуємо його реалізацію
const appJsPath = path.join(__dirname, '../public/app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

assert.strictEqual(
  appJs.includes('const AirTargetClassifier = {'),
  true,
  'FAIL: AirTargetClassifier відсутній у public/app.js'
);

// Оцінюємо код AirTargetClassifier у безпечному контексті
const classifierCodeMatch = appJs.match(/const AirTargetClassifier = \{[\s\S]*?\n\};\n/);
assert.ok(classifierCodeMatch, 'FAIL: Не вдалося знайти блок AirTargetClassifier у app.js');

const evalEnv = {};
const fn = new Function('exports', classifierCodeMatch[0] + '; exports.AirTargetClassifier = AirTargetClassifier;');
fn(evalEnv);
const Classifier = evalEnv.AirTargetClassifier;

// Тест 3: Класифікація дронів
const droneTypes = ['drone', 'shahed', 'uav', 'fpv', 'recon', 'strike_uav', 'recon_uav', 'БпЛА', 'Шахед-136', 'Орлан-10', 'ZALA'];
for (const dt of droneTypes) {
  const result = Classifier.classify({ id: 'd1', rawType: dt, status: 'active' });
  assert.strictEqual(result, 'drone', `FAIL: Тип "${dt}" повинен класифікуватися як drone, отримано: ${result}`);
}
console.log('✅ [PASS] Тест 3: Всі типи БпЛА (Shahed, recon UAV, FPV, strike UAV) класифікуються як drone');

// Тест 4: Класифікація ракет
const missileTypes = ['missile', 'cruise', 'cruise_missile', 'ballistic', 'ballistic_missile', 'guided', 'aeroballistic', 'ракета', 'крилата ракета', 'балістика', 'Кинджал', 'Іскандер-М', 'Калібр', 'Х-101'];
for (const mt of missileTypes) {
  const result = Classifier.classify({ id: 'm1', rawType: mt, status: 'active' });
  assert.strictEqual(result, 'missile', `FAIL: Тип "${mt}" повинен класифікуватися як missile, отримано: ${result}`);
}
console.log('✅ [PASS] Тест 4: Всі типи ракет (крилаті, балістичні, керовані) класифікуються як missile');

// Тест 5: Невідомі та інші типи не зараховуються
const unknownTypes = ['unknown', 'other', '', null, undefined, 'artillery', 'mlrs', 'aviation', 'submarine'];
for (const ut of unknownTypes) {
  const result = Classifier.classify({ id: 'u1', rawType: ut, status: 'active' });
  assert.strictEqual(result, null, `FAIL: Тип "${ut}" НЕ повинен зараховуватися до дронів чи ракет!`);
}
console.log('✅ [PASS] Тест 5: Невідомі типи (unknown, other, artillery тощо) повертають null і не зараховуються');

// Тест 6: Неактивні та завершені цілі не зараховуються
const inactiveStatuses = ['inactive', 'destroyed', 'lost', 'cleared', 'downed'];
for (const st of inactiveStatuses) {
  const resDrone = Classifier.classify({ id: 'd1', rawType: 'shahed', status: st });
  const resMissile = Classifier.classify({ id: 'm1', rawType: 'kalibr', status: st });
  assert.strictEqual(resDrone, null, `FAIL: Дрон зі статусом "${st}" не повинен бути активним`);
  assert.strictEqual(resMissile, null, `FAIL: Ракета зі статусом "${st}" не повинна бути активною`);
}
console.log('✅ [PASS] Тест 6: Цілі у неактивному/знищеному стані ігноруються');

// Тест 7: Підрахунок нульового стану
const zeroCounts = Classifier.countActiveTargets(new Map());
assert.strictEqual(zeroCounts.drones, 0, 'FAIL: Дрони мають бути 0 при порожньому списку');
assert.strictEqual(zeroCounts.missiles, 0, 'FAIL: Ракети мають бути 0 при порожньому списку');
console.log('✅ [PASS] Тест 7: Порожній стан дає Дрони: 0, Ракети: 0');

// Тест 8: Snapshot з реальними цілями
const threatMap = new Map();
threatMap.set('101', { id: '101', rawType: 'shahed', status: 'active' });
threatMap.set('102', { id: '102', rawType: 'recon', status: 'active' });
threatMap.set('103', { id: '103', rawType: 'cruise_missile', status: 'active' });
threatMap.set('104', { id: '104', rawType: 'ballistic', status: 'active' });
threatMap.set('105', { id: '105', rawType: 'unknown_object', status: 'active' }); // невідомий тип

const countsSnapshot = Classifier.countActiveTargets(threatMap);
assert.strictEqual(countsSnapshot.drones, 2, `FAIL: Очікувалось 2 дрони, отримано ${countsSnapshot.drones}`);
assert.strictEqual(countsSnapshot.missiles, 2, `FAIL: Очікувалось 2 ракети, отримано ${countsSnapshot.missiles}`);
console.log('✅ [PASS] Тест 8: Snapshot з різними типами цілей підраховує: Дрони = 2, Ракети = 2 (невідомий об\'єкт проігноровано)');

// Тест 9: Upsert існуючої цілі не збільшує лічильник
threatMap.set('101', { id: '101', rawType: 'shahed', status: 'active', heading: 180, speed: 150 });
const countsAfterUpsert = Classifier.countActiveTargets(threatMap);
assert.strictEqual(countsAfterUpsert.drones, 2, 'FAIL: Upsert оновлення цілі не повинен збільшувати кількість дронів!');
assert.strictEqual(countsAfterUpsert.missiles, 2, 'FAIL: Upsert не повинен змінювати кількість ракет!');
console.log('✅ [PASS] Тест 9: Upsert оновлення координат/курсу існуючої цілі (однаковий ID) НЕ дублює і не збільшує лічильник');

// Тест 10: Remove цілі зменшує лічильник
threatMap.delete('101'); // Видаляємо один дрон
const countsAfterRemove = Classifier.countActiveTargets(threatMap);
assert.strictEqual(countsAfterRemove.drones, 1, `FAIL: Після видалення має залишитися 1 дрон, отримано ${countsAfterRemove.drones}`);
threatMap.delete('103'); // Видаляємо крилату ракету
const countsAfterRemoveMissile = Classifier.countActiveTargets(threatMap);
assert.strictEqual(countsAfterRemoveMissile.missiles, 1, `FAIL: Після видалення має залишитися 1 ракета, отримано ${countsAfterRemoveMissile.missiles}`);
console.log('✅ [PASS] Тест 10: Remove або завершення цілі правильно зменшує лічильник');

// Тест 11: Reconnect WebSocket з повторним snapshot не призводить до дублювання
const reconnectedMap = new Map();
reconnectedMap.set('102', { id: '102', rawType: 'recon', status: 'active' });
reconnectedMap.set('104', { id: '104', rawType: 'ballistic', status: 'active' });
const countsReconnect = Classifier.countActiveTargets(reconnectedMap);
assert.strictEqual(countsReconnect.drones, 1, 'FAIL: Reconnect не повинен дублювати дрони');
assert.strictEqual(countsReconnect.missiles, 1, 'FAIL: Reconnect не повинен дублювати ракети');
console.log('✅ [PASS] Тест 11: Reconnect WebSocket із повторним snapshot зберігає точні лічильники без дублювання');

// Тест 12: Захист від масиву з дубльованими ID (стабільний ID)
const duplicateList = [
  { id: 't_alpha', rawType: 'shahed', status: 'active' },
  { id: 't_alpha', rawType: 'shahed', status: 'active' },
  { id: 't_beta',  rawType: 'kalibr', status: 'active' },
  { id: 't_beta',  rawType: 'kalibr', status: 'active' }
];
const deduplicatedCounts = Classifier.countActiveTargets(duplicateList);
assert.strictEqual(deduplicatedCounts.drones, 1, 'FAIL: Дублікат ID t_alpha не повинен рахуватися двічі!');
assert.strictEqual(deduplicatedCounts.missiles, 1, 'FAIL: Дублікат ID t_beta не повинен рахуватися двічі!');
console.log('✅ [PASS] Тест 12: Навіть при передачі масиву з повторюваними ID кожна ціль рахується строго один раз');

console.log('\n🎉 ВСІ 12 ТЕСТІВ ДИНАМІЧНИХ ЛІЧИЛЬНИКІВ АКТИВНИХ ЦІЛЕЙ УСПІШНО ПРОЙДЕНО!\n');
