/**
 * public/app.js
 * Головна архітектура синхронізації клієнта «РАДАР — Національний моніторинг повітряного простору».
 * 
 * Ключовий функціонал:
 * 1. 2D Кастомні SVG-іконки цілей: білий колір (#ffffff) із чіткою чорною окантовкою (#000000, 2px), різна форма.
 * 2. Зони тривоги: строго fillOpacity: 0.3 (30% підсвічування, 70% прозорості для читання назв міст).
 * 3. Скляний повзунок керування прозорістю зон небезпеки (on input).
 * 4. Модальне вікно "⚙️ Налаштування сповіщень":
 *    - Звук сирени (Web Audio API)
 *    - Браузерні Push-сповіщення (Notification API)
 *    - Фільтр домашнього регіону
 *    - Фільтри типів загроз (БПЛА, Ракети, Авіація, Розвідка)
 * 5. Глибока двостороння синхронізація:
 *    - Регіон <-> Карта (flyTo) <-> Стрічка
 *    - Ліве меню <-> Карта <-> Стрічка
 *    - Стрічка <-> Карта (клік робить flyTo з максимальним зумом)
 *    - Логіка сповіщень: звук та Push спрацьовують ТІЛЬКИ якщо загроза підпадає під налаштування.
 */

// Координати областей України для фокусування карти (flyTo)
const UKRAINE_REGIONS_COORDS = {
  'all': { center: [48.3794, 31.1656], zoom: 6 },
  'Вінницька область': { center: [49.2331, 28.4682], zoom: 9 },
  'Київська область': { center: [50.4501, 30.5234], zoom: 9 },
  'Харківська область': { center: [49.9935, 36.2304], zoom: 9 },
  'Дніпропетровська область': { center: [48.4647, 35.0462], zoom: 9 },
  'Одеська область': { center: [46.4825, 30.7233], zoom: 9 },
  'Львівська область': { center: [49.8397, 24.0297], zoom: 9 },
  'Запорізька область': { center: [47.8388, 35.1396], zoom: 9 },
  'Миколаївська область': { center: [46.9750, 31.9946], zoom: 9 },
  'Полтавська область': { center: [49.5883, 34.5514], zoom: 9 },
  'Черкаська область': { center: [49.4444, 32.0598], zoom: 9 },
  'Житомирська область': { center: [50.2547, 28.6587], zoom: 9 },
  'Сумська область': { center: [50.9077, 34.7981], zoom: 9 },
  'Чернігівська область': { center: [51.4982, 31.2893], zoom: 9 },
  'Хмельницька область': { center: [49.4230, 26.9871], zoom: 9 },
  'Рівненська область': { center: [50.6199, 26.2516], zoom: 9 },
  'Волинська область': { center: [50.7472, 25.3254], zoom: 9 },
  'Івано-Франківська область': { center: [48.9226, 24.7111], zoom: 9 },
  'Тернопільська область': { center: [49.5535, 25.5948], zoom: 9 },
  'Закарпатська область': { center: [48.6208, 22.2879], zoom: 9 },
  'Чернівецька область': { center: [48.2917, 25.9352], zoom: 9 },
  'Кіровоградська область': { center: [48.5079, 32.2623], zoom: 9 },
  'Херсонська область': { center: [46.6354, 32.6169], zoom: 9 },
  'Донецька область': { center: [48.0159, 37.8028], zoom: 9 },
  'Луганська область': { center: [48.5740, 39.3078], zoom: 9 },
  'Автономна Республіка Крим': { center: [44.9521, 34.1024], zoom: 9 }
};

/* ============================================================
   1. ОБ'ЄКТ МЕНЕДЖЕРА НАЛАШТУВАНЬ (LOCALSTORAGE)
============================================================ */
const NotificationSettings = {
  KEYS: {
    SETTINGS: 'radar_notification_settings',
    REGION: 'radar_selected_region',
    FILTER: 'radar_active_filter',
    OPACITY: 'radar_zone_opacity',
  },

  defaultSettings: {
    soundEnabled: false,
    pushEnabled: false,
    userRegion: 'all',
    allowedTypes: {
      bpla: true,
      missile: true,
      ballistic: true,
      avia: true,
      recon: true,
    }
  },

  getSettings() {
    try {
      const stored = localStorage.getItem(this.KEYS.SETTINGS);
      if (stored) {
        return { ...this.defaultSettings, ...JSON.parse(stored) };
      }
    } catch (e) {}
    return { ...this.defaultSettings };
  },

  saveSettings(settings) {
    localStorage.setItem(this.KEYS.SETTINGS, JSON.stringify(settings));
  },

  getZoneOpacity() {
    return parseFloat(localStorage.getItem(this.KEYS.OPACITY)) || 0.3;
  },

  setZoneOpacity(val) {
    localStorage.setItem(this.KEYS.OPACITY, val);
  }
};

