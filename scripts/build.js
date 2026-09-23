/**
 * scripts/build.js
 * Production build script for RADAR — GitHub Pages deployment.
 * 
 * Prepares the distribution bundle in `dist/` with:
 * - Complete assets, icons, sounds, and GeoJSON boundaries
 * - SPA 404 fallback (404.html)
 * - GitHub Pages .nojekyll flag
 * - Validation of critical production assets
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'public');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

console.log('🚀 [BUILD] Початок збірки для GitHub Pages (artemanoh/radar_Ukraine)...');
console.log(`📁 Source: ${SRC_DIR}`);
console.log(`📁 Target: ${DIST_DIR}`);

if (!fs.existsSync(SRC_DIR)) {
  console.error(`❌ Помилка: Вихідна папка ${SRC_DIR} не знайдена!`);
  process.exit(1);
}

// 1. Очищення або створення папки dist
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

// 2. Рекурсивне копіювання файлів
function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDirRecursive(SRC_DIR, DIST_DIR);
console.log('✅ Всі статичні файли з public/ успішно скопійовано в dist/');

// 3. Створення .nojekyll для відключення обробки Jekyll на GitHub Pages
const nojekyllPath = path.join(DIST_DIR, '.nojekyll');
fs.writeFileSync(nojekyllPath, '');
console.log('✅ Створено .nojekyll для GitHub Pages');

// 4. Створення 404.html як копії index.html для SPA роутингу на GitHub Pages
const indexPath = path.join(DIST_DIR, 'index.html');
const notFoundPath = path.join(DIST_DIR, '404.html');
if (fs.existsSync(indexPath)) {
  fs.copyFileSync(indexPath, notFoundPath);
  console.log('✅ Створено 404.html (fallback для прямої навігації)');
}

// 5. Валідація критичних файлів застосунку
const requiredFiles = [
  'index.html',
  '404.html',
  '.nojekyll',
  'app.js',
  'style.css',
  'territories.json',
  'ukraine_districts.geojson',
  'ukraine_regions.geojson',
  'sounds/siren.ogg',
  'sounds/chime.ogg',
  'vendor/leaflet.js',
  'vendor/leaflet.css',
  'vendor/images/marker-icon.png',
  'assets/icons/drone.svg',
  'assets/icons/missile.svg',
  'assets/icons/app_icon.svg',
  'favicon.svg',
  'manifest.json'
];

console.log('\n🔍 [VALIDATION] Перевірка цілісності збірки:');
let hasErrors = false;

for (const relFile of requiredFiles) {
  const filePath = path.join(DIST_DIR, relFile);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ ВІДСУТНІЙ КРИТИЧНИЙ ФАЙЛ: ${relFile}`);
    hasErrors = true;
    continue;
  }

  const stat = fs.statSync(filePath);
  if (stat.size === 0 && relFile !== '.nojekyll') {
    console.error(`❌ ПОРОЖНІЙ ФАЙЛ: ${relFile}`);
    hasErrors = true;
    continue;
  }

  const sizeStr = stat.size > 1024 * 1024 
    ? `${(stat.size / (1024 * 1024)).toFixed(2)} MB`
    : `${(stat.size / 1024).toFixed(1)} KB`;
  console.log(`  ✓ ${relFile.padEnd(35)} (${sizeStr})`);
}

if (hasErrors) {
  console.error('\n❌ Збірка завершилася з помилками валідації!');
  process.exit(1);
}

console.log('\n🎉 [BUILD SUCCESS] Продакшн-бандл успішно зібрано в dist/ готова до деплою на GitHub Pages!\n');
