/**
 * app.js
 * Клієнтська логіка системи "РАДАР" (Україна).
 * Ініціалізація Leaflet.js з темними тайлами CartoDB Dark Matter,
 * Socket.io зв'язок у реальному часі, SVG-маркери, пульсуючі кола загрози,
 * напрямкові вектори, Web Audio API сирена, стрічка подій та вибір регіонів.
 */

// Координати ключових регіонів України для швидкої навігації
const REGION_COORDINATES = {
  all: { center: [49.0139, 31.2858], zoom: 6 },
  vinnytsia: { center: [49.2331, 28.4682], zoom: 8 },
  kyiv: { center: [50.4501, 30.5234], zoom: 8 },
  kharkiv: { center: [49.9935, 36.2304], zoom: 8 },
  dnipro: { center: [48.4647, 35.0462], zoom: 8 },
  odessa: { center: [46.4825, 30.7233], zoom: 8 },
  lviv: { center: [49.8397, 24.0297], zoom: 8 },
  zaporizhzhia: { center: [47.8388, 35.1396], zoom: 8 },
  mykolaiv: { center: [46.9750, 31.9946], zoom: 8 },
  poltava: { center: [49.5883, 34.5514], zoom: 8 },
  cherkasy: { center: [49.4444, 32.0598], zoom: 8 },
  zhytomyr: { center: [50.2547, 28.6587], zoom: 8 },
  sumy: { center: [50.9077, 34.7981], zoom: 8 },
  chernihiv: { center: [51.4982, 31.2893], zoom: 8 },
  khmelnytskyi: { center: [49.4230, 26.9871], zoom: 8 },
  rivne: { center: [50.6199, 26.2516], zoom: 8 },
  volyn: { center: [50.7472, 25.3254], zoom: 8 },
  ivano_frankivsk: { center: [48.9226, 24.7111], zoom: 8 },
  ternopil: { center: [49.5535, 25.5948], zoom: 8 },
  zakarpattia: { center: [48.6208, 22.2879], zoom: 8 },
  chernivtsi: { center: [48.2917, 25.9352], zoom: 8 },
  kirovohrad: { center: [48.5079, 32.2623], zoom: 8 },
  kherson: { center: [46.6354, 32.6169], zoom: 8 },
  donetsk: { center: [48.0159, 37.8028], zoom: 8 },
  luhansk: { center: [48.5740, 39.3078], zoom: 8 },
};

// Стан програми
const state = {
  map: null,
  activeFilter: 'all',
  soundEnabled: false,
  audioContext: null,
  alerts: new Map(), // id -> { data, marker, circle, line }
};

/* ============================================================
   1. ІНІЦІАЛІЗАЦІЯ КАРТИ LEAFLET
============================================================ */

function initMap() {
  // Стартовий вид: центр України
  state.map = L.map('map', {
    center: [49.0139, 31.2858],
    zoom: 6,
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
  });

  // CartoDB Dark Matter тайли (контрастна темна карта)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>, &copy; <a href="https://openstreetmap.org">OSM</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(state.map);
}

/* ============================================================
   2. ГЕНЕРАЦІЯ SVG-ІКОНОК ДЛЯ РІЗНИХ ТИПІВ ЗАГРОЗ
============================================================ */

function getTargetSvg(type, azimuth) {
  const rotation = typeof azimuth === 'number' ? azimuth : 0;
  
  // Кольори для типів загроз
  let color = '#f59e0b'; // бурштиновий для БПЛА
  let svgContent = '';

  if (type === 'missile') {
    color = '#ef4444'; // червоний для ракет
    svgContent = `
      <polygon points="16,3 12,17 14,24 18,24 20,17" fill="${color}" stroke="#ffffff" stroke-width="1.2"/>
      <polygon points="12,17 7,22 11,23" fill="${color}"/>
      <polygon points="20,17 25,22 21,23" fill="${color}"/>
    `;
  } else if (type === 'avia') {
    color = '#06b6d4'; // ціан для авіації
    svgContent = `
      <polygon points="16,4 13,14 3,19 13,20 13,26 10,28 16,27 22,28 19,26 19,20 29,19 19,14" fill="${color}" stroke="#ffffff" stroke-width="1"/>
    `;
  } else {
    // shahed або recon (дрон)
    color = '#f59e0b';
    svgContent = `
      <polygon points="16,5 7,23 16,19 25,23" fill="${color}" stroke="#ffffff" stroke-width="1.2"/>
      <circle cx="16" cy="14" r="2.5" fill="#ffffff"/>
    `;
  }

  return `
    <div style="transform: rotate(${rotation}deg); width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 0 6px ${color});">
      <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        ${svgContent}
      </svg>
    </div>
  `;
}