/* ============================================================
   2. ГЛОБАЛЬНИЙ СТАН ДОДАТКУ (APP STATE)
============================================================ */
const AppState = {
  selectedRegion: 'all',
  activeFilter: 'all',
  zoneOpacity: 0.3,
  targets: new Map(), // id -> target object
  mapLayers: new Map(), // id -> { marker, circle }
  settings: NotificationSettings.getSettings(),
  audioCtx: null,
};

/* ============================================================
   3. ГЕНЕРАЦІЯ 2D КАСТОМНИХ SVG ІКОНОК (БІЛІ З ЧОРНИМ КОНТУРОМ)
============================================================ */
function createTarget2dSvg(type) {
  let shapeHtml = '';

  if (type === 'ballistic') {
    // Гостроверхий балістичний конус
    shapeHtml = `
      <polygon points="16,2 9,23 16,19 23,23" fill="#ffffff" stroke="#000000" stroke-width="2.5" stroke-linejoin="round"/>
      <line x1="16" y1="5" x2="16" y2="18" stroke="#000000" stroke-width="2"/>
    `;
  } else if (type === 'missile' || type === 'cruise_missile') {
    // Крилата ракета з прямими крилами
    shapeHtml = `
      <polygon points="16,3 12,18 14,26 18,26 20,18" fill="#ffffff" stroke="#000000" stroke-width="2.5" stroke-linejoin="round"/>
      <polygon points="12,16 3,21 11,22" fill="#ffffff" stroke="#000000" stroke-width="2" stroke-linejoin="round"/>
      <polygon points="20,16 29,21 21,22" fill="#ffffff" stroke="#000000" stroke-width="2" stroke-linejoin="round"/>
    `;
  } else if (type === 'avia') {
    // Силует тактичного літака
    shapeHtml = `
      <polygon points="16,3 13,13 3,19 13,20 13,27 10,29 16,28 22,29 19,27 19,20 29,19 19,13" fill="#ffffff" stroke="#000000" stroke-width="2.5" stroke-linejoin="round"/>
    `;
  } else if (type === 'recon') {
    // Розвідник (ромб з ядром/лінзою)
    shapeHtml = `
      <polygon points="16,4 27,16 16,28 5,16" fill="#ffffff" stroke="#000000" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="16" cy="16" r="4.5" fill="#000000"/>
    `;
  } else {
    // bpla (Ударний дельтовидний дрон Шахед)
    shapeHtml = `
      <polygon points="16,4 6,24 16,20 26,24" fill="#ffffff" stroke="#000000" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="16" cy="14" r="2.5" fill="#000000"/>
    `;
  }

  return `
    <div style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));">
      <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        ${shapeHtml}
      </svg>
    </div>
  `;
}

function getLeafletDivIcon(type) {
  return L.divIcon({
    html: createTarget2dSvg(type),
    className: 'custom-2d-target-icon',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
  });
}

/* ============================================================
   4. СИНТЕЗАТОР ЗВУКУ СИРЕНИ (WEB AUDIO API)
============================================================ */
function playSirenSound() {
  try {
    if (!AppState.audioCtx) {
      AppState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (AppState.audioCtx.state === 'suspended') {
      AppState.audioCtx.resume();
    }

    const ctx = AppState.audioCtx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    // Двотоновий сигнал повітряної тривоги
    osc.frequency.setValueAtTime(650, now);
    osc.frequency.exponentialRampToValueAtTime(950, now + 0.35);
    osc.frequency.exponentialRampToValueAtTime(650, now + 0.75);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.85);
  } catch (err) {
    console.warn('[Audio Play Error]', err);
  }
}

/* ============================================================
   5. БРАУЗЕРНІ PUSH-СПОВІЩЕННЯ (NOTIFICATION API)
============================================================ */
function showPushNotification(target) {
  if (!("Notification" in window)) return;

  if (Notification.permission === "granted") {
    const typeTitle = target.type === 'ballistic' ? 'БАЛІСТИКА' : target.type === 'missile' ? 'КРИЛАТА РАКЕТА' : 'УДАРНИЙ БПЛА';
    new Notification(`🚨 РАДАР: ${typeTitle}`, {
      body: `Загроза у напрямку: ${target.district} (${target.region}). Час: ${target.time}`,
      icon: 'https://cdn-icons-png.flaticon.com/512/564/564619.png',
    });
  }
}

