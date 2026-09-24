const fs = require('fs');
const path = require('path');
const assert = require('assert');

// 1. Setup Environment Mocks
function createMockElement(tag = 'div', id = '') {
  return {
    id,
    tagName: tag.toUpperCase(),
    checked: true,
    value: '',
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; }
    },
    children: [],
    appendChild(child) { this.children.push(child); },
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return createMockElement(); },
    querySelectorAll() { return []; },
    scrollTo() {},
    textContent: '',
    innerHTML: '',
    style: {}
  };
}

const mockElements = {};
global.window = global;
global.document = {
  getElementById(id) {
    if (!mockElements[id]) mockElements[id] = createMockElement('div', id);
    return mockElements[id];
  },
  createElement(tag) { return createMockElement(tag); },
  querySelectorAll() { return []; },
  querySelector() { return createMockElement(); },
  addEventListener() {},
  removeEventListener() {},
  body: createMockElement('body')
};
global.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] || null; },
  setItem(k, v) { this._store[k] = String(v); },
  removeItem(k) { delete this._store[k]; }
};
global.navigator = {
  userAgent: 'node',
  geolocation: {
    watchPosition() { return 1; },
    clearWatch() {}
  }
};
global.Audio = class {
  constructor(src) { this.src = src; this.currentTime = 0; }
  play() { return Promise.resolve(); }
  pause() {}
  load() {}
};
global.AudioContext = class {
  constructor() { this.state = 'running'; this.currentTime = 0; }
  resume() { return Promise.resolve(); }
  createOscillator() { return { type: '', frequency: { setValueAtTime() {} }, connect() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
};
global.Notification = {
  permission: 'granted',
  requestPermission() { return Promise.resolve('granted'); }
};

let playedAlertsCount = 0;
let playedClearsCount = 0;
let playedUrgentsCount = 0;
let playedInfoChimesCount = 0;

function resetSoundCounters() {
  playedAlertsCount = 0;
  playedClearsCount = 0;
  playedUrgentsCount = 0;
  playedInfoChimesCount = 0;
}

// 2. Load territories
const territoriesPath = path.join(__dirname, '..', 'public', 'territories.json');
const territoriesData = JSON.parse(fs.readFileSync(territoriesPath, 'utf8'));

// 3. Load app.js code and execute inside VM context
const appJsPath = path.join(__dirname, '..', 'public', 'app.js');
let appJsCode = fs.readFileSync(appJsPath, 'utf8');

// Wrap and eval
const vm = require('vm');
const context = vm.createContext({
  ...global,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  String,
  Number,
  Array,
  Object,
  Set,
  Map,
  JSON,
  RegExp,
  Promise
});

vm.runInContext(appJsCode + '\n;globalThis.setInitialLoad = window.setInitialLoad; globalThis.SoundService = SoundService; globalThis.ChangeDetector = ChangeDetector; globalThis.NotificationDispatcher = NotificationDispatcher; globalThis.PersonalDangerService = PersonalDangerService; globalThis.StorageManager = StorageManager; globalThis.AlertsService = AlertsService; globalThis.State = State;', context);

// Inject sound spies
context.SoundService.playAlertSiren = function(force = false) {
  if (!force && context.isInitialLoad) return;
  const s = context.StorageManager.getSettings();
  if (!force && (!s.soundEnabled || s.soundAlertEnabled === false || this.isQuietTime())) return;
  playedAlertsCount++;
};
context.SoundService.playClearSound = function(force = false) {
  if (!force && context.isInitialLoad) return;
  const s = context.StorageManager.getSettings();
  if (!force && (!s.soundEnabled || s.soundClearEnabled === false || this.isQuietTime())) return;
  playedClearsCount++;
};
context.SoundService.playUrgentSiren = function(force = false) {
  if (!force && context.isInitialLoad) return;
  const s = context.StorageManager.getSettings();
  if (!force && (!s.soundEnabled || s.soundTargetDangerEnabled === false || s.personalDangerSound === false || this.isQuietTime())) return;
  playedUrgentsCount++;
};
context.SoundService.playInfoChime = function(force = false) {
  if (!force && context.isInitialLoad) return;
  const s = context.StorageManager.getSettings();
  if (!force && (!s.soundEnabled || this.isQuietTime())) return;
  playedInfoChimesCount++;
};

console.log('--- STARTING UNIFIED AUDIO SIGNALS VERIFICATION TEST ---');

// Setup default state: User selected Vinnytsia oblast
context.State.selectedRegion = 'Вінницька область';
context.State.selectedDistrict = 'all';
context.State.showEntireRegionWithDistrict = true;
context.setInitialLoad(false);
context.StorageManager.saveSettings({
  ...context.StorageManager.defaultSettings,
  notificationsEnabled: true,
  soundEnabled: true,
  soundAlertEnabled: true,
  soundClearEnabled: true,
  soundTargetDangerEnabled: true
});

// TEST 1: Scenario A - Official alert in selected territory -> playAlertSiren exactly once
resetSoundCounters();
context.ChangeDetector.applyAlerts({
  version: 1,
  updatedAt: new Date().toISOString(),
  specialCities: new Map(),
  oblasts: new Map([
    ['вінницька', { key: 'вінницька', name: 'Вінницька область', oblast: 'Вінницька область', level: 'red', since: '2026-09-24T10:00:00Z', type: 'oblast' }]
  ]),
  raions: new Map()
});
assert.strictEqual(playedAlertsCount, 1, 'Official alert in Vinnytsia must trigger playAlertSiren');
assert.strictEqual(playedUrgentsCount, 0, 'Official alert must NOT trigger playUrgentSiren');
assert.strictEqual(playedClearsCount, 0, 'Official alert must NOT trigger playClearSound');
console.log('✅ [PASS] Scenario A: Офіційна тривога у вибраній області відтворює сигнал повітряної тривоги (playAlertSiren = 1)');

// TEST 2: Scenario B - Alert in unselected territory (e.g. Poltava) -> NO sound
resetSoundCounters();
context.ChangeDetector.applyAlerts({
  version: 2,
  updatedAt: new Date().toISOString(),
  specialCities: new Map(),
  oblasts: new Map([
    ['вінницька', { key: 'вінницька', name: 'Вінницька область', oblast: 'Вінницька область', level: 'red', since: '2026-09-24T10:00:00Z', type: 'oblast' }],
    ['полтавська', { key: 'полтавська', name: 'Полтавська область', oblast: 'Полтавська область', level: 'red', since: '2026-09-24T10:05:00Z', type: 'oblast' }]
  ]),
  raions: new Map()
});
assert.strictEqual(playedAlertsCount, 0, 'Poltava alert must be filtered out for Vinnytsia user');
assert.strictEqual(playedUrgentsCount, 0);
assert.strictEqual(playedClearsCount, 0);
console.log('✅ [PASS] Scenario B: Тривога в невибраній області (Полтава) відфільтрована (звуків = 0)');

// TEST 3: Scenario C - Real NEPTUN target enters danger radius (NORMAL -> HIGH) -> playUrgentSiren exactly once
resetSoundCounters();
context.PersonalDangerService.userCoords = { lat: 49.233, lon: 28.468 }; // Vinnytsia center
context.PersonalDangerService.previousLevel = 'NORMAL';
context.StorageManager.saveSettings({
  ...context.StorageManager.getSettings(),
  geoEnabled: true,
  personalDangerRadiusKm: 10
});

// Add target 5 km away
context.State.threats.set('target-1', {
  id: 'target-1',
  type: 'drone',
  title: 'Shahed-136',
  coordinates: [49.260, 28.468], // ~3 km away
  status: 'active',
  areaOnly: false
});
context.PersonalDangerService.evaluate();

assert.strictEqual(playedUrgentsCount, 1, 'Real target entering radius must trigger playUrgentSiren once');
assert.strictEqual(playedAlertsCount, 0, 'Target danger must NOT trigger playAlertSiren');
assert.strictEqual(playedClearsCount, 0, 'Target danger must NOT trigger playClearSound');
console.log('✅ [PASS] Scenario C: Реальна ціль у радіусі викликає окремий сигнал високої небезпеки (playUrgentSiren = 1)');

// TEST 4: Scenario D - Target moves within radius (HIGH -> HIGH) -> NO repeated sound
resetSoundCounters();
context.State.threats.set('target-1', {
  id: 'target-1',
  type: 'drone',
  title: 'Shahed-136',
  coordinates: [49.250, 28.468], // moved closer ~1.8 km away
  status: 'active',
  areaOnly: false
});
context.PersonalDangerService.evaluate();
assert.strictEqual(playedUrgentsCount, 0, 'Moving within radius must NOT trigger sound again');
console.log('✅ [PASS] Scenario D: Рух цілі всередині радіусу (HIGH -> HIGH) не повторює звук (звуків = 0)');

// TEST 5: Scenario E - Target leaves danger radius (HIGH -> NORMAL) -> NO CLEAR SOUND
resetSoundCounters();
context.State.threats.set('target-1', {
  id: 'target-1',
  type: 'drone',
  title: 'Shahed-136',
  coordinates: [49.500, 28.468], // moved 30 km away
  status: 'active',
  areaOnly: false
});
context.PersonalDangerService.evaluate();
assert.strictEqual(playedClearsCount, 0, 'Target leaving radius must NEVER play clear sound! Clear sound is strictly for air alerts.');
assert.strictEqual(playedUrgentsCount, 0);
assert.strictEqual(playedAlertsCount, 0);
console.log('✅ [PASS] Scenario E: Вихід цілі з радіусу НЕ грає відбій (відбій тільки для офіційної тривоги)');

// TEST 6: Scenario F - Official air alert cleared in selected territory (ACTIVE -> CLEARED) -> playClearSound once
resetSoundCounters();
context.ChangeDetector.applyAlerts({
  version: 3,
  updatedAt: new Date().toISOString(),
  specialCities: new Map(),
  oblasts: new Map([
    // Vinnytsia removed! Poltava remains
    ['полтавська', { key: 'полтавська', name: 'Полтавська область', oblast: 'Полтавська область', level: 'red', since: '2026-09-24T10:05:00Z', type: 'oblast' }]
  ]),
  raions: new Map()
});
assert.strictEqual(playedClearsCount, 1, 'Vinnytsia alert clearance must trigger playClearSound once');
assert.strictEqual(playedAlertsCount, 0);
assert.strictEqual(playedUrgentsCount, 0);
console.log('✅ [PASS] Scenario F: Офіційний відбій у вибраній області грає сигнал відбою (playClearSound = 1)');

// TEST 7: Scenario G - Page reload / initial load with already active alert -> NO SOUND
resetSoundCounters();
context.setInitialLoad(true);
context.ChangeDetector.applyAlerts({
  version: 4,
  updatedAt: new Date().toISOString(),
  specialCities: new Map(),
  oblasts: new Map([
    ['київ', { key: 'київ', name: 'м. Київ', oblast: 'м. Київ', level: 'red', since: '2026-09-24T10:10:00Z', type: 'special_city' }],
    ['вінницька', { key: 'вінницька', name: 'Вінницька область', oblast: 'Вінницька область', level: 'red', since: '2026-09-24T10:10:00Z', type: 'oblast' }]
  ]),
  raions: new Map()
});
assert.strictEqual(playedAlertsCount, 0, 'Initial load must NEVER play sound');
assert.strictEqual(playedClearsCount, 0, 'Initial load must NEVER play sound');
assert.strictEqual(playedUrgentsCount, 0, 'Initial load must NEVER play sound');
console.log('✅ [PASS] Scenario G: Релоад / початкове завантаження з активною тривогою не грає звуку');

// TEST 8: Scenario H - Reconnect / subsequent snapshot with already active alert -> NO SOUND
context.setInitialLoad(false);
resetSoundCounters();
// Snapshot received again via WebSocket or REST poll
context.ChangeDetector.applyAlerts({
  version: 5,
  updatedAt: new Date().toISOString(),
  specialCities: new Map(),
  oblasts: new Map([
    ['київ', { key: 'київ', name: 'м. Київ', oblast: 'м. Київ', level: 'red', since: '2026-09-24T10:10:00Z', type: 'special_city' }],
    ['вінницька', { key: 'вінницька', name: 'Вінницька область', oblast: 'Вінницька область', level: 'red', since: '2026-09-24T10:10:00Z', type: 'oblast' }]
  ]),
  raions: new Map()
});
assert.strictEqual(playedAlertsCount, 0, 'Subsequent identical snapshot must NOT play sound');
assert.strictEqual(playedClearsCount, 0);
assert.strictEqual(playedUrgentsCount, 0);
console.log('✅ [PASS] Scenario H: Реконект / повторний снепшот без зміни стану не створює повторного звуку');

// TEST 9: Scenario I - Tab "Тривоги" filter "Всі" active -> sound still respects selected territory
resetSoundCounters();
context.AlertsService.setFilter('all'); // User is viewing all Ukraine in the Alerts tab
// New alert in Kharkiv
context.ChangeDetector.applyAlerts({
  version: 6,
  updatedAt: new Date().toISOString(),
  specialCities: new Map(),
  oblasts: new Map([
    ['київ', { key: 'київ', name: 'м. Київ', oblast: 'м. Київ', level: 'red', since: '2026-09-24T10:10:00Z', type: 'special_city' }],
    ['вінницька', { key: 'вінницька', name: 'Вінницька область', oblast: 'Вінницька область', level: 'red', since: '2026-09-24T10:10:00Z', type: 'oblast' }],
    ['харківська', { key: 'харківська', name: 'Харківська область', oblast: 'Харківська область', level: 'red', since: '2026-09-24T10:20:00Z', type: 'oblast' }]
  ]),
  raions: new Map()
});
assert.strictEqual(playedAlertsCount, 0, 'Alert in Kharkiv must NOT trigger sound even if tab is in "Всі" mode');
console.log('✅ [PASS] Scenario I: Режим вкладки "Всі" не впливає на звуки — звуки слухають обрану територію');

// TEST 10: Scenario J - Area-only target (areaOnly: true) -> ignored for personal danger
resetSoundCounters();
context.State.threats.clear();
context.PersonalDangerService.previousLevel = 'NORMAL';
context.State.threats.set('area-target', {
  id: 'area-target',
  type: 'drone',
  title: 'Shahed area centroid',
  coordinates: [49.233, 28.468], // exactly at user coords
  status: 'active',
  areaOnly: true // centroid-only!
});
context.PersonalDangerService.evaluate();
assert.strictEqual(context.PersonalDangerService.minDistKm, null, 'areaOnly targets must be excluded from distance calculation');
assert.strictEqual(playedUrgentsCount, 0, 'areaOnly targets must NOT trigger personal danger');
console.log('✅ [PASS] Scenario J: Ціль з areaOnly: true ігнорується для персональної небезпеки');

// TEST 11: Scenario K - Settings master toggle & individual switches
// 11.1 Master sound toggle disabled
context.StorageManager.saveSettings({
  ...context.StorageManager.getSettings(),
  soundEnabled: false,
  soundAlertEnabled: true
});
resetSoundCounters();
// Clear Vinnytsia, then re-alert
context.ChangeDetector.applyAlerts({
  version: 7,
  updatedAt: new Date().toISOString(),
  specialCities: new Map(),
  oblasts: new Map(),
  raions: new Map()
});
resetSoundCounters();
context.ChangeDetector.applyAlerts({
  version: 8,
  updatedAt: new Date().toISOString(),
  specialCities: new Map(),
  oblasts: new Map([
    ['вінницька', { key: 'вінницька', name: 'Вінницька область', oblast: 'Вінницька область', level: 'red', since: '2026-09-24T10:30:00Z', type: 'oblast' }]
  ]),
  raions: new Map()
});
assert.strictEqual(playedAlertsCount, 0, 'Master sound off must silence all alerts');

// 11.2 Individual soundAlertEnabled toggle disabled
context.StorageManager.saveSettings({
  ...context.StorageManager.getSettings(),
  soundEnabled: true,
  soundAlertEnabled: false,
  soundClearEnabled: true
});
resetSoundCounters();
context.ChangeDetector.applyAlerts({
  version: 9,
  updatedAt: new Date().toISOString(),
  specialCities: new Map(),
  oblasts: new Map([
    ['вінницька', { key: 'вінницька', name: 'Вінницька область', oblast: 'Вінницька область', level: 'red', since: '2026-09-24T10:35:00Z', type: 'oblast' }]
  ]),
  raions: new Map()
});
assert.strictEqual(playedAlertsCount, 0, 'soundAlertEnabled: false must silence air raid siren');

// When cleared with soundClearEnabled: true
resetSoundCounters();
context.ChangeDetector.applyAlerts({
  version: 10,
  updatedAt: new Date().toISOString(),
  specialCities: new Map(),
  oblasts: new Map(),
  raions: new Map()
});
assert.strictEqual(playedClearsCount, 1, 'soundClearEnabled: true must still play clear sound');

console.log('✅ [PASS] Scenario K: Налаштування звуку (master toggle, soundAlertEnabled, soundClearEnabled) коректно керують звуками');

console.log('\n🎉 ВСІ 11 ТЕСТІВ ЄДИНОЇ ЛОГІКИ ЗВУКОВИХ СИГНАЛІВ УСПІШНО ПРОЙДЕНО!');
process.exit(0);
