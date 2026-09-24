const fs = require('fs');
const path = require('path');

// 1. Завантаження даних територій
const territoriesData = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/territories.json'), 'utf8'));

// 2. Читання коду з public/app.js
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

// Функція нормалізації з app.js
function normalizeName(str) {
  if (!str) return '';
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/^м\.\s*/i, '')
    .replace(/^місто\s*/i, '')
    .replace(/\s*район$/i, ' район')
    .replace(/\s*р-н$/i, ' район')
    .replace(/\s*область$/i, ' область')
    .replace(/\s*обл\.?$/i, ' область')
    .replace(/\s+/g, ' ');
}

// Витягуємо TerritoriesManager
const tmStartIndex = appJs.indexOf('const TerritoriesManager = {');
const tmEndMarker = '/* ============================================================';
const tmEndIndex = appJs.indexOf(tmEndMarker, tmStartIndex + 100);
const tmCode = appJs.substring(tmStartIndex, tmEndIndex);

// Витягуємо GlobalTerritoryFilter
const gtfStartIndex = appJs.indexOf('const GlobalTerritoryFilter = {');
const gtfEndMarker = '/* ============================================================';
const gtfEndIndex = appJs.indexOf(gtfEndMarker, gtfStartIndex + 100);
const gtfCode = appJs.substring(gtfStartIndex, gtfEndIndex);

const State = {
  selectedRegion: 'Вінницька область',
  selectedDistrict: 'all',
  showEntireRegionWithDistrict: true
};

const sandbox = {
  console,
  Set,
  Map,
  Array,
  Math,
  RegExp,
  normalizeName,
  NEPTUN_REST_BASE: '',
  BASE_PATH: '',
  fetchUtf8Json: async () => territoriesData,
  FollowManager: { followedSet: new Set(), matchesFollowed: () => false },
  State
};

const setupFn = new Function('sandbox', `
  with(sandbox) {
    ${tmCode}
    ${gtfCode}
    return { TerritoriesManager, GlobalTerritoryFilter };
  }
`);

const { TerritoriesManager: TM, GlobalTerritoryFilter: GTF } = setupFn(sandbox);
sandbox.TerritoriesManager = TM;
sandbox.GlobalTerritoryFilter = GTF;

TM.hierarchy = territoriesData.hierarchy || [];
TM.flat = territoriesData.flat || [];
TM.buildIndices();

console.log('✅ Індекси територій побудовано:');
console.log(`   Областей: ${TM.allOblasts.size}, Районів: ${TM.allDistricts.size}, Міст: ${TM.allCities.size}\n`);