/* ============================================================
   6. ПЕРЕВІРКА ПРАВИЛ СПОВІЩЕНЬ ПРИ NEW_TARGET
============================================================ */
function handleTargetNotifications(target) {
  const settings = AppState.settings;

  // 1. Перевірка фільтру домашнього регіону
  if (settings.userRegion !== 'all' && settings.userRegion !== target.region) {
    return; // Не стосується регіону користувача
  }

  // 2. Перевірка типу загрози
  let typeKey = 'bpla';
  if (target.type === 'missile' || target.type === 'cruise_missile' || target.type === 'ballistic') {
    typeKey = 'missile';
  } else if (target.type === 'avia') {
    typeKey = 'avia';
  } else if (target.type === 'recon') {
    typeKey = 'recon';
  }

  if (settings.allowedTypes && settings.allowedTypes[typeKey] === false) {
    return; // Цей тип загрози вимкнено користувачем
  }

  // Якщо всі перевірки пройдено — сповіщаємо!
  if (settings.soundEnabled) {
    playSirenSound();
  }

  if (settings.pushEnabled) {
    showPushNotification(target);
  }
}

/* ============================================================
   7. МОДУЛЬ КАРТИ (LEAFLET + ESRI DARK GRAY CANVAS)
============================================================ */
let mapInstance = null;

function initMap() {
  mapInstance = L.map('map', {
    center: [48.3794, 31.1656],
    zoom: 6,
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
  });

  // ВАЖЛИВО: Esri Dark Gray Canvas без водяних знаків Carto
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    maxZoom: 16,
    minZoom: 4,
  }).addTo(mapInstance);

  // Перевірка збереженої області
  const savedRegion = localStorage.getItem(NotificationSettings.KEYS.REGION) || 'all';
  if (savedRegion !== 'all' && UKRAINE_REGIONS_COORDS[savedRegion]) {
    const r = UKRAINE_REGIONS_COORDS[savedRegion];
    mapInstance.setView(r.center, r.zoom);
  }
}

function renderTargetOnMap(target) {
  if (AppState.mapLayers.has(target.id)) {
    removeTargetFromMap(target.id, false);
  }

  const { id, type, region, district, lat, lng, radius_km, alertLevel_color, time } = target;

  // 1. Маркер із 2D SVG-іконкою
  const marker = L.marker([lat, lng], {
    icon: getLeafletDivIcon(type),
    title: `${district} (${type})`,
  });

  const isDanger = type === 'ballistic' || type === 'missile' || type === 'cruise_missile';
  const typeText = type === 'ballistic' ? '🚀 БАЛІСТИЧНА РАКЕТА' : (type === 'missile' || type === 'cruise_missile') ? '🚀 КРИЛАТА РАКЕТА' : type === 'avia' ? '✈ АВІАЦІЯ' : type === 'recon' ? '🛰️ РОЗВІДУВАЛЬНИЙ БПЛА' : '🛸 УДАРНИЙ БПЛА';
  const badgeColor = isDanger ? 'text-red-400' : 'text-amber-400';

  const popupHtml = `
    <div class="font-sans text-xs">
      <div class="flex items-center justify-between pb-1 mb-1.5 border-b border-white/10">
        <span class="font-bold tracking-wider ${badgeColor}">${typeText}</span>
        <span class="text-[10px] text-gray-400 font-mono">${time}</span>
      </div>
      <p class="font-semibold text-gray-100 text-sm">${district}</p>
      <p class="text-gray-400 font-mono text-[11px]">${region}</p>
      <div class="mt-2 pt-1 border-t border-white/10 flex items-center justify-between text-[11px] font-mono text-gray-300">
        <span>Зона тривоги:</span>
        <span class="font-bold text-blue-400">${radius_km || 15} км</span>
      </div>
    </div>
  `;
  marker.bindPopup(popupHtml, { className: 'custom-leaflet-popup' });

  // 2. Зона тривоги (коло)
  // ВАЖЛИВО: Опасіті строго fillOpacity: 0.3 (30% підсвітка, 70% прозорості для читання назв міст)
  const circle = L.circle([lat, lng], {
    radius: (radius_km || 15) * 1000,
    color: alertLevel_color || '#f59e0b',
    fillColor: alertLevel_color || '#f59e0b',
    fillOpacity: AppState.zoneOpacity, // строго 0.3 за замовчуванням
    weight: 2,
    className: isDanger ? 'pulse-circle-danger' : 'pulse-circle-warning',
  });

  const layerObj = { target, marker, circle };
  AppState.mapLayers.set(id, layerObj);

  if (isTargetMatchingFilters(target)) {
    circle.addTo(mapInstance);
    marker.addTo(mapInstance);
  }
}

