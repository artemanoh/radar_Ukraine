const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Load territories
const territoriesPath = path.join(__dirname, '..', 'public', 'territories.json');
const territoriesData = JSON.parse(fs.readFileSync(territoriesPath, 'utf8'));

// Load app.js code
const appJsPath = path.join(__dirname, '..', 'public', 'app.js');
const appJsCode = fs.readFileSync(appJsPath, 'utf8');

// DOM Mock
const DOM = {
  elements: {},
  getElementById(id) {
    if (!this.elements[id]) {
      this.elements[id] = {
        id,
        textContent: '',
        value: '',
        classList: {
          classes: new Set(),
          add(c) { this.classes.add(c); },
          remove(c) { this.classes.delete(c); },
          toggle(c, force) { if (force !== undefined) { force ? this.classes.add(c) : this.classes.delete(c); } else { this.classes.has(c) ? this.classes.delete(c) : this.classes.add(c); } },
          contains(c) { return this.classes.has(c); }
        },
        children: [],
        appendChild(child) { this.children.push(child); },
        innerHTML: '',
        addEventListener() {},
        querySelector() { return { textContent: '' }; }
      };
    }
    return this.elements[id];
  },
  querySelectorAll() { return []; }
};

const State = {
  selectedRegion: 'all',
  selectedDistrict: 'all',
  showEntireRegionWithDistrict: true
};

