const fs = require('fs');
const path = require('path');

// Load territories.json
const territoriesData = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/territories.json'), 'utf8'));

// Minimal environment to load TerritoriesManager from public/app.js
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

// Extract TerritoriesManager definition
const tmStartIndex = appJs.indexOf('const TerritoriesManager = {');
const tmEndMarker = '/* ============================================================';
const tmEndIndex = appJs.indexOf(tmEndMarker, tmStartIndex + 100);
const tmCode = appJs.substring(tmStartIndex, tmEndIndex);

// Evaluate TerritoriesManager
const sandbox = {
  console,
  Set,
  Map,
  Array,
  Math,
  RegExp,
  NEPTUN_REST_BASE: '',
  BASE_PATH: '',
  fetchUtf8Json: async () => territoriesData,
  FollowManager: { followedSet: new Set(), matchesFollowed: () => false },
  State: { selectedRegion: 'Вінницька область', selectedDistrict: 'Вінницький район', showEntireRegionWithDistrict: true }
};

const fn = new Function('sandbox', `
  with(sandbox) {
    ${tmCode}
    return TerritoriesManager;
  }
`);

const TM = fn(sandbox);
TM.hierarchy = territoriesData.hierarchy || [];
TM.flat = territoriesData.flat || [];
TM.buildIndices();

console.log('✅ Indices built successfully!');
console.log('Total Oblasts:', TM.allOblasts.size);
console.log('Total Districts:', TM.allDistricts.size);
console.log('Total Cities:', TM.allCities.size);

// Define comprehensive test cases
const tests = [
  {
    name: 'Poltava channel / message should NOT match Vinnytsia district',
    text: 'Шахед курсом на Полтаву!',
    channel: '@PoltavaRanger',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'Вінницький район',
    showOblastWide: true,
    expected: false
  },
  {
    name: 'Dnipro radar / message should NOT match Vinnytsia district',
    text: 'Вибух у передмісті Дніпра! Працює ППО.',
    channel: 'Радар Дніпра',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'Вінницький район',
    showOblastWide: true,
    expected: false
  },
  {
    name: 'Mykolaiv alert should NOT match Vinnytsia district',
    text: 'Миколаїв в укриття, ракета з півдня!',
    channel: '@nikalert',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'Вінницький район',
    showOblastWide: true,
    expected: false
  },
  {
    name: 'Vinnytsia city message SHOULD match Vinnytsia district',
    text: 'Вінниця — загроза БпЛА зі сходу! Перебувайте в укриттях.',
    channel: 'Вінниця ОВА',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'Вінницький район',
    showOblastWide: true,
    expected: true
  },
  {
    name: 'Vinnytsia district town (Стрижавка) SHOULD match Vinnytsia district',
    text: 'БпЛА над Стрижавкою в напрямку міста!',
    channel: 'Оперативний',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'Вінницький район',
    showOblastWide: true,
    expected: true
  },
  {
    name: 'Different district in same region (Haisyn/Ladyzhyn) with showOblastWide=false should NOT match Vinnytsia district',
    text: 'БпЛА над Ладижином курсом на Гайсин',
    channel: 'Вінниччина онлайн',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'Вінницький район',
    showOblastWide: false,
    expected: false
  },
  {
    name: 'Different district in same region (Haisyn/Ladyzhyn) with showOblastWide=true should NOT match Vinnytsia district because conflicting district is explicit',
    text: 'БпЛА курсом на Гайсин',
    channel: 'Вінниччина онлайн',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'Вінницький район',
    showOblastWide: true,
    expected: false
  },
  {
    name: 'Entire region warning (Вінницька область) with showOblastWide=true SHOULD match Vinnytsia district',
    text: 'Вінницька область — ракетна небезпека!',
    channel: 'Повітряні Сили ЗСУ',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'Вінницький район',
    showOblastWide: true,
    expected: true
  },
  {
    name: 'Entire region warning (Вінницька область) with showOblastWide=false should NOT match Vinnytsia district',
    text: 'Вінницька область — ракетна небезпека!',
    channel: 'Повітряні Сили ЗСУ',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'Вінницький район',
    showOblastWide: false,
    expected: false
  },
  {
    name: 'National event: MiG-31K takeoff SHOULD match any selected territory',
    text: 'Зліт МіГ-31К з аеродрому Саваслейка. Ракетна небезпека по всій Україні!',
    channel: 'Повітряні Сили ЗСУ',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'Вінницький район',
    showOblastWide: false,
    expected: true
  },
  {
    name: 'National event: all-Ukraine alert SHOULD match any selected territory',
    text: 'Повітряна тривога по всій території України!',
    channel: 'Тривога України',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'Вінницький район',
    showOblastWide: false,
    expected: true
  },
  {
    name: 'Kyiv alert should NOT match Vinnytsia region',
    text: 'Київ та Київська область — загроза балістичного озброєння!',
    channel: 'КМВА',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'all',
    showOblastWide: true,
    expected: false
  },
  {
    name: 'Kyiv city alert SHOULD match Kyiv region filter',
    text: 'Київ — вибухи в правобережній частині!',
    channel: 'КМВА',
    selectedRegion: 'Київ',
    selectedDistrict: 'all',
    showOblastWide: true,
    expected: true
  },
  {
    name: 'Generic message without territory in specific district SHOULD be filtered out',
    text: 'Увага! Відбій загрози.',
    channel: 'Канал',
    selectedRegion: 'Вінницька область',
    selectedDistrict: 'Вінницький район',
    showOblastWide: true,
    expected: false
  },
  {
    name: 'Generic message without territory in "all regions" SHOULD match',
    text: 'Увага! Відбій загрози.',
    channel: 'Канал',
    selectedRegion: 'all',
    selectedDistrict: 'all',
    showOblastWide: true,
    expected: true
  }
];

let passed = 0;
let failed = 0;

for (const tc of tests) {
  const parsed = TM.resolveMessageTerritory(tc.text, tc.channel);
  const match = TM.isMatchingTerritory(parsed, tc.selectedRegion, tc.selectedDistrict, tc.showOblastWide);
  const ok = match === tc.expected;
  if (ok) {
    passed++;
    console.log(`PASS: ${tc.name}`);
  } else {
    failed++;
    console.error(`FAIL: ${tc.name}`);
    console.error(`  Expected: ${tc.expected}, Got: ${match}`);
    console.error(`  Parsed:`, JSON.stringify(parsed));
  }
}

console.log(`\nTest results: ${passed}/${tests.length} passed (${failed} failed).`);
if (failed > 0) process.exit(1);