function removeTargetFromMap(id, withFade = true) {
  if (!AppState.mapLayers.has(id)) return;
  const obj = AppState.mapLayers.get(id);

  if (withFade && obj.marker && obj.marker.getElement()) {
    obj.marker.getElement().classList.add('fade-out');
  }

  setTimeout(() => {
    if (obj.marker) mapInstance.removeLayer(obj.marker);
    if (obj.circle) mapInstance.removeLayer(obj.circle);
    AppState.mapLayers.delete(id);
  }, withFade ? 1000 : 0);
}

function isTargetMatchingFilters(target) {
  // Фільтр лівого меню
  let matchesType = true;
  if (AppState.activeFilter === 'bpla') {
    matchesType = target.type === 'bpla';
  } else if (AppState.activeFilter === 'missile') {
    matchesType = target.type === 'missile' || target.type === 'cruise_missile' || target.type === 'ballistic';
  } else if (AppState.activeFilter === 'avia') {
    matchesType = target.type === 'avia';
  } else if (AppState.activeFilter === 'recon') {
    matchesType = target.type === 'recon';
  }

  // Фільтр селектора області
  const matchesRegion = AppState.selectedRegion === 'all' || target.region === AppState.selectedRegion;

  return matchesType && matchesRegion;
}

function updateMapLayersVisibility() {
  AppState.mapLayers.forEach(({ target, marker, circle }) => {
    if (isTargetMatchingFilters(target)) {
      if (!mapInstance.hasLayer(marker)) {
        circle.addTo(mapInstance);
        marker.addTo(mapInstance);
      }
    } else {
      if (mapInstance.hasLayer(marker)) {
        mapInstance.removeLayer(marker);
        mapInstance.removeLayer(circle);
      }
    }
  });
}

function updateAllZonesOpacity(opacity) {
  AppState.zoneOpacity = opacity;
  NotificationSettings.setZoneOpacity(opacity);

  AppState.mapLayers.forEach(({ circle }) => {
    if (circle) {
      circle.setStyle({ fillOpacity: opacity });
    }
  });
}

/* ============================================================
   8. ОПЕРАТИВНА СТРІЧКА ПОДІЙ ТА UI
============================================================ */
function renderFeedList() {
  const feedContainer = document.getElementById('alerts-feed');
  const placeholder = document.getElementById('no-alerts-placeholder');
  const feedBadge = document.getElementById('feed-count-badge');
  const activeBadge = document.getElementById('active-count-badge');

  const visibleList = Array.from(AppState.targets.values())
    .filter(isTargetMatchingFilters)
    .sort((a, b) => b.timestamp - a.timestamp);

  const count = visibleList.length;
  activeBadge.textContent = count;
  feedBadge.textContent = `${count} подій`;

  if (count > 0) {
    activeBadge.className = 'font-bold text-red-400 font-mono';
    placeholder.classList.add('hidden');
  } else {
    activeBadge.className = 'font-bold text-emerald-400 font-mono';
    placeholder.classList.remove('hidden');
  }

  feedContainer.querySelectorAll('.feed-card').forEach(el => el.remove());

  visibleList.forEach(target => {
    const card = document.createElement('div');
    card.className = 'feed-card liquid-glass-card p-3 rounded-xl cursor-pointer flex flex-col space-y-1.5';

    const isDanger = target.type === 'ballistic' || target.type === 'missile' || target.type === 'cruise_missile';
    const typeLabel = target.type === 'ballistic' ? 'БАЛІСТИКА' : (target.type === 'missile' || target.type === 'cruise_missile') ? 'РАКЕТА' : target.type === 'avia' ? 'АВІАЦІЯ' : target.type === 'recon' ? 'РОЗВІДКА' : 'БПЛА';
    const tagBg = isDanger ? 'bg-red-500/20 text-red-300 border-red-500/30' : target.type === 'avia' ? 'bg-sky-500/20 text-sky-300 border-sky-500/30' : target.type === 'recon' ? 'bg-purple-500/20 text-purple-300 border-purple-500/30' : 'bg-amber-500/20 text-amber-300 border-amber-500/30';

    card.innerHTML = `
      <div class="flex items-center justify-between">
        <span class="px-2 py-0.5 rounded text-[10px] font-bold border font-mono ${tagBg}">${typeLabel}</span>
        <span class="text-[11px] text-gray-400 font-mono">${target.time}</span>
      </div>
      <p class="text-xs font-semibold text-gray-100">${target.district}</p>
      <p class="text-[11px] text-gray-400 font-mono">${target.region}</p>
    `;

    // Клік по картці робить flyTo з максимальним зумом (zoom 11) на маркер
    card.addEventListener('click', () => {
      mapInstance.flyTo([target.lat, target.lng], 11, { duration: 1.4 });
      const layer = AppState.mapLayers.get(target.id);
      if (layer && layer.marker) {
        layer.marker.openPopup();
      }
    });

    feedContainer.appendChild(card);
  });
}