function normalizeName(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/['"`ʼ’‘]/g, '').replace(/[-\s]+/g, ' ').trim();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function formatEventTime(val) {
  return val ? String(val) : '--:--';
}

function formatAlertTimestamp(sinceStr, finishedStr = null) {
  return '10:00';
}

function formatEventDuration(since) {
  return '1 год 20 хв';
}

function getReasonBadgeHtml(reasons) {
  return '<span class="badge">Тривога</span>';
}

const FollowManager = {
  followedSet: new Set(),
  matchesFollowed(name) { return this.followedSet.has(name); }
};

const NavigationController = { currentTab: 'alerts' };

const sandbox = {
  console,
  Set,
  Map,
  Array,
  Math,
  RegExp,
  Date,
  JSON,
  document: DOM,
  State,
  normalizeName,
  escapeHtml,
  formatEventTime,
  formatAlertTimestamp,
  formatEventDuration,
  getReasonBadgeHtml,
  FollowManager,
  NavigationController,
  localStorage: {
    data: {},
    getItem(k) { return this.data[k] || null; },
    setItem(k, v) { this.data[k] = String(v); },
    removeItem(k) { delete this.data[k]; }
  }
};

function extractCode(startMarker, endMarker) {
  const start = appJsCode.indexOf(startMarker);
  const end = appJsCode.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error(`Marker not found: ${startMarker}`);
  return appJsCode.substring(start, end);
}

const tmCode = extractCode('const TerritoriesManager = {', 'const GlobalTerritoryFilter = {');
const gtfCode = extractCode('const GlobalTerritoryFilter = {', 'function getAlertTimestamp(alert) {');
const asCode = extractCode('function getAlertTimestamp(alert) {', 'const UIController = {');

const setupFn = new Function('sandbox', `
  with(sandbox) {
    function escapeHtml(str) { return str || ''; }
    function formatAlertTimestamp(s, f) { return '10:00'; }
    function formatAlertDuration(s, f) { return '1 год'; }
    function getReasonBadgeHtml(r) { return '<span>Тривога</span>'; }
    function formatEventTime(v) { return v || '--:--'; }

    ${tmCode}
    ${gtfCode}
    ${asCode}
    return { TerritoriesManager, GlobalTerritoryFilter, AlertsService, getAlertTimestamp };
  }
`);

const { TerritoriesManager: TM, GlobalTerritoryFilter: GTF, AlertsService: AS } = setupFn(sandbox);
sandbox.TerritoriesManager = TM;
sandbox.GlobalTerritoryFilter = GTF;
sandbox.AlertsService = AS;

TM.hierarchy = territoriesData.hierarchy || [];
TM.flat = territoriesData.flat || [];
TM.buildIndices();

console.log('--- ТЕСТУВАННЯ РЕЖИМІВ ВКЛАДКИ ТРИВОГИ (ВСІ vs ВИБРАНІ ОБЛАСТІ) ---');

// Test 1: Selected territories: Вінницька область, Режим: Всі -> бачимо тривоги всієї України
State.selectedRegion = 'Вінницька область';
State.selectedDistrict = 'all';

// Mock active alerts across Ukraine
AS.activeAlerts.clear();
AS.alertsHistory = [];
AS.activeAlerts.set('київ', { key: 'київ', name: 'Київ', oblast: 'Київ', started_at: '2026-09-24T10:00:00Z', level: 'red' });
AS.activeAlerts.set('вінницька область', { key: 'вінницька область', name: 'Вінницька область', oblast: 'Вінницька область', started_at: '2026-09-24T10:10:00Z', level: 'red' });
AS.activeAlerts.set('полтавська область', { key: 'полтавська область', name: 'Полтавська область', oblast: 'Полтавська область', started_at: '2026-09-24T09:30:00Z', level: 'yellow' });
AS.activeAlerts.set('одеська область', { key: 'одеська область', name: 'Одеська область', oblast: 'Одеська область', started_at: '2026-09-24T09:45:00Z', level: 'red' });

AS.setFilter('all');
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Київ'), true);
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Вінницька область'), true);
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Полтавська область'), true);
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Одеська область'), true);
console.log('✅ [PASS] Test 1: Режим "Всі" при вибраній Вінницькій області показує ВСЮ Україну (Київ, Полтава, Одеса, Вінниця)');

// Test 2: Selected territories: Вінницька область, Режим: Вибрані області -> бачимо тільки Вінницьку область
AS.setFilter('followed');
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Вінницька область'), true);
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Київ'), false);
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Полтавська область'), false);
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Одеська область'), false);
console.log('✅ [PASS] Test 2: Режим "Вибрані області" при вибраній Вінницькій області показує ТІЛЬКИ Вінницьку область');

// Test 3: Прийшла нова тривога в Києві, Режим: Всі -> вона з'являється
AS.setFilter('all');
AS.userScrolledDown = false;
AS.handleRealtimeAlerts({
  data: [
    { name: 'Київ', oblast: 'Київ', since: '2026-09-24T10:35:00Z', level: 'red' },
    { name: 'Харківська область', oblast: 'Харківська область', since: '2026-09-24T10:36:00Z', level: 'red' }
  ]
});
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Харківська область'), true);
console.log('✅ [PASS] Test 3: Нова тривога (Харків) у режимі "Всі" одразу з\'являється у списку');

// Test 4: Прийшла нова тривога в Дніпрі, Режим: Вибрані області (Вінниця) -> вона НЕ з'являється у списку
AS.setFilter('followed');
AS.handleRealtimeAlerts({
  data: [
    { name: 'Вінницька область', oblast: 'Вінницька область', since: '2026-09-24T10:10:00Z', level: 'red' },
    { name: 'Харківська область', oblast: 'Харківська область', since: '2026-09-24T10:36:00Z', level: 'red' },
    { name: 'Дніпропетровська область', oblast: 'Дніпропетровська область', since: '2026-09-24T10:40:00Z', level: 'red' }
  ]
});
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Вінницька область'), true);
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Дніпропетровська область'), false);
console.log('✅ [PASS] Test 4: Нова тривога (Дніпро) у режимі "Вибрані області" НЕ з\'являється, якщо область не вибрана');

// Test 5: Змінити: Всі -> Вибрані області -> список перебудовується без reload
AS.setFilter('all');
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Харківська область'), true);
AS.setFilter('followed');
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Харківська область'), false);
console.log('✅ [PASS] Test 5: Перемикання "Всі" -> "Вибрані області" перебудовує список миттєво без перезавантаження');

// Test 6: Змінити: Вибрані області -> Всі -> одразу показати всі доступні тривоги
AS.setFilter('all');
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Харківська область'), true);
assert.strictEqual(DOM.getElementById('alerts-list-container').innerHTML.includes('Дніпропетровська область'), true);
console.log('✅ [PASS] Test 6: Перемикання "Вибрані області" -> "Всі" миттєво показує всі доступні тривоги України');

// Test 7: Перевірка хронологічного сортування (найновіша started_at зверху)
const alertsHtml = DOM.getElementById('alerts-list-container').innerHTML;
const idxDnipro = alertsHtml.indexOf('Дніпропетровська область'); // started 10:40
const idxKharkiv = alertsHtml.indexOf('Харківська область'); // started 10:36
assert.strictEqual(idxDnipro < idxKharkiv, true, 'Дніпро (10:40) має бути перед Харковом (10:36)');
console.log('✅ [PASS] Test 7: Сортування строго за started_at (найновіша 10:40 йде перед 10:36)');

console.log('\n🎉 ВСІ 7 ТЕСТІВ РЕЖИМІВ ТРИВОГ УСПІШНО ПРОЙДЕНО!');