function createCustomIcon(type, azimuth) {
  return L.divIcon({
    html: getTargetSvg(type, azimuth),
    className: 'custom-radar-marker',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
  });
}

/* ============================================================
   3. УПРАВЛІННЯ ОБ'ЄКТАМИ НА КАРТІ
============================================================ */

/**
 * Розрахунок кінцевої точки вектора за азимутом і відстанню
 */
function calculateVectorEndpoint(lat, lng, azimuthDeg, distanceKm = 25) {
  const R = 6371; // Радіус Землі у км
  const rad = azimuthDeg * (Math.PI / 180);
  const latRad = lat * (Math.PI / 180);
  const lngRad = lng * (Math.PI / 180);
  const dByR = distanceKm / R;

  const destLatRad = Math.asin(
    Math.sin(latRad) * Math.cos(dByR) +
    Math.cos(latRad) * Math.sin(dByR) * Math.cos(rad)
  );

  const destLngRad = lngRad + Math.atan2(
    Math.sin(rad) * Math.sin(dByR) * Math.cos(latRad),
    Math.cos(dByR) - Math.sin(latRad) * Math.sin(destLatRad)
  );

  return [destLatRad * (180 / Math.PI), destLngRad * (180 / Math.PI)];
}

/**
 * Додавання або оновлення загрози на карті
 */
function renderAlertOnMap(alert) {
  // Якщо об'єкт вже є на карті — оновлюємо
  if (state.alerts.has(alert.id)) {
    removeAlertFromMap(alert.id);
  }

  const { id, type, lat, lng, radius, azimuth, location_name, timestamp } = alert;

  // 1. Маркер об'єкта
  const marker = L.marker([lat, lng], {
    icon: createCustomIcon(type, azimuth),
    title: `${location_name} (${type})`,
  });

  // Popup з деталями
  const dateFormatted = new Date(timestamp).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  const popupHtml = `
    <div class="font-sans">
      <div class="flex items-center justify-between pb-1 mb-1 border-b border-gray-700">
        <span class="text-xs font-bold uppercase tracking-wider text-${type === 'missile' ? 'red' : 'amber'}-400">
          ${type === 'missile' ? '🚀 РАКЕТА' : type === 'avia' ? '✈ АВІАЦІЯ' : '🛸 БПЛА (SHAHED)'}
        </span>
        <span class="text-[10px] text-gray-400">${dateFormatted}</span>
      </div>
      <p class="text-xs font-semibold text-gray-100">${location_name}</p>
      <div class="mt-1 text-[11px] text-gray-400 space-y-0.5 font-mono">
        <div>Радіус зони: <span class="text-gray-200">${radius || 15} км</span></div>
        <div>Напрямок: <span class="text-gray-200">${azimuth !== null ? azimuth + '°' : 'Встановлюється'}</span></div>
        <div>Координати: <span class="text-gray-200">${lat.toFixed(4)}, ${lng.toFixed(4)}</span></div>
      </div>
    </div>
  `;
  marker.bindPopup(popupHtml, { className: 'custom-leaflet-popup' });

  // 2. Пульсуюче коло небезпеки
  const circleColor = type === 'missile' ? '#ef4444' : '#f59e0b';
  const pulseClass = type === 'missile' ? 'pulse-circle-danger' : 'pulse-circle-warning';

  const circle = L.circle([lat, lng], {
    radius: (radius || 15) * 1000,
    color: circleColor,
    fillColor: circleColor,
    fillOpacity: 0.2,
    weight: 2,
    className: pulseClass,
  });

  // 3. Векторна лінія напрямку руху (якщо є азимут)
  let line = null;
  if (typeof azimuth === 'number') {
    const endPoint = calculateVectorEndpoint(lat, lng, azimuth, 25);
    line = L.polyline([[lat, lng], endPoint], {
      color: circleColor,
      weight: 2,
      dashArray: '6, 6',
      opacity: 0.85,
    });
  }

  // Додавання на карту (якщо відповідає активному фільтру)
  const isVisible = state.activeFilter === 'all' || state.activeFilter === type;
  if (isVisible) {
    circle.addTo(state.map);
    if (line) line.addTo(state.map);
    marker.addTo(state.map);
  }

  state.alerts.set(id, {
    data: alert,
    marker,
    circle,
    line,
  });

  updateFeedBadge();
  updateFeedUI();
}