/* ============================================================
   9. НАЛАШТУВАННЯ ПОДІЙ ІНТЕРФЕЙСУ ТА МОДАЛЬНИХ ВІКОН
============================================================ */
function setupEventHandlers() {
  // 1. Селектор області (Регіон <-> Карта <-> Стрічка)
  const selectRegion = document.getElementById('select-region');
  selectRegion.value = AppState.selectedRegion;

  selectRegion.addEventListener('change', (e) => {
    const region = e.target.value;
    AppState.selectedRegion = region;
    localStorage.setItem(NotificationSettings.KEYS.REGION, region);

    const targetCoords = UKRAINE_REGIONS_COORDS[region] || UKRAINE_REGIONS_COORDS.all;
    mapInstance.flyTo(targetCoords.center, targetCoords.zoom, { duration: 1.5 });

    updateMapLayersVisibility();
    renderFeedList();
  });

  // 2. Ліве меню (Фільтри типів цілей)
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      AppState.activeFilter = btn.dataset.filter;
      localStorage.setItem(NotificationSettings.KEYS.FILTER, AppState.activeFilter);

      document.querySelectorAll('.filter-btn').forEach(b => {
        if (b === btn) {
          b.classList.add('bg-blue-600/80', 'text-white', 'border-blue-400/40');
          b.classList.remove('text-gray-200');
        } else {
          b.classList.remove('bg-blue-600/80', 'text-white', 'border-blue-400/40');
          b.classList.add('text-gray-200');
        }
      });

      updateMapLayersVisibility();
      renderFeedList();
    });
  });

  // 3. Скляний повзунок прозорості зон
  const rangeOpacity = document.getElementById('range-zone-opacity');
  const opacityDisplay = document.getElementById('opacity-value-display');

  rangeOpacity.value = AppState.zoneOpacity;
  opacityDisplay.textContent = `${Math.round(AppState.zoneOpacity * 100)}%`;

  rangeOpacity.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    opacityDisplay.textContent = `${Math.round(val * 100)}%`;
    updateAllZonesOpacity(val);
  });

  // 4. Модальне вікно "Налаштування сповіщень"
  const settingsModal = document.getElementById('settings-modal');
  const btnOpenSettings = document.getElementById('btn-open-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnSaveSettings = document.getElementById('btn-save-settings');

  const settingSound = document.getElementById('setting-sound');
  const settingPush = document.getElementById('setting-push');
  const settingUserRegion = document.getElementById('setting-user-region');
  const notifyBpla = document.getElementById('notify-bpla');
  const notifyMissile = document.getElementById('notify-missile');
  const notifyAvia = document.getElementById('notify-avia');
  const notifyRecon = document.getElementById('notify-recon');

  btnOpenSettings.addEventListener('click', () => {
    // Підставляємо збережені значення
    const s = AppState.settings;
    settingSound.checked = s.soundEnabled;
    settingPush.checked = s.pushEnabled;
    settingUserRegion.value = s.userRegion || 'all';
    notifyBpla.checked = s.allowedTypes?.bpla ?? true;
    notifyMissile.checked = s.allowedTypes?.missile ?? true;
    notifyAvia.checked = s.allowedTypes?.avia ?? true;
    notifyRecon.checked = s.allowedTypes?.recon ?? true;

    settingsModal.classList.remove('hidden');
  });

  btnCloseSettings.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  // Запит прав на Push-сповіщення при перемиканні тогла
  settingPush.addEventListener('change', async () => {
    if (settingPush.checked && ("Notification" in window)) {
      if (Notification.permission !== "granted") {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
          settingPush.checked = false;
          alert("Браузерні сповіщення були заблоковані або відхилені у дозволах.");
        }
      }
    }
  });

  btnSaveSettings.addEventListener('click', () => {
    AppState.settings = {
      soundEnabled: settingSound.checked,
      pushEnabled: settingPush.checked,
      userRegion: settingUserRegion.value,
      allowedTypes: {
        bpla: notifyBpla.checked,
        missile: notifyMissile.checked,
        avia: notifyAvia.checked,
        recon: notifyRecon.checked,
      }
    };

    NotificationSettings.saveSettings(AppState.settings);
    settingsModal.classList.add('hidden');

    if (AppState.settings.soundEnabled) {
      playSirenSound(); // короткий тестовий звук для перевірки
    }
  });

  // 5. Мобільний тогл бічної панелі
  const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
  const sidebarPanel = document.getElementById('sidebar-panel');
  if (btnToggleSidebar && sidebarPanel) {
    btnToggleSidebar.addEventListener('click', () => {
      sidebarPanel.classList.toggle('translate-x-[110%]');
    });
  }

  // 6. Модальне вікно симуляції цілей
  const simModal = document.getElementById('simulate-modal');
  const btnOpenSim = document.getElementById('btn-open-simulate-modal');
  const btnCloseSim = document.getElementById('btn-close-simulate');
  const btnCancelSim = document.getElementById('btn-cancel-simulate');

  btnOpenSim.addEventListener('click', () => simModal.classList.remove('hidden'));
  btnCloseSim.addEventListener('click', () => simModal.classList.add('hidden'));
  btnCancelSim.addEventListener('click', () => simModal.classList.add('hidden'));

  document.querySelectorAll('.btn-sample-sim').forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.type;
      const region = btn.dataset.region;
      const district = btn.dataset.district;

      try {
        await fetch('/api/targets/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, region, district }),
        });
        simModal.classList.add('hidden');
      } catch (err) {
        console.error('[Simulate Request Error]', err);
      }
    });
  });
}