// 18 обов'язкових тестів згідно розділу 16 технічного завдання
const mandatoryTests = [
  {
    id: 1,
    name: "Вибрана Вінницька область → повідомлення Вінницької області показується",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'all';
      return GTF.passes({
        type: 'INFORMATION',
        text: 'У Вінниці чутно звуки дронів, працює ППО',
        source: 'Вінниця ОВА'
      });
    },
    expected: true
  },
  {
    id: 2,
    name: "Вибрана Вінницька область → Полтавське повідомлення не показується",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'all';
      return GTF.passes({
        type: 'INFORMATION',
        text: 'Полтава укриття! Шахеди в напрямку міста з півночі',
        source: 'Полтавський вісник'
      });
    },
    expected: false
  },
  {
    id: 3,
    name: "Вибрана Вінницька область → Дніпровське повідомлення не показується",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'all';
      return GTF.passes({
        type: 'INFORMATION',
        text: 'Вибух у передмісті Дніпра! Працює ППО по розвіддрону',
        source: 'Радар Дніпра'
      });
    },
    expected: false
  },
  {
    id: 4,
    name: "Канал @PoltavaRanger пише про Вінницьку область → повідомлення показується (фільтр за змістом, а не каналом)",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'all';
      return GTF.passes({
        type: 'INFORMATION',
        text: 'Шахед заходить у повітряний простір Вінницької області курсом на захід!',
        source: '@PoltavaRanger'
      });
    },
    expected: true
  },
  {
    id: 5,
    name: "Канал з назвою Vinnytsia пише про іншу область → повідомлення не показується",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'all';
      return GTF.passes({
        type: 'INFORMATION',
        text: 'Тривога у Полтавській області, курс ворожих БпЛА на Кременчук',
        source: 'Вінниця Новини'
      });
    },
    expected: false
  },
  {
    id: 6,
    name: "Офіційна тривога іншої області → не показується",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'all';
      return GTF.passes({
        type: 'OFFICIAL_ALERT',
        oblastKey: 'полтавська область',
        oblastName: 'Полтавська область'
      });
    },
    expected: false
  },
  {
    id: 7,
    name: "Офіційна тривога вибраної області → показується",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'all';
      return GTF.passes({
        type: 'OFFICIAL_ALERT',
        oblastKey: 'вінницька область',
        oblastName: 'Вінницька область'
      });
    },
    expected: true
  },
  {
    id: 8,
    name: "Реальна ціль у вибраній території → подія показується",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'Вінницький район';
      return GTF.passes({
        type: 'THREAT',
        apiRegion: 'Вінницька область',
        apiDistrict: 'Вінницький район',
        apiLocality: 'Вінниця',
        text: 'Виявлено БпЛА Shahed-136'
      });
    },
    expected: true
  },
  {
    id: 9,
    name: "Реальна ціль поза вибраною територією → подія не показується",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'Вінницький район';
      return GTF.passes({
        type: 'THREAT',
        apiRegion: 'Полтавська область',
        apiDistrict: 'Полтавський район',
        text: 'Виявлено БпЛА Shahed-136'
      });
    },
    expected: false
  },
  {
    id: 10,
    name: "Launch event іншої території → не показується",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'all';
      return GTF.passes({
        type: 'LAUNCH',
        apiRegion: 'Автономна Республіка Крим',
        text: 'Зафіксовано пуск балістичної ракети з території Криму у бік Миколаєва'
      });
    },
    expected: false
  },
  {
    id: 11,
    name: "AI analysis іншої території → не показується",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'all';
      return GTF.passes({
        type: 'AI_ANALYSIS',
        title: 'ШІ: Полтавська область',
        text: 'Загроза застосування ударних БпЛА по об’єктах у Полтаві'
      });
    },
    expected: false
  },
  {
    id: 12,
    name: "Urgent event іншої території → не обходить фільтр (не показується)",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'all';
      return GTF.passes({
        type: 'THREAT',
        priority: 'URGENT',
        apiRegion: 'Харківська область',
        text: 'ТЕРМІНОВО: Пуск КАБ у напрямку Харкова!'
      });
    },
    expected: false
  },
  {
    id: 13,
    name: "Browser notification іншої території → не надсилається (passes повертає false)",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'all';
      const passes = GTF.passes({
        type: 'INFORMATION',
        text: 'Вибухи в Одесі! Працює ППО.',
        source: 'Думська'
      });
      // Оскільки passes === false, NotificationDispatcher негайно повертає false до виклику NotificationManager.send
      return passes;
    },
    expected: false
  },
  {
    id: 14,
    name: "Sound іншої території → не відтворюється (passes повертає false)",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'all';
      const passes = GTF.passes({
        type: 'THREAT',
        apiRegion: 'Дніпропетровська область',
        text: 'Ракета на Дніпро!'
      });
      // Оскільки passes === false, NotificationDispatcher негайно повертає false до виклику SoundService
      return passes;
    },
    expected: false
  },
  {
    id: 15,
    name: "Зміна області без reload → onTerritoryChanged існує і є функцією",
    fn: () => {
      return typeof GTF.onTerritoryChanged === 'function';
    },
    expected: true
  },
  {
    id: 16,
    name: "Загальнонаціональна подія (МіГ-31К по всій Україні) → показується для будь-якої області",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'Вінницький район';
      return GTF.passes({
        type: 'INFORMATION',
        text: 'Зліт МіГ-31К. Ракетна небезпека по всій Україні!',
        source: 'Повітряні Сили ЗСУ'
      });
    },
    expected: true
  },
  {
    id: 17,
    name: "Загальне повідомлення всієї області (Вінницька обл) при showEntireRegionWithDistrict=false → не показується у конкретному районі",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'Вінницький район';
      State.showEntireRegionWithDistrict = false;
      const res = GTF.passes({
        type: 'INFORMATION',
        text: 'Вінницька область — ракетна небезпека!',
        source: 'Повітряні Сили ЗСУ'
      });
      State.showEntireRegionWithDistrict = true; // скидаємо
      return res;
    },
    expected: false
  },
  {
    id: 18,
    name: "Населений пункт вибраного району (Стрижавка) → показується у Вінницькому районі",
    fn: () => {
      State.selectedRegion = 'Вінницька область';
      State.selectedDistrict = 'Вінницький район';
      State.showEntireRegionWithDistrict = true;
      return GTF.passes({
        type: 'INFORMATION',
        text: 'БпЛА над Стрижавкою курсом на південь',
        source: 'Оперативний'
      });
    },
    expected: true
  }
];

let passed = 0;
let failed = 0;

for (const test of mandatoryTests) {
  try {
    const result = test.fn();
    const ok = result === test.expected;
    if (ok) {
      passed++;
      console.log(`✅ [PASS] Тест ${test.id}: ${test.name}`);
    } else {
      failed++;
      console.error(`❌ [FAIL] Тест ${test.id}: ${test.name}`);
      console.error(`   Очікувалось: ${test.expected}, Отримано: ${result}`);
    }
  } catch (err) {
    failed++;
    console.error(`❌ [ERROR] Тест ${test.id}: ${test.name}`);
    console.error(`   Помилка виконання: ${err.message}`);
  }
}

console.log(`\n========================================`);
console.log(`Результати тестування: ${passed}/${mandatoryTests.length} пройдено (${failed} помилок)`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('🎉 Усі 18 обов’язкових тестів успішно пройдені!');
}