/**
 * Плавне видалення (fade-out) маркера з карти
 */
function removeAlertFromMap(id) {
  if (!state.alerts.has(id)) return;

  const item = state.alerts.get(id);

  // Додаємо CSS клас fade-out для плавної анімації зникнення
  if (item.marker && item.marker.getElement()) {
    item.marker.getElement().classList.add('fade-out');
  }

  setTimeout(() => {
    if (item.marker) state.map.removeLayer(item.marker);
    if (item.circle) state.map.removeLayer(item.circle);
    if (item.line) state.map.removeLayer(item.line);
    state.alerts.delete(id);
    updateFeedBadge();
    updateFeedUI();
  }, 1000);
}

/**
 * Фільтрація об'єктів на карті
 */
function applyFilter(filterType) {
  state.activeFilter = filterType;

  state.alerts.forEach(({ data, marker, circle, line }) => {
    const shouldShow = filterType === 'all' || data.type === filterType;
    if (shouldShow) {
      if (!state.map.hasLayer(marker)) {
        marker.addTo(state.map);
        circle.addTo(state.map);
        if (line) line.addTo(state.map);
      }
    } else {
      if (state.map.hasLayer(marker)) {
        state.map.removeLayer(marker);
        state.map.removeLayer(circle);
        if (line) state.map.removeLayer(line);
      }
    }
  });

  // Оновлення активного стану кнопок фільтрації
  document.querySelectorAll('.filter-btn').forEach(btn => {
    if (btn.dataset.filter === filterType) {
      btn.classList.add('bg-blue-600', 'text-white');
      btn.classList.remove('bg-gray-800', 'text-amber-400', 'text-red-400', 'text-cyan-400');
    } else {
      btn.classList.remove('bg-blue-600', 'text-white');
      btn.classList.add('bg-gray-800');
    }
  });

  updateFeedUI();
}

/* ============================================================
   4. WEB AUDIO API (СИРЕНА ТА АКУСТИЧНЕ ОПОВІЩЕННЯ)
============================================================ */

function initAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (state.audioContext.state === 'suspended') {
    state.audioContext.resume();
  }
}

/**
 * Програвання короткого звуку тривоги (синтезований сигнал)
 */
function playAlarmSound() {
  if (!state.soundEnabled) return;

  try {
    initAudioContext();
    const ctx = state.audioContext;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    // Двотоновий сигнал тривоги
    osc.frequency.setValueAtTime(650, now);
    osc.frequency.exponentialRampToValueAtTime(950, now + 0.35);
    osc.frequency.exponentialRampToValueAtTime(650, now + 0.7);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.3, now + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.85);
  } catch (err) {
    console.warn('[Audio Alert Error]', err);
  }
}

/* ============================================================
   5. ОНОВЛЕННЯ СТРІЧКИ ПОДІЙ ТА ІНТЕРФЕЙСУ
============================================================ */