/* ============================================================
   10. REAL-TIME ЗВ'ЯЗОК SOCKET.IO
============================================================ */
function setupSockets() {
  const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
  });

  const connDot = document.getElementById('conn-dot');
  const connPing = document.getElementById('conn-ping');
  const statusText = document.getElementById('system-status-text');

  socket.on('connect', () => {
    console.log('[Socket] З\'єднання встановлено:', socket.id);
    connDot.className = 'relative inline-flex rounded-full h-3 w-3 bg-emerald-500';
    connPing.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75';
    statusText.textContent = 'З\'єднання активне';
  });

  socket.on('disconnect', () => {
    console.warn('[Socket] З\'єднання розірвано!');
    connDot.className = 'relative inline-flex rounded-full h-3 w-3 bg-red-500';
    connPing.className = 'hidden';
    statusText.textContent = 'Відновлення зв\'язку...';
  });

  // Отримання початкового масиву цілей
  socket.on('initial_targets', (targets) => {
    AppState.targets.clear();
    targets.forEach(t => {
      AppState.targets.set(t.id, t);
      renderTargetOnMap(t);
    });
    renderFeedList();
  });

  // Отримання події new_target
  socket.on('new_target', (target) => {
    console.log('[Socket: new_target]', target);
    AppState.targets.set(target.id, target);
    renderTargetOnMap(target);
    renderFeedList();

    // Перевірка та виклик звукових або Push-сповіщень
    handleTargetNotifications(target);
  });

  // Отримання події target_cleared (архівація)
  socket.on('target_cleared', ({ id }) => {
    console.log('[Socket: target_cleared]', id);
    AppState.targets.delete(id);
    removeTargetFromMap(id);
    renderFeedList();
  });
}

/* ============================================================
   СТАРТ КЛІЄНТСЬКОГО ДОДАТКУ
============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // Відновлюємо налаштування з localStorage
  AppState.selectedRegion = localStorage.getItem(NotificationSettings.KEYS.REGION) || 'all';
  AppState.activeFilter = localStorage.getItem(NotificationSettings.KEYS.FILTER) || 'all';
  AppState.zoneOpacity = NotificationSettings.getZoneOpacity();

  initMap();
  setupEventHandlers();
  setupSockets();

  console.log('🚀 [РАДАР УКРАЇНА] Інтерфейс Liquid Glass успішно завантажено!');
});