function updateFeedBadge() {
  const count = state.alerts.size;
  const badge = document.getElementById('active-count-badge');
  const feedBadge = document.getElementById('feed-count-badge');

  badge.textContent = count;
  feedBadge.textContent = `${count} подій`;

  if (count > 0) {
    badge.className = 'font-bold text-red-400 font-mono';
  } else {
    badge.className = 'font-bold text-emerald-400 font-mono';
  }
}

function updateFeedUI() {
  const feed = document.getElementById('alerts-feed');
  const placeholder = document.getElementById('no-alerts-placeholder');

  const visibleAlerts = Array.from(state.alerts.values())
    .map(i => i.data)
    .filter(a => state.activeFilter === 'all' || a.type === state.activeFilter)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (visibleAlerts.length === 0) {
    placeholder.classList.remove('hidden');
    // Очищаємо інші елементи
    feed.querySelectorAll('.feed-card').forEach(el => el.remove());
    return;
  }

  placeholder.classList.add('hidden');
  feed.querySelectorAll('.feed-card').forEach(el => el.remove());

  visibleAlerts.forEach(alert => {
    const card = document.createElement('div');
    card.className = 'feed-card pt-2.5 pb-1 cursor-pointer hover:bg-gray-800/40 p-2 rounded transition-colors';
    
    const timeStr = new Date(alert.timestamp).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const isMissile = alert.type === 'missile';
    const isAvia = alert.type === 'avia';
    
    const typeBadge = isMissile 
      ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-950/80 text-red-400 border border-red-800/50">РАКЕТА</span>'
      : isAvia
      ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-cyan-950/80 text-cyan-400 border border-cyan-800/50">АВІАЦІЯ</span>'
      : '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-950/80 text-amber-400 border border-amber-800/50">БПЛА</span>';

    card.innerHTML = `
      <div class="flex items-center justify-between">
        ${typeBadge}
        <span class="text-[11px] text-gray-400 font-mono">${timeStr}</span>
      </div>
      <p class="text-xs font-semibold text-gray-200 mt-1.5">${alert.location_name}</p>
      <div class="flex items-center justify-between text-[11px] text-gray-400 mt-1 font-mono">
        <span>Радіус: ${alert.radius || 15} км</span>
        <span>${alert.azimuth !== null ? 'Курс: ' + alert.azimuth + '°' : ''}</span>
      </div>
    `;

    // При кліку на подію в стрічці — центруються координати карти
    card.addEventListener('click', () => {
      state.map.flyTo([alert.lat, alert.lng], 10, { duration: 1.2 });
      const item = state.alerts.get(alert.id);
      if (item && item.marker) {
        item.marker.openPopup();
      }
    });

    feed.appendChild(card);
  });
}

/* ============================================================
   6. SOCKET.IO ТА REST API ПІДКЛЮЧЕННЯ
============================================================ */

function setupSocketListeners() {
  const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  const connDot = document.getElementById('conn-dot');
  const connPing = document.getElementById('conn-ping');
  const statusText = document.getElementById('system-status-text');

  socket.on('connect', () => {
    console.log('[Socket] Підключено до сервера!');
    connDot.className = 'relative inline-flex rounded-full h-3 w-3 bg-emerald-500';
    connPing.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75';
    statusText.textContent = 'З\'єднання активне';
  });

  socket.on('disconnect', () => {
    console.warn('[Socket] З\'єднання втрачено...');
    connDot.className = 'relative inline-flex rounded-full h-3 w-3 bg-red-500';
    connPing.className = 'hidden';
    statusText.textContent = 'Відновлення зв\'язку...';
  });

  // Початковий масив активних загроз при підключенні
  socket.on('initial:state', (alerts) => {
    console.log('[Socket] Отримано початковий стан загроз:', alerts.length);
    alerts.forEach(renderAlertOnMap);
  });

  // Отримання нової загрози
  socket.on('alert:new', (alert) => {
    console.log('[Socket] Нова загроза:', alert);
    renderAlertOnMap(alert);
    playAlarmSound();
  });

  // Отримання відбою
  socket.on('alert:clear', ({ id, location_name }) => {
    console.log('[Socket] Відбій загрози:', id, location_name);
    removeAlertFromMap(id);
  });

  // Автоматичне архівування застарілої загрози
  socket.on('alert:archived', ({ id }) => {
    removeAlertFromMap(id);
  });
}

// Запасний варіант REST API завантаження
async function fetchInitialAlerts() {
  try {
    const res = await fetch('/api/alerts/active');
    const data = await res.json();
    if (data.success && Array.isArray(data.data)) {
      data.data.forEach(renderAlertOnMap);
    }
  } catch (err) {
    console.error('[REST Error] Помилка початкового запиту:', err);
  }
}

/* ============================================================
   7. ОБРОБНИКИ ПОДІЙ ІНТЕРФЕЙСУ
============================================================ */

function setupUiEvents() {
  // Селектор вибору регіону України
  const selectRegion = document.getElementById('select-region');
  if (selectRegion) {
    selectRegion.addEventListener('change', (e) => {
      const regionKey = e.target.value;
      const target = REGION_COORDINATES[regionKey] || REGION_COORDINATES.all;
      state.map.flyTo(target.center, target.zoom, { duration: 1.5 });
    });
  }

  // Кнопка звукових сповіщень
  const btnAudio = document.getElementById('btn-toggle-audio');
  const iconSoundOff = document.getElementById('icon-sound-off');
  const iconSoundOn = document.getElementById('icon-sound-on');
  const audioLabel = document.getElementById('audio-label');

  btnAudio.addEventListener('click', () => {
    initAudioContext();
    state.soundEnabled = !state.soundEnabled;

    if (state.soundEnabled) {
      iconSoundOff.classList.add('hidden');
      iconSoundOn.classList.remove('hidden');
      audioLabel.textContent = 'Звук увімк.';
      btnAudio.classList.add('border-emerald-600', 'bg-emerald-950/40');
      playAlarmSound(); // Тестовий звуковий відгук
    } else {
      iconSoundOff.classList.remove('hidden');
      iconSoundOn.classList.add('hidden');
      audioLabel.textContent = 'Звук';
      btnAudio.classList.remove('border-emerald-600', 'bg-emerald-950/40');
    }
  });

  // Фільтри типів загроз
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyFilter(btn.dataset.filter);
    });
  });

  // Перемикання сайдбара на мобільних пристроях
  const btnSidebar = document.getElementById('btn-toggle-sidebar');
  const sidebar = document.getElementById('sidebar-panel');
  if (btnSidebar && sidebar) {
    btnSidebar.addEventListener('click', () => {
      sidebar.classList.toggle('translate-y-full');
    });
  }

  // Модальне вікно симулятора
  const modal = document.getElementById('simulate-modal');
  const btnOpenModal = document.getElementById('btn-open-simulate-modal');
  const btnCloseModal = document.getElementById('btn-close-simulate-modal');
  const btnSendSimulate = document.getElementById('btn-send-simulate');
  const simulateInput = document.getElementById('simulate-text');

  btnOpenModal.addEventListener('click', () => modal.classList.remove('hidden'));
  btnCloseModal.addEventListener('click', () => modal.classList.add('hidden'));

  // Швидкі зразки для симуляції
  document.querySelectorAll('.quick-sample').forEach(btn => {
    btn.addEventListener('click', () => {
      simulateInput.value = btn.textContent.trim();
    });
  });

  btnSendSimulate.addEventListener('click', async () => {
    const text = simulateInput.value.trim();
    if (!text) return;

    btnSendSimulate.disabled = true;
    btnSendSimulate.textContent = 'Обробка...';

    try {
      const res = await fetch('/api/alerts/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      console.log('[Simulate Response]', data);
      modal.classList.add('hidden');
      simulateInput.value = '';
    } catch (err) {
      alert('Помилка відправки симуляції: ' + err.message);
    } finally {
      btnSendSimulate.disabled = false;
      btnSendSimulate.textContent = 'Обробити повідомлення';
    }
  });
}

/* ============================================================
   СТАРТ КЛІЄНТА
============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupSocketListeners();
  fetchInitialAlerts();
  setupUiEvents();
});
