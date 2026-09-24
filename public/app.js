/**
 * public/app.js
 * Клієнтська логіка системи «РАДАР — Національний моніторинг повітряного простору».
 *
 * РЕАЛІЗОВАНІ ВИМОГИ:
 * 1. WebSocket (wss://neptun.in.ua/api/v1/stream) як основне realtime-джерело.
 * 2. Обробка фреймів: snapshot, upsert, remove, alerts, heartbeat.
 * 3. Резервний REST fallback з автоматичним backoff та перепідключенням (без дублікатів).
 * 4. Моніторинг та відстеження Вінницької області (та інших обраних територій).
 * 5. Сповіщення ТІЛЬКИ при реальній зміні офіційного статусу тривоги (inactive ↔ yellow ↔ red).
 * 6. Інформаційна стрічка Telegram (/api/v1/messages) з фільтрацією по Вінницькій області.
 * 7. Чітке візуальне розділення: Офіційна тривога vs Інформаційне повідомлення.
 * 8. Обробка areaOnly: true для загроз (орієнтовний район, без вигаданих курсів).
 * 9. Налаштування сповіщень (офіційні тривоги, інформаційні повідомлення, звук, нічний режим).
 * 10. Чисте UTF-8 декодування з автоматичним виправленням Windows-1251 mojibake.
 */

/* ============================================================
   0. GITHUB PAGES & DEPLOYMENT CONFIGURATION
============================================================ */
const BASE_PATH = (() => {
  if (typeof window !== 'undefined' && window.location) {
    const p = window.location.pathname || '';
    if (p.startsWith('/radar_Ukraine') || p.includes('/radar_Ukraine/')) {
      return '/radar_Ukraine/';
    }
  }
  return './';
})();

const IS_LOCAL_HOST = typeof window !== 'undefined' && window.location && (
  window.location.hostname === 'localhost' || 
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname === '0.0.0.0'
);

const NEPTUN_REST_BASE = IS_LOCAL_HOST ? '' : 'https://neptun.in.ua';

if (typeof window !== 'undefined' && window.L && window.L.Icon && window.L.Icon.Default) {
  window.L.Icon.Default.imagePath = BASE_PATH + 'vendor/images/';
}

/* ============================================================
   0.1 КЛІЄНТСЬКИЙ NLP АНАЛІЗАТОР ДЛЯ СТАТИЧНОГО ХОСТИНГУ
============================================================ */
const KNOWN_UKRAINE_TERRITORIES = [
  { name: 'Київ', patterns: [/ки[їє]в/i] },
  { name: 'Київська область', patterns: [/ки[їє]вщин/i, /ки[їє]вськ.*обл/i] },
  { name: 'Севастополь', patterns: [/севастопол/i] },
  { name: 'Автономна Республіка Крим', patterns: [/крим/i] },
  { name: 'Вінницька область', patterns: [/вінниц/i, /жмеринк/i, /могилів-под/i, /гайсин/i, /тульчин/i, /хмільник/i, /козятин/i, /ладижин/i, /калинівк/i, /барськ/i, /бершад/i] },
  { name: 'Волинська область', patterns: [/волин/i, /луцьк/i, /ковель/i, /нововолинськ/i] },
  { name: 'Дніпропетровська область', patterns: [/дніпр/i, /крив.*ріг/i, /криворіз/i, /нікопол/i, /павлоград/i, /кам'янськ/i] },
  { name: 'Донецька область', patterns: [/донец/i, /краматорськ/i, /слов'янськ/i, /покровськ/i, /костянтинівк/i] },
  { name: 'Житомирська область', patterns: [/житомир/i, /бердичів/i, /коростен/i, /новоград/i, /звягель/i] },
  { name: 'Закарпатська область', patterns: [/закарпат/i, /ужгород/i, /мукачев/i, /хуст/i] },
  { name: 'Запорізька область', patterns: [/запоріж/i, /мелітопол/i, /бердянськ/i, /полож/i] },
  { name: 'Івано-Франківська область', patterns: [/івано-франків/i, /прикарпат/i, /калуш/i, /коломи/i] },
  { name: 'Кіровоградська область', patterns: [/кіровоград/i, /кропивницьк/i, /олександрі/i, /знам'янк/i] },
  { name: 'Луганська область', patterns: [/луганськ/i, /сєвєродонец/i, /лисичанськ/i] },
  { name: 'Львівська область', patterns: [/львів/i, /дрогобич/i, /стрий/i, /червоноград/i] },
  { name: 'Миколаївська область', patterns: [/микола[їє]в/i, /вознесенськ/i, /первомайськ/i, /очаків/i] },
  { name: 'Одеська область', patterns: [/одес/i, /чорноморськ/i, /ізма[їє]л/i, /білгород-дністров/i] },
  { name: 'Полтавська область', patterns: [/полтав/i, /кременчук/i, /лубн/i, /миргород/i] },
  { name: 'Рівненська область', patterns: [/рівнен/i, /рівн[ое]/i, /вараш/i, /дубн/i, /сарн/i] },
  { name: 'Сумська область', patterns: [/сумськ/i, /сум[иа]/i, /конотоп/i, /шостк/i, /охтирк/i, /ромен/i] },
  { name: 'Тернопільська область', patterns: [/тернопіль/i, /чортків/i, /кременец/i] },
  { name: 'Харківська область', patterns: [/харків/i, /чугу[їє]в/i, /ізюм/i, /куп'янськ/i, /лозов/i] },
  { name: 'Херсонська область', patterns: [/херсон/i, /берислав/i, /каховк/i, /генічеськ/i] },
  { name: 'Хмельницька область', patterns: [/хмельницьк/i, /кам'янець-подільськ/i, /шепетівк/i, /старокостянтинів/i] },
  { name: 'Черкаська область', patterns: [/черкас/i, /умань/i, /сміл/i, /золотонош/i] },
  { name: 'Чернівецька область', patterns: [/чернівц/i, /буковин/i, /новоселиц/i] },
  { name: 'Чернігівська область', patterns: [/чернігів/i, /ніжин/i, /прилук/i] }
];

function analyzeWithLocalNlp(text, followedTerritories = []) {
  const detectedTerritories = [];
  for (const item of KNOWN_UKRAINE_TERRITORIES) {
    if (item.patterns.some(p => p.test(text))) {
      detectedTerritories.push(item.name);
    }
  }

  let relevant = true;
  if (Array.isArray(followedTerritories) && followedTerritories.length > 0) {
    const followedLower = followedTerritories.map(t => String(t).toLowerCase());
    relevant = detectedTerritories.some(d => followedLower.some(f => f.includes(d.toLowerCase()) || d.toLowerCase().includes(f))) ||
               followedLower.some(f => text.toLowerCase().includes(f));
  }

  const tLower = text.toLowerCase();
  let category = 'info';
  if (/відбій|чисто|відбій загрози|локаційно втрачено/i.test(tLower)) {
    category = 'clear';
  } else if (/летить|курс|напрямок|рухається|в напрямку|атака|удар|вибух/i.test(tLower)) {
    category = 'active_threat';
  } else if (/загроза|можлива|імовірність|тривога|увага|попередження|активність/i.test(tLower)) {
    category = 'possible_threat';
  }

  const timeMatch = text.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
  const timeMentioned = timeMatch ? timeMatch[0] : null;

  let summary = '';
  if (detectedTerritories.length > 0) {
    const terrStr = detectedTerritories.join(', ');
    if (category === 'active_threat') {
      summary = `Повідомляється про активну загрозу / рух повітряних цілей щодо: ${terrStr}.`;
    } else if (category === 'possible_threat') {
      summary = `Повідомляється про можливу небезпеку або тривогу щодо: ${terrStr}.`;
    } else if (category === 'clear') {
      summary = `Повідомляється про відбій небезпеки щодо: ${terrStr}.`;
    } else {
      summary = `Інформаційне повідомлення, що згадує: ${terrStr}.`;
    }
  } else {
    summary = `Загальне оперативне повідомлення з моніторингового каналу.`;
  }

  return {
    relevant,
    territories: detectedTerritories,
    category,
    timeMentioned,
    summary,
    confidence: 0.92,
    sourceBased: true,
    engine: 'client-local-nlp',
    analyzedAt: new Date().toISOString()
  };
}

/* ============================================================
   1. КОДУВАННЯ UTF-8 ТА ДЕКОДУВАННЯ HTTP-ВІДПОВІДЕЙ
============================================================ */
const win1251BytesToUnicode = new Map();
const unicodeToWin1251Bytes = new Map();

(function initEncodingTables() {
  try {
    for (let b = 0x80; b <= 0xFF; b++) {
      const u = new TextDecoder('windows-1251').decode(new Uint8Array([b]));
      win1251BytesToUnicode.set(b, u);
      unicodeToWin1251Bytes.set(u, b);
    }
  } catch (e) {
    console.warn('[Encoding] Windows-1251 decoder not supported natively');
  }
})();

function repairWindows1251Mojibake(str) {
  if (!str || typeof str !== 'string') return str;
  if (!/[\u0420\u0421][\u0400-\u04FF\u2014\u2013\u2018\u2019\u201C\u201D\u2022\u00A0-\u00FF]/.test(str)) {
    return str;
  }

  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (unicodeToWin1251Bytes.has(ch)) {
      bytes.push(unicodeToWin1251Bytes.get(ch));
    } else {
      const code = ch.charCodeAt(0);
      if (code < 128) {
        bytes.push(code);
      } else {
        return str;
      }
    }
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch (e) {
    return str;
  }
}

async function fetchUtf8Json(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buffer = await res.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buffer);
  text = repairWindows1251Mojibake(text);

  return JSON.parse(text);
}

/* ============================================================
   2. КОНФІГУРАЦІЯ ОФІЦІЙНИХ КОЛЬОРІВ ТА РІВНІВ НЕБЕЗПЕКИ
============================================================ */
const ALERT_COLORS = {
  RED:      '#ef4444',
  CRITICAL: '#ef4444',
  ORANGE:   '#f97316',
  HIGH:     '#f97316',
  YELLOW:   '#eab308',
  MEDIUM:   '#eab308',
  GREEN:    '#22c55e',
  LOW:      '#22c55e',
  CLEAR:    '#22c55e',
  NONE:     '#22c55e'
};

function getAlertColor(level) {
  if (!level) return ALERT_COLORS.GREEN;
  const lvl = String(level).trim().toUpperCase();
  return ALERT_COLORS[lvl] || ALERT_COLORS.RED;
}

function getThreatColor(type) {
  switch (String(type).toLowerCase()) {
    case 'drone':
    case 'uav':
    case 'fpv':       return '#f59e0b';
    case 'missile':   return '#ef4444';
    case 'ballistic': return '#c084fc';
    default:          return '#38bdf8';
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

function formatAlertTimestamp(sinceStr, finishedStr = null) {
  if (!sinceStr) return 'Час не вказано';
  const d = new Date(sinceStr);
  if (isNaN(d.getTime())) return String(sinceStr);

  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
                  d.getMonth() === now.getMonth() &&
                  d.getDate() === now.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.getFullYear() === yesterday.getFullYear() &&
                      d.getMonth() === yesterday.getMonth() &&
                      d.getDate() === yesterday.getDate();

  const monthsUk = [
    'січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
    'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'
  ];

  const timeStr = d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  let formattedStart = '';

  if (isToday) {
    formattedStart = `Сьогодні, ${timeStr}`;
  } else if (isYesterday) {
    formattedStart = `Вчора, ${timeStr}`;
  } else {
    const isCurrentYear = d.getFullYear() === now.getFullYear();
    if (isCurrentYear) {
      formattedStart = `${d.getDate()} ${monthsUk[d.getMonth()]}, ${timeStr}`;
    } else {
      formattedStart = `${d.getDate()} ${monthsUk[d.getMonth()]} ${d.getFullYear()}, ${timeStr}`;
    }
  }

  if (finishedStr) {
    const f = new Date(finishedStr);
    if (!isNaN(f.getTime())) {
      const fTimeStr = f.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
      const isSameDay = d.getFullYear() === f.getFullYear() &&
                        d.getMonth() === f.getMonth() &&
                        d.getDate() === f.getDate();
      if (isSameDay) {
        return `${formattedStart} → ${fTimeStr}`;
      } else {
        const isCurrentYearF = f.getFullYear() === now.getFullYear();
        const fFormatted = isCurrentYearF 
          ? `${f.getDate()} ${monthsUk[f.getMonth()]}, ${fTimeStr}`
          : `${f.getDate()} ${monthsUk[f.getMonth()]} ${f.getFullYear()}, ${fTimeStr}`;
        return `${formattedStart} → ${fFormatted}`;
      }
    }
  }

  return formattedStart;
}

function formatAlertDuration(sinceStr, finishedStr = null) {
  if (!sinceStr) return '';
  const start = new Date(sinceStr).getTime();
  if (isNaN(start)) return '';
  const end = finishedStr ? new Date(finishedStr).getTime() : Date.now();
  const diffMs = Math.max(0, end - start);
  const totalMin = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;

  if (days > 0) {
    return `${days} д ${hours} год`;
  } else if (hours > 0) {
    return `${hours} год ${mins} хв`;
  } else {
    return `${mins} хв`;
  }
}

/* ============================================================
   3. НОРМАЛІЗОВАНИЙ СТАН ЗАСТОСУНКУ
============================================================ */
const State = {
  version:       null,
  updatedAt:     null,
  raions:        new Map(),
  oblasts:       new Map(),
  specialCities: new Map(),
  threats:       new Map(),
  trajectories:  new Map(),
  messages:      [],
  history:       [],
  lastSyncTime:  null,
  lastSyncError: null,
  activeFilter:  'all',
  statusFilter:  'active',
  selectedRegion: localStorage.getItem('radar_selected_region') || 'all',
  selectedDistrict: localStorage.getItem('radar_selected_district') || 'all',
  showEntireRegionWithDistrict: localStorage.getItem('radar_show_oblast_wide') !== 'false'
};

const NOTIFICATIONS_STORAGE_KEY = 'radar_notifications_history_v3';

/* ============================================================
   ПОДІЄВА МОДЕЛЬ СПОВІЩЕНЬ ТА ТЕРМІНОВІ СПОВІЩЕННЯ (REALTIME DISPATCHER)
============================================================ */
const NOTIFICATION_CATEGORIES = {
  OFFICIAL_ALERT: 'OFFICIAL_ALERT',
  THREAT:         'THREAT',
  LAUNCH:         'LAUNCH',
  INFORMATION:    'INFORMATION',
  AI_ANALYSIS:    'AI_ANALYSIS'
};

const NOTIFICATION_PRIORITIES = {
  NORMAL: 'NORMAL',
  URGENT: 'URGENT'
};

const previousAlertSnapshot  = new Map(); // uniqueKey -> { level, status, since, name }
const previousThreatSnapshot = new Map(); // id -> { type, status }
const seenMessageKeys        = new Set();

let isInitialLoad = true;

const NotificationDispatcher = {
  processedEventIds: new Set(),
  maxProcessedEvents: 1000,

  init() {
    try {
      const saved = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.id) this.processedEventIds.add(item.id);
            if (item.sourceId) this.processedEventIds.add(item.sourceId);
          }
        }
      }
    } catch (e) {}
  },

  markSeen(id) {
    if (!id) return;
    this.processedEventIds.add(id);
    if (this.processedEventIds.size > this.maxProcessedEvents) {
      const first = this.processedEventIds.values().next().value;
      this.processedEventIds.delete(first);
    }
  },

  isSeen(id) {
    return this.processedEventIds.has(id);
  },

  dispatch({
    id,
    type,
    priority = NOTIFICATION_PRIORITIES.NORMAL,
    title,
    body,
    place = '',
    eventTime = null,
    source = 'NEPTUN API',
    level = 'red',
    subtype = '',
    isClear = false,
    raw = null
  }) {
    if (!id) return false;

    // 1. Інваріант: Initial snapshot / reload НЕ створюють сповіщень
    if (isInitialLoad) {
      this.markSeen(id);
      return false;
    }

    // 2. Інваріант: Дедуплікація (0 duplicate notifications)
    if (this.isSeen(id)) {
      return false;
    }
    this.markSeen(id);

    const s = StorageManager.getSettings();

    // 3. Перевірка категорій у налаштуваннях
    if (type === NOTIFICATION_CATEGORIES.OFFICIAL_ALERT && !s.officialAlertsEnabled) return false;
    if (type === NOTIFICATION_CATEGORIES.THREAT && !s.threatsAlertsEnabled) return false;
    if (type === NOTIFICATION_CATEGORIES.LAUNCH && !s.launchesAlertsEnabled) return false;
    if (type === NOTIFICATION_CATEGORIES.INFORMATION && !s.infoMessagesEnabled) return false;
    if (type === NOTIFICATION_CATEGORIES.AI_ANALYSIS && (!s.aiEnabled || !s.aiNotifications)) return false;

    // 4. Перевірка відстежуваного регіону (якщо увімкнено список обраних територій)
    const isFollowed = !place || FollowManager.matchesFollowed(place);
    if (FollowManager.followedSet.size > 0 && !isFollowed) {
      return false;
    }

    // 4.1. Глобальна перевірка відповідності вибраній території
    //      Єдина централізована точка фільтрації для ВСІХ типів сповіщень.
    //      URGENT не обходить цей фільтр — пріоритет події ≠ дозвіл ігнорувати налаштування.
    if (typeof GlobalTerritoryFilter !== 'undefined') {
      const rawObj = raw || {};
      if (!GlobalTerritoryFilter.passes({
        type,
        oblastKey:    rawObj.key      || rawObj.oblast || place,
        oblastName:   rawObj.name     || rawObj.oblast || place,
        apiRegion:    rawObj.region   || rawObj.oblast || null,
        apiDistrict:  rawObj.district || null,
        apiLocality:  rawObj.locality || null,
        areaOnly:     rawObj.areaOnly || false,
        text:         body,
        title,
        source,
        place,
        parsedTerritory: rawObj._parsedTerritory || null
      })) {
        return false;
      }
    }

    // 5. Визначення та повага до пріоритету URGENT
    let effectivePriority = priority;
    if (s.urgentAlertsEnabled === false && effectivePriority === NOTIFICATION_PRIORITIES.URGENT) {
      effectivePriority = NOTIFICATION_PRIORITIES.NORMAL;
    }
    const isUrgent = effectivePriority === NOTIFICATION_PRIORITIES.URGENT;

    // 6. Звуковий супровід (без дублювання: грає 1 раз тільки відповідний звук)
    if (s.soundEnabled && !SoundService.isQuietTime()) {
      if (isClear) {
        SoundService.playClearSound();
      } else if (isUrgent) {
        SoundService.playUrgentSiren();
      } else if (type === NOTIFICATION_CATEGORIES.OFFICIAL_ALERT) {
        SoundService.playAlertSiren();
      } else {
        SoundService.playInfoChime();
      }
    }

    // 7. Браузерні сповіщення (Push API)
    if (s.notificationsEnabled) {
      const pushTitle = isUrgent ? `[ТЕРМІНОВО] ${title}` : title;
      NotificationManager.send(pushTitle, body, id, isUrgent);
    }

    // 8. Інтерфейсний Toast
    const toastTitle = isUrgent ? `[ТЕРМІНОВО] ${title}` : title;
    showToast(toastTitle, isUrgent);

    // 9. Додавання картки у стрічку сповіщень (ОДНЕ сповіщення, без дублювання)
    TelegramFeedService.addDispatchedNotification({
      id,
      type,
      priority: effectivePriority,
      title,
      message: body,
      territory: place,
      eventTime,
      receivedAt: new Date().toISOString(),
      source,
      sourceId: id,
      level,
      subtype,
      status: isClear ? 'ВІДБІЙ' : (isUrgent ? 'ТЕРМІНОВО' : 'АКТИВНА'),
      raw
    });

    return true;
  }
};

/* ============================================================
   4. ПАРСЕР NEPTUN API
============================================================ */
const NeptunParser = {

  parseAlerts(raw) {
    const result = {
      version:       raw.version || null,
      updatedAt:     raw.updatedAt || null,
      specialCities: new Map(),
      oblasts:       new Map(),
      raions:        new Map()
    };

    const rawOblasts = Array.isArray(raw.oblasts) ? raw.oblasts : [];
    for (const item of rawOblasts) {
      if (!item) continue;
      const rawName  = item.name || item.oblast || item.key || '';
      const normName = normalizeName(rawName);
      const level    = (item.level || item.alertLevel || 'red').toLowerCase();
      const since    = item.since || item.started_at || raw.updatedAt || null;
      const key      = item.key || normName;

      if (normName === 'київ' || item.key === 'м. київ' || rawName === 'м. Київ') {
        result.specialCities.set('київ', {
          key,
          name:   'м. Київ',
          oblast: 'м. Київ',
          since,
          level,
          type:   'special_city'
        });
      } else if (normName === 'севастополь' || item.key === 'севастополь' || rawName === 'Севастополь') {
        result.specialCities.set('севастополь', {
          key,
          name:   'Севастополь',
          oblast: 'Автономна Республіка Крим',
          since,
          level,
          type:   'special_city'
        });
      } else {
        const oblastObj = {
          key,
          name:   item.name || item.oblast || rawName,
          oblast: item.oblast || item.name || rawName,
          since,
          level,
          type:   'oblast'
        };
        result.oblasts.set(normName, oblastObj);

        const strippedOblast = normName.replace(/\s+область$/, '').trim();
        if (strippedOblast && strippedOblast !== normName) {
          result.oblasts.set(strippedOblast, oblastObj);
        }
        if (item.key && typeof item.key === 'string') {
          result.oblasts.set(normalizeName(item.key), oblastObj);
        }

        if (normName.includes('крим')) {
          result.oblasts.set('автономна республіка крим', oblastObj);
          result.oblasts.set('крим', oblastObj);
        }
        if (normName.includes('луганськ')) {
          result.oblasts.set('луганська область', oblastObj);
          result.oblasts.set('луганськ', oblastObj);
        }
        if (normName.includes('донецьк')) {
          result.oblasts.set('донецька область', oblastObj);
          result.oblasts.set('донецьк', oblastObj);
        }
      }
    }

    const rawRaions = Array.isArray(raw.raions) ? raw.raions : [];
    for (const item of rawRaions) {
      if (!item) continue;
      const rawName   = item.name || item.district || item.key || '';
      const normName  = normalizeName(rawName);
      const level     = (item.level || item.alertLevel || 'red').toLowerCase();
      const since     = item.since || item.started_at || raw.updatedAt || null;
      const reasons   = Array.isArray(item.reasons) ? item.reasons : (item.reason ? [item.reason] : []);
      const key       = item.key || normName;

      const raionObj = {
        key,
        name:    item.name || rawName,
        oblast:  item.oblast || item.region || '',
        since,
        level,
        reasons,
        type:    'raion'
      };
      result.raions.set(normName, raionObj);

      const strippedRaion = normName.replace(/\s+район$/, '').trim();
      if (strippedRaion && strippedRaion !== normName) {
        result.raions.set(strippedRaion, raionObj);
      }
      if (item.key && typeof item.key === 'string') {
        result.raions.set(normalizeName(item.key), raionObj);
      }
    }

    // Зворотна сумісність для старого формату data[]
    if (rawRaions.length === 0 && rawOblasts.length === 0 && Array.isArray(raw.data)) {
      for (const item of raw.data) {
        if (!item) continue;
        const level = (item.alertLevel || item.level || 'red').toLowerCase();
        const since = item.started_at || item.since || null;

        if (item.district) {
          const normDist = normalizeName(item.district);
          result.raions.set(normDist, {
            key:     item.id || normDist,
            name:    item.district,
            oblast:  item.region || '',
            since,
            level,
            reasons: item.reasons || [],
            type:    'raion'
          });
        } else if (item.region) {
          const normReg = normalizeName(item.region);
          if (normReg === 'київ') {
            result.specialCities.set('київ', { key: 'м. київ', name: 'м. Київ', oblast: 'м. Київ', since, level, type: 'special_city' });
          } else if (normReg === 'севастополь') {
            result.specialCities.set('севастополь', { key: 'севастополь', name: 'Севастополь', oblast: 'Автономна Республіка Крим', since, level, type: 'special_city' });
          } else {
            const oblastObj = { key: item.id || normReg, name: item.region, oblast: item.region, since, level, type: 'oblast' };
            result.oblasts.set(normReg, oblastObj);
            if (normReg.includes('крим')) {
              result.oblasts.set('автономна республіка крим', oblastObj);
              result.oblasts.set('крим', oblastObj);
            }
            if (normReg.includes('луганськ')) {
              result.oblasts.set('луганська область', oblastObj);
              result.oblasts.set('луганськ', oblastObj);
            }
            if (normReg.includes('донецьк')) {
              result.oblasts.set('донецька область', oblastObj);
              result.oblasts.set('донецьк', oblastObj);
            }
          }
        }
      }
    }

    return result;
  },

  parseSingleThreat(item) {
    if (!item || !item.id) return null;

    let validCoords = null;
    if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) {
      validCoords = [item.lat, item.lon];
    } else if (Array.isArray(item.coordinates) && item.coordinates.length >= 2 &&
        Number.isFinite(item.coordinates[0]) && Number.isFinite(item.coordinates[1])) {
      validCoords = [item.coordinates[0], item.coordinates[1]];
    }

    let trailCoords = null;
    if (Array.isArray(item.trail) && item.trail.length > 0) {
      trailCoords = item.trail
        .map(pt => {
          if (Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) return [pt[0], pt[1]];
          if (pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lon)) return [pt.lat, pt.lon];
          return null;
        })
        .filter(Boolean);
    }

    let type = (item.type || 'drone').toLowerCase();
    if (type === 'uav' || type === 'fpv') type = 'drone';

    return {
      id:          item.id,
      type:        type,
      rawType:     item.type,
      title:       item.title || 'БпЛА',
      status:      (item.status || 'active').toLowerCase(),
      region:      item.region || '',
      district:    item.district || null,
      locality:    item.locality || null,
      time:        item.time || (item.updatedAt ? new Date(item.updatedAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : null),
      heading:     item.heading != null ? item.heading : null,
      speed:       item.speed != null ? item.speed : null,
      coordinates: validCoords,
      trail:       trailCoords,
      areaOnly:    item.areaOnly === true,
      explanation: item.explanationShort || null,
      source:      item.source || 'NEPTUN API'
    };
  },

  parseThreats(raw) {
    const list = Array.isArray(raw.threats) ? raw.threats : (Array.isArray(raw.data) ? raw.data : (Array.isArray(raw) ? raw : []));
    const result = new Map();

    for (const item of list) {
      const parsed = this.parseSingleThreat(item);
      if (parsed) result.set(parsed.id, parsed);
    }

    return result;
  }
};

/* ============================================================
   5. CHANGE DETECTOR (СПОВІЩЕННЯ ТІЛЬКИ ПРИ РЕАЛЬНІЙ ЗМІНІ СТАНУ)
============================================================ */
const ChangeDetector = {

  applyAlerts(parsed) {
    State.version   = parsed.version;
    State.updatedAt = parsed.updatedAt;

    const freshKeys = new Set();
    const added     = [];
    const changed   = [];
    const removed   = [];

    const currentUnits = new Map();
    for (const [k, v] of parsed.specialCities.entries()) currentUnits.set(`special:${k}`, v);
    for (const [k, v] of parsed.oblasts.entries())       currentUnits.set(`oblast:${k}`, v);
    for (const [k, v] of parsed.raions.entries())        currentUnits.set(`raion:${k}`, v);

    for (const [uniqueKey, unit] of currentUnits.entries()) {
      freshKeys.add(uniqueKey);
      const prev = previousAlertSnapshot.get(uniqueKey);

      if (!prev) {
        added.push(unit);
      } else if (prev.level !== unit.level) {
        changed.push({ prev, unit });
      }

      previousAlertSnapshot.set(uniqueKey, {
        level:  unit.level,
        status: 'active',
        since:  unit.since,
        name:   unit.name,
        oblast: unit.oblast
      });
    }

    for (const [prevKey, prevUnit] of previousAlertSnapshot.entries()) {
      if (!freshKeys.has(prevKey)) {
        removed.push(prevUnit);
        previousAlertSnapshot.delete(prevKey);
      }
    }

    State.specialCities = parsed.specialCities;
    State.oblasts       = parsed.oblasts;
    State.raions        = parsed.raions;

    this.handleAlertEvents(added, changed, removed);
    MapService.updateAllDistrictStyles();
    FollowManager.renderFollowedList();
    UIController.updateCounters();
  },

  handleAlertEvents(added, changed, removed) {
    const timeStr = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

    // 1. Відбої тривог
    for (const item of removed) {
      const place = item.name;
      const eventId = `alert_clear_${item.key || place}_${item.since || Date.now()}`;
      const exactTime = item.since ? new Date(item.since).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : timeStr;

      if (!isInitialLoad) {
        NotificationDispatcher.dispatch({
          id: eventId,
          type: NOTIFICATION_CATEGORIES.OFFICIAL_ALERT,
          priority: NOTIFICATION_PRIORITIES.NORMAL,
          title: `Відбій тривоги: ${place}`,
          body: 'Повітряний простір спокійний',
          place,
          eventTime: item.since || null,
          source: 'NEPTUN API',
          level: 'green',
          isClear: true,
          raw: { key: item.key || place, name: item.name || place, oblast: item.oblast || place }
        });

        FeedService.addEvent({
          time:   exactTime,
          type:   'clear',
          title:  place,
          status: 'ВІДБІЙ',
          desc:   `Відбій повітряної тривоги в ${place}`,
          isOfficial: true
        });
      }
    }

    // 2. Нові офіційні тривоги
    for (const item of added) {
      const place = item.name;
      const lvl = (item.level || 'red').toLowerCase();
      const lvlUpper = lvl.toUpperCase();
      const isYellow = lvl === 'yellow';
      const isUrgent = lvl === 'red';
      const levelTitle = isYellow ? 'зафіксовано офіційний жовтий рівень' : 'оголошено повітряну тривогу';
      const eventId = `alert_active_${item.key || place}_${item.since || 'init'}`;
      const exactStartTime = item.since ? new Date(item.since).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : timeStr;

      if (isInitialLoad) {
        // Початкове завантаження: тихо додаємо в історію, без звуку та спаму
        NotificationDispatcher.markSeen(eventId);
        FeedService.addEvent({
          time:   exactStartTime,
          type:   'alert',
          title:  place,
          level:  item.level,
          status: lvlUpper,
          desc:   item.reasons && item.reasons.length ? item.reasons.join(', ') : `Офіційний стан тривоги [${lvlUpper}]`,
          isOfficial: true
        });
      } else {
        NotificationDispatcher.dispatch({
          id: eventId,
          type: NOTIFICATION_CATEGORIES.OFFICIAL_ALERT,
          priority: isUrgent ? NOTIFICATION_PRIORITIES.URGENT : NOTIFICATION_PRIORITIES.NORMAL,
          title: `Тривога [${lvlUpper}]: ${place}`,
          body: item.reasons?.join(', ') || `Офіційний стан тривоги [${lvlUpper}]`,
          place,
          eventTime: item.since || null,
          source: 'NEPTUN API',
          level: item.level || 'red',
          raw: { key: item.key || place, name: item.name || place, oblast: item.oblast || place }
        });

        FeedService.addEvent({
          time:   exactStartTime,
          type:   'alert',
          title:  place,
          level:  item.level,
          status: lvlUpper,
          desc:   item.reasons && item.reasons.length ? item.reasons.join(', ') : `Оголошено стан тривоги [${lvlUpper}]`,
          isOfficial: true
        });
      }
    }

    // 3. Зміна офіційного рівня небезпеки (yellow ↔ red)
    for (const { prev, unit } of changed) {
      const place = unit.name;
      const newLvl = (unit.level || '').toUpperCase();
      const eventId = `alert_change_${unit.key || place}_${prev.level}_to_${unit.level}_${unit.since || Date.now()}`;
      const isEscalation = (unit.level || '').toLowerCase() === 'red';
      const exactTime = unit.since ? new Date(unit.since).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : timeStr;

      if (!isInitialLoad) {
        NotificationDispatcher.dispatch({
          id: eventId,
          type: NOTIFICATION_CATEGORIES.OFFICIAL_ALERT,
          priority: isEscalation ? NOTIFICATION_PRIORITIES.URGENT : NOTIFICATION_PRIORITIES.NORMAL,
          title: `Зміна рівня тривоги: ${place}`,
          body: `Офіційний рівень змінено: ${prev.level.toUpperCase()} → ${newLvl}`,
          place,
          eventTime: unit.since || null,
          source: 'NEPTUN API',
          level: unit.level,
          raw: { key: unit.key || place, name: unit.name || place, oblast: unit.oblast || place }
        });

        FeedService.addEvent({
          time:   exactTime,
          type:   'alert',
          title:  place,
          level:  unit.level,
          status: newLvl,
          desc:   `Офіційний рівень змінено: ${prev.level.toUpperCase()} → ${newLvl}`,
          isOfficial: true
        });
      }
    }
  },

  applyThreats(parsedThreats) {
    const freshIds = new Set();
    const added    = [];
    const removed  = [];

    for (const [id, threat] of parsedThreats.entries()) {
      freshIds.add(id);
      const prev = previousThreatSnapshot.get(id);

      if (!prev) {
        added.push(threat);
      }
      MapService.updateThreat(threat);
      previousThreatSnapshot.set(id, { type: threat.type, status: threat.status });
    }

    for (const [prevId, prev] of previousThreatSnapshot.entries()) {
      if (!freshIds.has(prevId)) {
        removed.push({ id: prevId, ...prev });
        previousThreatSnapshot.delete(prevId);
        MapService.removeThreat(prevId);
      }
    }

    State.threats = parsedThreats;

    if (isInitialLoad) {
      for (const t of added) {
        NotificationDispatcher.markSeen(`threat_detect_${t.id}`);
        TelegramFeedService.addDispatchedNotification({
          id: `threat_detect_${t.id}`,
          type: NOTIFICATION_CATEGORIES.THREAT,
          priority: NOTIFICATION_PRIORITIES.NORMAL,
          title: `Загроза: ${(t.title || t.type || 'Ціль').toUpperCase()}`,
          message: t.explanation || `Виявлено повітряну ціль`,
          territory: t.locality ? `${t.locality}, ${t.region}` : (t.district || t.region || 'Україна'),
          eventTime: t.time || t.updatedAt || t.timestamp || null,
          source: 'NEPTUN API',
          sourceId: t.id,
          subtype: t.type || 'drone',
          status: 'АКТИВНА'
        });
      }
      return;
    }

    // Для нових цілей (підтверджені нові ID)
    const timeStr = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    for (const t of added) {
      const typeLabel = (t.title || t.type || 'Ціль').toUpperCase();
      const place     = t.locality ? `${t.locality}, ${t.region}` : (t.district || t.region || 'Україна');
      const isBallistic = (t.type || '').toLowerCase() === 'ballistic';
      const isMissile   = (t.type || '').toLowerCase() === 'missile';
      const isLaunch    = isBallistic || isMissile;
      const isUrgent    = isBallistic || isMissile || FollowManager.matchesFollowed(t.region) || (t.district && FollowManager.matchesFollowed(t.district));
      const eventId     = `threat_detect_${t.id}`;
      const category    = isLaunch ? NOTIFICATION_CATEGORIES.LAUNCH : NOTIFICATION_CATEGORIES.THREAT;

      // Будуємо parsedTerritory заздалегідь із реальних полів API (region/district/locality)
      // щоб GlobalTerritoryFilter використовував точні дані, а не NLP-здогад.
      const threatPlace = [t.locality, t.district, t.region].filter(Boolean).join(' ');
      const threatParsed = (typeof TerritoriesManager !== 'undefined' && threatPlace)
        ? TerritoriesManager.resolveMessageTerritory(threatPlace, 'NEPTUN API')
        : null;

      NotificationDispatcher.dispatch({
        id: eventId,
        type: category,
        priority: isUrgent ? NOTIFICATION_PRIORITIES.URGENT : NOTIFICATION_PRIORITIES.NORMAL,
        title: isLaunch ? `ЗАПУСК / ЗАГРОЗА (${typeLabel})` : `ЗАГРОЗА (${typeLabel})`,
        body: t.explanation || `Виявлено ціль (${typeLabel}) у районі ${place}`,
        place,
        eventTime: t.time || t.updatedAt || t.timestamp || null,
        source: 'NEPTUN API',
        subtype: t.type || 'drone',
        raw: {
          ...t,
          region:          t.region   || null,
          district:        t.district || null,
          locality:        t.locality || null,
          areaOnly:        t.areaOnly || false,
          _parsedTerritory: threatParsed
        }
      });

      FeedService.addEvent({
        time:   t.time || timeStr,
        type:   t.type || 'drone',
        title:  place,
        status: 'АКТИВНА',
        desc:   t.explanation || `Виявлено ціль (${typeLabel})`,
        isOfficial: false
      });
    }

    // Оновлюємо статус ліквідованих цілей
    for (const t of removed) {
      TelegramFeedService.markThreatLiquidated(t.id);
      FeedService.addEvent({
        time:   timeStr,
        type:   'clear',
        title:  'Ціль зникла',
        status: 'ЛІКВІДОВАНО',
        desc:   `Ціль (${(t.type || '').toUpperCase()}) більше не спостерігається`,
        isOfficial: false
      });
    }

    // Оцінка персональної безпеки при зміні цілей
    PersonalDangerService?.evaluate();
  }
};

/* ============================================================
   6. REALTIME CLIENT (WEBSOCKET + REST FALLBACK)
============================================================ */
const RealtimeClient = {
  wsUrl: 'wss://neptun.in.ua/api/v1/stream',
  ws: null,
  reconnectAttempts: 0,
  maxReconnectDelay: 10000,
  reconnectTimer: null,
  isWsConnected: false,
  fallbackPollingTimer: null,
  lastHeartbeatTime: 0,
  watchdogTimer: null,

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.updateStatusUI('connecting');

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (e) {
      console.warn('[RealtimeClient] Помилка створення WebSocket, перехід на REST fallback:', e.message);
      this.startRestFallback();
      return;
    }

    this.ws.onopen = () => {
      console.info('[NEPTUN WS] Підключено до wss://neptun.in.ua/api/v1/stream');
      this.isWsConnected = true;
      this.reconnectAttempts = 0;
      this.lastHeartbeatTime = Date.now();
      this.stopRestFallback();
      this.startWatchdog();
      this.updateStatusUI('realtime');
      document.getElementById('connection-warning-banner')?.classList.add('hidden');
    };

    this.ws.onmessage = (event) => {
      this.lastHeartbeatTime = Date.now();
      try {
        const frame = JSON.parse(event.data);
        this.handleFrame(frame);
      } catch (err) {
        console.warn('[NEPTUN WS] Помилка парсингу фрейму:', err);
      }
    };

    this.ws.onclose = (event) => {
      console.warn(`[NEPTUN WS] Зв'язок розірвано (код: ${event.code}). Запуск REST fallback (кожні 5 сек)...`);
      this.isWsConnected = false;
      this.stopWatchdog();
      this.updateStatusUI('fallback');
      this.startRestFallback();
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.warn('[NEPTUN WS] Помилка з\'єднання WebSocket');
      this.ws?.close();
    };
  },

  startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      // Якщо понад 25 секунд не надходило повідомлень від сервера
      if (this.isWsConnected && (Date.now() - this.lastHeartbeatTime > 25000)) {
        console.warn('[NEPTUN WS] Таймаут heartbeat (> 25 сек). Перепідключення...');
        this.ws?.close();
      }
    }, 5000);
  },

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  },

  handleFrame(frame) {
    if (!frame || !frame.type) return;

    switch (frame.type) {
      case 'heartbeat':
        State.lastSyncTime = new Date().toLocaleTimeString('uk-UA');
        this.updateStatusUI('realtime');
        break;

      case 'snapshot':
        if (frame.data) {
          const threatsMap = NeptunParser.parseThreats(frame.data);
          ChangeDetector.applyThreats(threatsMap);
          if (frame.data.alerts) {
            const parsedAlerts = NeptunParser.parseAlerts(frame.data.alerts);
            ChangeDetector.applyAlerts(parsedAlerts);
            AlertsService.handleRealtimeAlerts(frame.data.alerts);
          }
          if (isInitialLoad) {
            isInitialLoad = false;
            UIController.hideLoading();
          }
        }
        break;

      case 'upsert':
        if (frame.data) {
          const threat = NeptunParser.parseSingleThreat(frame.data);
          if (threat && threat.id) {
            State.threats.set(threat.id, threat);
            MapService.updateThreat(threat);
            UIController.updateCounters();
            PersonalDangerService?.evaluate();
          }
        }
        break;

      case 'remove':
        const removeId = frame.data?.id || (typeof frame.data === 'string' ? frame.data : null);
        if (removeId) {
          State.threats.delete(removeId);
          MapService.removeThreat(removeId);
          UIController.updateCounters();
          PersonalDangerService?.evaluate();
        }
        break;

      case 'alerts':
        if (frame.data) {
          const parsedAlerts = NeptunParser.parseAlerts(frame.data);
          ChangeDetector.applyAlerts(parsedAlerts);
          AlertsService.handleRealtimeAlerts(frame.data);
          if (isInitialLoad) {
            isInitialLoad = false;
            UIController.hideLoading();
          }
        }
        break;

      default:
        console.debug('[NEPTUN WS] Інший тип фрейму:', frame.type);
    }
  },

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    this.updateStatusUI('reconnecting');
    const delay = Math.min(1500 * Math.pow(1.3, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  },

  startRestFallback() {
    if (this.fallbackPollingTimer) return;
    console.info('[REST FALLBACK] Активовано резервне 5-секундне опитування');
    PollingService.poll();
    this.fallbackPollingTimer = setInterval(() => {
      if (this.isWsConnected) {
        this.stopRestFallback();
        return;
      }
      PollingService.poll();
    }, 5000);
  },

  stopRestFallback() {
    if (this.fallbackPollingTimer) {
      clearInterval(this.fallbackPollingTimer);
      this.fallbackPollingTimer = null;
      console.info('[REST FALLBACK] Зупинено — WebSocket активний');
    }
  },

  updateStatusUI(mode) {
    const dot   = document.getElementById('conn-dot');
    const label = document.getElementById('conn-label');
    const sub   = document.getElementById('conn-sublabel');

    if (mode === 'realtime') {
      if (dot)   dot.className   = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
      if (label) { label.className = 'text-emerald-400 font-bold leading-tight'; label.textContent = '● Realtime — WebSocket'; }
      if (sub)   sub.textContent = `Синхронізовано: ${State.lastSyncTime || '--:--:--'}`;
    } else if (mode === 'fallback') {
      if (dot)   dot.className   = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
      if (label) { label.className = 'text-amber-400 font-bold leading-tight'; label.textContent = '● Fallback — REST'; }
      if (sub)   sub.textContent = 'Опитування кожні 5 сек';
    } else if (mode === 'reconnecting' || mode === 'connecting') {
      if (dot)   dot.className   = 'w-2 h-2 rounded-full bg-rose-500 animate-ping';
      if (label) { label.className = 'text-rose-400 font-semibold leading-tight'; label.textContent = '○ Перепідключення...'; }
      if (sub)   sub.textContent = `Спроба #${this.reconnectAttempts || 1}`;
    }
  }
};

/* ============================================================
   7. POLLING SERVICE (REST FALLBACK)
============================================================ */
const PollingService = {
  _inflight: false,

  async poll() {
    if (this._inflight) return;
    this._inflight = true;

    try {
      const alertsUrl = NEPTUN_REST_BASE ? `${NEPTUN_REST_BASE}/api/v1/alerts` : '/api/v1/alerts';
      const threatsUrl = NEPTUN_REST_BASE ? `${NEPTUN_REST_BASE}/api/v1/threats` : '/api/v1/threats';

      const [rawAlerts, rawThreats] = await Promise.all([
        fetchUtf8Json(alertsUrl).catch(async (err) => {
          if (!NEPTUN_REST_BASE) return fetchUtf8Json('https://neptun.in.ua/api/v1/alerts');
          throw err;
        }),
        fetchUtf8Json(threatsUrl).catch(async (err) => {
          if (!NEPTUN_REST_BASE) return fetchUtf8Json('https://neptun.in.ua/api/v1/threats');
          throw err;
        })
      ]);

      const parsedAlerts  = NeptunParser.parseAlerts(rawAlerts);
      const parsedThreats = NeptunParser.parseThreats(rawThreats);

      ChangeDetector.applyAlerts(parsedAlerts);
      ChangeDetector.applyThreats(parsedThreats);
      AlertsService.handleRealtimeAlerts(rawAlerts);

      if (isInitialLoad) {
        isInitialLoad = false;
        UIController.hideLoading();
      }

      State.lastSyncTime  = new Date().toLocaleTimeString('uk-UA');
      State.lastSyncError = null;
      AlertsInUaService.poll().catch(() => {});
    } catch (err) {
      State.lastSyncError = err.message;
      console.error('[REST FALLBACK] Помилка запиту:', err.message);
    } finally {
      this._inflight = false;
      UIController.updateCounters();
      AlertsService.updateCounters();
      if (NavigationController.currentTab === 'alerts') {
        AlertsService.render();
      }
      if (MapService.currentSelectedLayer) {
        MapService.refreshSelectedDistrictPopup();
      }
    }
  }
};

/* ============================================================
   7.1. ALERTS.IN.UA PROXY CLIENT (ОФІЦІЙНЕ ДЖЕРЕЛО ТРИВОГ)
============================================================ */
const AlertsInUaService = {
  isConfigured: false,
  lastSync: null,

  async poll() {
    try {
      const res = await fetchUtf8Json('/api/v1/alerts-in-ua').catch(() => null);
      if (!res) return;
      if (res.status === 'no_token') {
        this.isConfigured = false;
        return;
      }
      if (res.status === 'ok' && res.data) {
        this.isConfigured = true;
        this.lastSync = new Date().toISOString();
        this.processData(res.data);
      }
    } catch (e) {
      // Non-blocking fallback
    }
  },

  processData(data) {
    if (!data || !Array.isArray(data.alerts)) return;
    const active = data.alerts.filter(a => !a.finished_at);
    if (active.length > 0 && AlertsService.activeAlerts.size === 0) {
      const mockRaw = {
        data: active.map(a => ({
          name: a.location_title,
          oblast: a.location_oblast || a.location_title,
          since: a.started_at,
          level: 'red',
          reasons: [a.alert_type || 'Повітряна тривога']
        }))
      };
      AlertsService.handleRealtimeAlerts(mockRaw);
    }
  }
};

/* ============================================================
   8. MESSAGES SERVICE & NOTIFICATIONS HUB (ВКЛАДКА СПОВІЩЕННЯ + LLM)
============================================================ */

function formatEventTime(val, includeSeconds = false) {
  if (!val) return '--:--';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return d.toLocaleTimeString('uk-UA', {
      hour: '2-digit',
      minute: '2-digit',
      ...(includeSeconds ? { second: '2-digit' } : {})
    });
  } catch (e) {
    return String(val);
  }
}

const TelegramFeedService = {
  filterMode: 'all', // 'all' | 'alerts' | 'threats' | 'messages' | 'followed'
  searchQuery: '',
  notifications: [],
  allMessages: [],
  analyzedCache: new Map(),
  llmEngine: 'local-nlp',
  hasApiKey: false,
  unseenCount: 0,
  userScrolledDown: false,

  async init() {
    this.loadStoredNotifications();
    this.bindEvents();
    await this.fetchLlmStatus();
    this.updateCounters();
    this.render();
  },

  loadStoredNotifications() {
    try {
      const saved = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          this.notifications = parsed;
        }
      }
    } catch (e) {
      console.warn('[NotificationHub] Помилка завантаження збережених сповіщень:', e);
      this.notifications = [];
    }
  },

  saveNotifications() {
    try {
      // Зберігаємо останні 200 подій
      localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(this.notifications.slice(0, 200)));
    } catch (e) {}
  },

  addDispatchedNotification(notifData) {
    if (!notifData || !notifData.id) return;
    const existingIdx = this.notifications.findIndex(n => n.id === notifData.id || (n.sourceId && n.sourceId === notifData.id));

    let parsed = notifData.parsedTerritory;
    if (!parsed && window.TerritoriesManager && typeof TerritoriesManager.resolveMessageTerritory === 'function') {
      const combined = `${notifData.title || ''} ${notifData.message || ''} ${notifData.territory || ''}`;
      parsed = TerritoriesManager.resolveMessageTerritory(combined, notifData.source || '');
    }

    const card = {
      id:                  notifData.id,
      type:                notifData.type,
      priority:            notifData.priority || 'NORMAL',
      territory:           notifData.territory || (parsed?.primaryPlace || ''),
      territories:         notifData.territories || (parsed?.territories || { country: 'Україна', oblasts: [], districts: [], localities: [] }),
      isNational:          notifData.isNational !== undefined ? notifData.isNational : (parsed?.isNational || false),
      territoryConfidence: notifData.territoryConfidence || (parsed?.confidence || 0),
      territorySource:     notifData.territorySource || (parsed?.source || 'message_text'),
      parsedTerritory:     parsed || null,
      title:               notifData.title || '',
      message:             notifData.message || '',
      eventTime:           notifData.eventTime || null,
      receivedAt:          notifData.receivedAt || new Date().toISOString(),
      source:              notifData.source || 'NEPTUN API',
      sourceId:            notifData.sourceId || notifData.id,
      level:               notifData.level || 'red',
      subtype:             notifData.subtype || '',
      status:              notifData.status || 'АКТИВНА',
      raw:                 notifData.raw || null
    };

    if (existingIdx >= 0) {
      this.notifications[existingIdx] = { ...this.notifications[existingIdx], ...card };
    } else {
      this.notifications.unshift(card);
      if (this.notifications.length > 250) this.notifications.pop();
      if (this.userScrolledDown && NavigationController.currentTab === 'telegram') {
        this.unseenCount++;
        const newMsgBtn = document.getElementById('btn-tg-new-messages');
        const countEl = document.getElementById('btn-tg-new-messages-count');
        if (countEl) countEl.textContent = this.unseenCount;
        newMsgBtn?.classList.remove('hidden');
      }
    }

    this.saveNotifications();
    this.updateCounters();
    if (NavigationController.currentTab === 'telegram') {
      if (!this.userScrolledDown) {
        this.render();
      }
    }
  },

  markThreatLiquidated(threatId) {
    if (!threatId) return;
    const notif = this.notifications.find(n => n.id === `threat_detect_${threatId}` || n.sourceId === threatId);
    if (notif) {
      notif.status = 'ЛІКВІДОВАНО';
      notif.receivedAt = new Date().toISOString();
      this.saveNotifications();
      this.updateCounters();
      if (NavigationController.currentTab === 'telegram') {
        this.render();
      }
    }
  },

  addAlertNotification(item, isRemoved = false) {
    if (!item) return;
    const name = item.name || item.oblast || 'Україна';
    const lvl = (item.level || 'red').toLowerCase();
    const lvlUpper = lvl.toUpperCase();
    const id = isRemoved
      ? `alert_clear_${item.key || name}_${item.since || Date.now()}`
      : `alert_active_${item.key || name}_${item.since || 'init'}`;

    this.addDispatchedNotification({
      id,
      type:       'OFFICIAL_ALERT',
      priority:   lvl === 'red' ? 'URGENT' : 'NORMAL',
      territory:  name,
      title:      name,
      message:    isRemoved
        ? `Відбій повітряної тривоги в ${name}`
        : (item.reasons && item.reasons.length ? item.reasons.join(', ') : `Офіційний рівень [${lvlUpper}]`),
      eventTime:  isRemoved ? (item.since || null) : (item.since || item.started_at || null),
      source:     'neptun_alerts',
      sourceId:   item.key || name,
      level:      item.level || 'red',
      status:     isRemoved ? 'ВІДБІЙ' : lvlUpper
    });
  },

  addThreatNotification(threat, isRemoved = false) {
    if (!threat) return;
    const place = threat.locality ? `${threat.locality}, ${threat.region}` : (threat.district || threat.region || 'Україна');
    const typeLabel = (threat.title || threat.type || 'Ціль').toUpperCase();
    const isBallistic = (threat.type || '').toLowerCase() === 'ballistic';
    const isMissile   = (threat.type || '').toLowerCase() === 'missile';
    const isLaunch    = isBallistic || isMissile;
    const id = isRemoved ? `threat_clear_${threat.id}_${Date.now()}` : `threat_detect_${threat.id}`;

    this.addDispatchedNotification({
      id,
      type:       isLaunch ? 'LAUNCH' : 'THREAT',
      priority:   isBallistic || isMissile ? 'URGENT' : 'NORMAL',
      territory:  place,
      title:      `Загроза: ${typeLabel}`,
      message:    isRemoved
        ? `Ціль (${typeLabel}) більше не спостерігається`
        : (threat.explanation || `Виявлено повітряну ціль (${typeLabel})`),
      eventTime:  threat.time || threat.updatedAt || threat.timestamp || null,
      source:     'neptun_threats',
      sourceId:   threat.id,
      subtype:    threat.type || 'drone',
      status:     isRemoved ? 'ЛІКВІДОВАНО' : 'АКТИВНА'
    });
  },

  bindEvents() {
    const btnAll      = document.getElementById('tg-btn-filter-all');
    const btnThreats  = document.getElementById('tg-btn-filter-threats');
    const btnMessages = document.getElementById('tg-btn-filter-messages');
    const btnFollowed = document.getElementById('tg-btn-filter-followed');
    const btnAi       = document.getElementById('tg-btn-filter-ai');
    const searchInput = document.getElementById('tg-input-search');
    const clearBtn    = document.getElementById('tg-btn-clear-search');

    const setFilter = (mode, activeBtn) => {
      this.filterMode = mode;
      document.querySelectorAll('.tg-filter-btn').forEach(b => {
        b.classList.remove('active', 'bg-sky-600', 'text-white');
        b.classList.add('text-gray-300');
      });
      activeBtn?.classList.add('active', 'bg-sky-600', 'text-white');
      activeBtn?.classList.remove('text-gray-300');
      this.render();
    };

    btnAll?.addEventListener('click',      () => setFilter('all', btnAll));
    btnThreats?.addEventListener('click',  () => setFilter('threats', btnThreats));
    btnMessages?.addEventListener('click', () => setFilter('messages', btnMessages));
    btnFollowed?.addEventListener('click', () => setFilter('followed', btnFollowed));
    btnAi?.addEventListener('click',       () => setFilter('ai', btnAi));

    searchInput?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.trim().toLowerCase();
      clearBtn?.classList.toggle('hidden', !this.searchQuery);
      this.render();
    });

    clearBtn?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      this.searchQuery = '';
      clearBtn.classList.add('hidden');
      this.render();
    });

    const tgRegionSelect   = document.getElementById('tg-select-region');
    const tgDistrictSelect = document.getElementById('tg-select-district');
    const tgIncludeOblast  = document.getElementById('tg-check-include-oblast');

    tgRegionSelect?.addEventListener('change', (e) => {
      State.selectedRegion = e.target.value;
      State.selectedDistrict = 'all';
      localStorage.setItem('radar_selected_region', State.selectedRegion);
      localStorage.setItem('radar_selected_district', 'all');

      const selMain = document.getElementById('select-region');
      if (selMain) selMain.value = State.selectedRegion;
      const selSettings = document.getElementById('setting-selected-region');
      if (selSettings) selSettings.value = State.selectedRegion;

      GlobalTerritoryFilter.onTerritoryChanged();
      showToast(`Фільтр сповіщень: ${State.selectedRegion === 'all' ? 'Вся Україна' : State.selectedRegion}`);
    });

    tgDistrictSelect?.addEventListener('change', (e) => {
      State.selectedDistrict = e.target.value;
      localStorage.setItem('radar_selected_district', State.selectedDistrict);
      const selDistSettings = document.getElementById('setting-selected-district');
      if (selDistSettings) selDistSettings.value = State.selectedDistrict;

      GlobalTerritoryFilter.onTerritoryChanged();
      showToast(`Фільтр району: ${State.selectedDistrict === 'all' ? 'Усі райони' : State.selectedDistrict}`);
    });

    tgIncludeOblast?.addEventListener('change', (e) => {
      State.showEntireRegionWithDistrict = e.target.checked;
      localStorage.setItem('radar_show_oblast_wide', State.showEntireRegionWithDistrict);
      const checkSettings = document.getElementById('setting-show-oblast-wide');
      if (checkSettings) checkSettings.checked = State.showEntireRegionWithDistrict;

      GlobalTerritoryFilter.onTerritoryChanged();
    });

    document.getElementById('tg-btn-reset-region')?.addEventListener('click', () => {
      State.selectedRegion = 'all';
      State.selectedDistrict = 'all';
      localStorage.setItem('radar_selected_region', 'all');
      localStorage.setItem('radar_selected_district', 'all');

      const selMain = document.getElementById('select-region');
      if (selMain) selMain.value = 'all';
      if (tgRegionSelect) tgRegionSelect.value = 'all';
      const selSettings = document.getElementById('setting-selected-region');
      if (selSettings) selSettings.value = 'all';

      GlobalTerritoryFilter.onTerritoryChanged();
      showToast('Фільтр території скинуто: Вся Україна');
    });

    const messagesContainer = document.getElementById('tg-messages-list');
    const newMsgBtn = document.getElementById('btn-tg-new-messages');
    const newMsgCountEl = document.getElementById('btn-tg-new-messages-count');

    if (messagesContainer) {
      messagesContainer.addEventListener('scroll', () => {
        this.userScrolledDown = messagesContainer.scrollTop > 60;
        if (!this.userScrolledDown && this.unseenCount > 0) {
          this.unseenCount = 0;
          newMsgBtn?.classList.add('hidden');
        }
      }, { passive: true });
    }

    if (newMsgBtn) {
      newMsgBtn.addEventListener('click', () => {
        messagesContainer?.scrollTo({ top: 0, behavior: 'smooth' });
        this.unseenCount = 0;
        newMsgBtn.classList.add('hidden');
        this.render();
      });
    }
  },

  async fetchLlmStatus() {
    try {
      const res = await fetchUtf8Json('/api/v1/llm-status').catch(() => null);
      if (res && res.status === 'ok') {
        this.llmEngine = res.engine;
        this.hasApiKey = res.hasApiKey;
        const badge = document.getElementById('tg-llm-badge-text');
        if (badge) {
          badge.textContent = res.hasApiKey ? 'LLM: Gemini 1.5 Flash' : 'LLM: Локальний NLP';
        }
      } else {
        const badge = document.getElementById('tg-llm-badge-text');
        if (badge) badge.textContent = 'LLM: Клієнтський NLP';
      }
    } catch (e) {
      const badge = document.getElementById('tg-llm-badge-text');
      if (badge) badge.textContent = 'LLM: Клієнтський NLP';
    }
  },

  async handleIncomingMessages(messagesList, newMessages = []) {
    if (!Array.isArray(messagesList)) return;
    this.allMessages = messagesList;

    const followedList = Array.from(FollowManager.followedSet);

    for (const msg of messagesList) {
      const key = msg.id || `${msg.channel || ''}::${msg.date || ''}::${(msg.text || '').slice(0, 40)}`;
      const existingNotif = this.notifications.find(n => n.id === `msg_${key}` || n.sourceId === msg.id);

      if (!existingNotif) {
        let parsed = null;
        if (window.TerritoriesManager && typeof TerritoriesManager.resolveMessageTerritory === 'function') {
          parsed = TerritoriesManager.resolveMessageTerritory(msg.text || '', msg.channel || '');
        }

        const notif = {
          id:                  `msg_${key}`,
          type:                'message',
          territory:           parsed?.primaryPlace || '',
          territories:         parsed?.territories || { country: 'Україна', oblasts: [], districts: [], localities: [] },
          isNational:          parsed?.isNational || false,
          territoryConfidence: parsed?.confidence || 0,
          territorySource:     parsed?.source || 'message_text',
          parsedTerritory:     parsed || null,
          title:               msg.channel || 'Telegram',
          message:             msg.text || '',
          eventTime:           msg.date || null, // Точний час з API
          receivedAt:          new Date().toISOString(),
          source:              msg.channel || 'Telegram',
          sourceId:            msg.id || key,
          rawMsg:              msg
        };
        this.notifications.unshift(notif);
      }

      const s = StorageManager.getSettings();
      if (s.llmAnalysisEnabled !== false && !this.analyzedCache.has(key)) {
        this.analyzeMessageAsync(msg, followedList);
      }
    }

    if (this.notifications.length > 250) {
      this.notifications = this.notifications.slice(0, 250);
    }

    this.saveNotifications();
    this.updateCounters();
    if (NavigationController.currentTab === 'telegram') {
      if (!this.userScrolledDown) {
        this.render();
      } else {
        const newCount = Array.isArray(newMessages) && newMessages.length > 0 ? newMessages.length : 1;
        this.unseenCount += newCount;
        const newMsgBtn = document.getElementById('btn-tg-new-messages');
        const countEl = document.getElementById('btn-tg-new-messages-count');
        if (countEl) countEl.textContent = this.unseenCount;
        newMsgBtn?.classList.remove('hidden');
      }
    } else if (NavigationController.currentTab === 'ai') {
      AIService?.render();
    }
  },

  async analyzeMessageAsync(msg, followedList) {
    const s = StorageManager.getSettings();
    // Вимога п.6: AI повинен бути вимкненим за замовчуванням. Якщо вимкнено — жодних запитів та фонового аналізу!
    if (s.aiEnabled !== true || s.aiAnalyzeMessages === false) return;

    // Перевірка фільтру регіону для аналізу (Вимога п.7: Регіони для аналізу)
    if (s.aiRegions === 'followed' && FollowManager.followedSet.size > 0) {
      const text = (msg.text || '').toLowerCase();
      let matches = false;
      for (const f of FollowManager.followedSet) {
        if (text.includes(f.toLowerCase())) { matches = true; break; }
      }
      if (!matches) return;
    }

    // Стабільний відбиток повідомлення (Вимога п.15: channel + text + date)
    const key = msg.id || `${msg.channel || ''}::${(msg.date || '').slice(0, 19)}::${(msg.text || '').trim()}`;
    if (this.analyzedCache.has(key)) return;

    let analysis = null;

    // 1. Спроба через серверний endpoint (якщо запущено з бекендом)
    try {
      const res = await fetch('/api/v1/analyze-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, followedTerritories: followedList })
      }).catch(() => null);

      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.analysis) {
          analysis = data.analysis;
        }
      }
    } catch (e) {}

    // 2. Безпечний клієнтський fallback (працює на GitHub Pages без сервера)
    if (!analysis) {
      analysis = analyzeWithLocalNlp(msg.text || '', followedList);
    }

    if (analysis) {
      // Фільтрація за типами інформації (Вимога п.7)
      const isThreat = analysis.category === 'active_threat' || analysis.category === 'possible_threat';
      const isLaunch = (analysis.summary || '').toLowerCase().includes('пуск') || (analysis.summary || '').toLowerCase().includes('запуск');
      if (isThreat && s.aiTypeThreats === false) return;
      if (isLaunch && s.aiTypeLaunches === false) return;
      if (!isThreat && !isLaunch && s.aiTypeInfo === false) return;

      this.analyzedCache.set(key, analysis);
      msg._analysis = analysis;

      // Оновлюємо сповіщення аналітикою LLM/NLP
      const notif = this.notifications.find(n => n.id === `msg_${key}` || n.sourceId === msg.id);
      if (notif) {
        notif.analysis = {
          ...analysis,
          analyzedAt: new Date().toISOString()
        };
        if (analysis.territories && analysis.territories.length) {
          notif.territory = analysis.territories.join(', ');
        }
        this.saveNotifications();
      }

      if (analysis.relevant && s.aiEnabled && s.aiNotifications && !isInitialLoad) {
        if (analysis.category === 'active_threat' || analysis.category === 'possible_threat') {
          const isUrgent = analysis.category === 'active_threat';
          const primaryTerritory = (analysis.territories || [])[0] || '';
          NotificationDispatcher.dispatch({
            id: `ai_analysis_${key}`,
            type: NOTIFICATION_CATEGORIES.AI_ANALYSIS,
            priority: isUrgent ? NOTIFICATION_PRIORITIES.URGENT : NOTIFICATION_PRIORITIES.NORMAL,
            title: `ШІ: ${(analysis.territories || []).join(', ') || 'Аналіз загрози'}`,
            body: analysis.summary || '',
            place: primaryTerritory,
            eventTime: msg.date || null,
            source: 'ШІ RADAR',
            raw: analysis
          });
        }
      }

      if (NavigationController.currentTab === 'telegram') {
        this.render();
      } else if (NavigationController.currentTab === 'ai') {
        AIService?.render();
      }
    }
  },

  updateCounters() {
    let threatCount = 0, msgCount = 0, followedCount = 0, aiCount = 0;

    for (const n of this.notifications) {
      if (n.type === 'threat') threatCount++;
      else if (n.type === 'message') msgCount++;

      if (n.analysis || n.type === 'ai') aiCount++;
      if (this.isFollowedNotification(n)) followedCount++;
    }

    const total = this.notifications.length;

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    set('tg-count-all', total);
    set('tg-count-threats', threatCount);
    set('tg-count-messages', msgCount);
    set('tg-count-followed', followedCount);
    set('tg-count-ai', aiCount);

    const badgeDesktop = document.getElementById('tab-telegram-badge');
    const badgeMobile  = document.getElementById('m-tg-badge');

    if (badgeDesktop) {
      badgeDesktop.textContent = total;
      badgeDesktop.classList.toggle('hidden', total === 0);
    }
    if (badgeMobile) {
      badgeMobile.classList.toggle('hidden', total === 0);
    }
  },

  syncDistrictDropdown() {
    const regSelect = document.getElementById('tg-select-region');
    const distSelect = document.getElementById('tg-select-district');
    const labelInclude = document.getElementById('tg-label-include-oblast');
    const checkInclude = document.getElementById('tg-check-include-oblast');
    const resetBtn = document.getElementById('tg-btn-reset-region');

    if (regSelect) regSelect.value = State.selectedRegion || 'all';

    const isSpecificRegion = State.selectedRegion && State.selectedRegion !== 'all';

    if (distSelect) {
      if (isSpecificRegion) {
        distSelect.classList.remove('hidden');
        const districts = (window.TerritoriesManager && typeof TerritoriesManager.getDistrictsForOblast === 'function')
          ? TerritoriesManager.getDistrictsForOblast(State.selectedRegion)
          : [];
        
        distSelect.innerHTML = `<option value="all">Усі райони (${State.selectedRegion})</option>` +
          districts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
        
        distSelect.value = State.selectedDistrict || 'all';
      } else {
        distSelect.classList.add('hidden');
        distSelect.innerHTML = `<option value="all">Усі райони</option>`;
      }
    }

    if (labelInclude) {
      labelInclude.classList.toggle('hidden', !isSpecificRegion);
      labelInclude.classList.toggle('flex', isSpecificRegion);
    }
    if (checkInclude) {
      checkInclude.checked = State.showEntireRegionWithDistrict !== false;
    }
    if (resetBtn) {
      const isFiltered = isSpecificRegion || (State.selectedDistrict && State.selectedDistrict !== 'all');
      resetBtn.classList.toggle('hidden', !isFiltered);
    }
  },

  matchesRegion(n) {
    if (!State.selectedRegion || State.selectedRegion === 'all') return true;

    let parsed = n.parsedTerritory;
    if (!parsed) {
      if (window.TerritoriesManager && typeof TerritoriesManager.resolveMessageTerritory === 'function') {
        const combined = `${n.title || ''} ${n.message || ''} ${n.territory || ''}`;
        parsed = TerritoriesManager.resolveMessageTerritory(combined, n.source || '');
        n.parsedTerritory = parsed;
      }
    }

    if (!parsed || !window.TerritoriesManager || typeof TerritoriesManager.isMatchingTerritory !== 'function') {
      return false;
    }

    return TerritoriesManager.isMatchingTerritory(
      parsed,
      State.selectedRegion,
      State.selectedDistrict,
      State.showEntireRegionWithDistrict !== false
    );
  },

  isFollowedNotification(n) {
    if (!FollowManager || FollowManager.followedSet.size === 0) return true;
    let parsed = n.parsedTerritory;
    if (!parsed && window.TerritoriesManager && typeof TerritoriesManager.resolveMessageTerritory === 'function') {
      const combined = `${n.title || ''} ${n.message || ''} ${n.territory || ''}`;
      parsed = TerritoriesManager.resolveMessageTerritory(combined, n.source || '');
      n.parsedTerritory = parsed;
    }

    for (const f of FollowManager.followedSet) {
      const fl = f.toLowerCase();
      if (parsed) {
        if ((parsed.territories.localities || []).some(l => l.toLowerCase() === fl)) return true;
        if ((parsed.territories.districts || []).some(d => d.toLowerCase() === fl)) return true;
        if ((parsed.territories.oblasts || []).some(o => o.toLowerCase() === fl)) return true;
      }
      if ((n.territory || '').toLowerCase().includes(fl)) return true;
      if ((n.title || '').toLowerCase().includes(fl)) return true;
      if ((n.message || '').toLowerCase().includes(fl)) return true;
    }
    if (n.analysis && n.analysis.relevant) return true;
    return false;
  },

  render() {
    const container = document.getElementById('tg-messages-list');
    if (!container) return;

    this.syncDistrictDropdown();

    let filtered = this.notifications;

    // 1. Строга прив'язка до обраного регіону та району
    if (State.selectedRegion && State.selectedRegion !== 'all') {
      filtered = filtered.filter(n => this.matchesRegion(n));
    }

    // 2. Фільтр за категорією
    if (this.filterMode === 'threats') {
      filtered = filtered.filter(n => n.type === 'threat');
    } else if (this.filterMode === 'messages') {
      filtered = filtered.filter(n => n.type === 'message');
    } else if (this.filterMode === 'followed') {
      filtered = filtered.filter(n => this.isFollowedNotification(n));
    } else if (this.filterMode === 'ai') {
      filtered = filtered.filter(n => n.analysis || n.type === 'ai');
    }

    // 3. Пошуковий фільтр
    if (this.searchQuery) {
      const q = this.searchQuery;
      filtered = filtered.filter(n => {
        const text = (n.message || '').toLowerCase();
        const title = (n.title || '').toLowerCase();
        const territory = (n.territory || '').toLowerCase();
        const summary = (n.analysis?.summary || '').toLowerCase();
        return text.includes(q) || title.includes(q) || territory.includes(q) || summary.includes(q);
      });
    }

    // 4. Сортування: найновіші спочатку за точним API eventTime / date
    filtered.sort((a, b) => {
      const ta = new Date(a.eventTime || a.receivedAt).getTime();
      const tb = new Date(b.eventTime || b.receivedAt).getTime();
      return tb - ta;
    });

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="text-center py-20 text-gray-400">
          <div class="w-12 h-12 mx-auto mb-2 text-sky-400/60 flex items-center justify-center rounded-full bg-sky-500/10 border border-sky-500/20">
            <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          </div>
          <p class="text-sm font-semibold text-gray-200">Сповіщень не знайдено</p>
          <p class="text-xs text-gray-400 mt-1">${State.selectedRegion && State.selectedRegion !== 'all' ? `Немає сповіщень для території: <b>${escapeHtml(State.selectedRegion)}</b>. Скиньте фільтр регіону, щоб переглянути всі події.` : 'Змініть фільтр або очистіть критерій пошуку'}</p>
        </div>`;
      return;
    }

    const prevScroll = container.scrollTop;
    container.innerHTML = filtered.map(n => this.renderNotificationCard(n)).join('');
    if (prevScroll > 0) {
      container.scrollTop = prevScroll;
    }
  },

  renderNotificationCard(n) {
    const isUrgent = n.priority === 'URGENT';
    const urgentCardClass = isUrgent ? 'urgent-notification-card' : '';
    const urgentBadgeHtml = isUrgent ? '<span class="urgent-badge-pill">ТЕРМІНОВЕ СПОВІЩЕННЯ</span>' : '';

    if (n.type === 'OFFICIAL_ALERT' || n.type === 'alert') {
      const isClear = n.status === 'ВІДБІЙ';
      const c = isClear ? '#22c55e' : getAlertColor(n.level);
      const timeDisplay = isClear
        ? `Відбій: ${formatEventTime(n.receivedAt)}`
        : (n.eventTime ? `Початок: ${formatEventTime(n.eventTime)}` : `Початок: --:--`);

      return `
        <article class="tg-message-card border-red-500/30 hover:border-red-500/60 transition-colors cursor-pointer group ${urgentCardClass}" onclick="NavigationController.switchTab('map'); MapService.flyToRegion('${escapeHtml(n.territory)}'); MapService.selectAndShowDistrict('${escapeHtml(n.territory)}', true);">
          <div class="flex items-center justify-between pb-1.5 border-b border-white/10 mb-2">
            <div class="flex items-center gap-2 flex-wrap">
              ${urgentBadgeHtml}
              <span class="px-2 py-0.5 rounded text-[10px] font-bold text-white shadow-sm" style="background-color: ${c}">
                ${isClear ? 'ВІДБІЙ ТРИВОГИ' : `ОФІЦІЙНА ТРИВОГА [${(n.level || 'RED').toUpperCase()}]`}
              </span>
              <span class="text-[10px] font-mono text-gray-400">${escapeHtml(n.source || 'NEPTUN API')}</span>
            </div>
            <div class="flex items-center gap-2 font-mono text-[10px]">
              <span class="text-amber-300 font-bold">${timeDisplay}</span>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <h4 class="text-sm font-bold text-white group-hover:text-sky-300 transition-colors">${escapeHtml(n.title)}</h4>
            <span class="text-[10px] text-sky-400 opacity-0 group-hover:opacity-100 transition-opacity">Показати на карті →</span>
          </div>
          <p class="text-xs text-gray-300 mt-1 leading-relaxed">${escapeHtml(n.message)}</p>
        </article>
      `;
    }

    if (n.type === 'LAUNCH' || n.type === 'THREAT' || n.type === 'threat') {
      const isClear = n.status === 'ЛІКВІДОВАНО';
      const isLaunch = n.type === 'LAUNCH';
      const timeDisplay = n.eventTime ? `Час фіксації: ${formatEventTime(n.eventTime, true)}` : `Час: ${formatEventTime(n.receivedAt, true)}`;
      const typeBadge = isClear 
        ? 'ЦІЛЬ ЗНИКЛА' 
        : (isLaunch ? `ЗАПУСК [${(n.subtype || 'РАКЕТА').toUpperCase()}]` : `ЗАГРОЗА [${(n.subtype || 'ЦІЛЬ').toUpperCase()}]`);
      const typeBadgeClass = isClear 
        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' 
        : (isLaunch ? 'bg-red-500/25 text-red-200 border border-red-500/50' : 'bg-amber-500/20 text-amber-300 border border-amber-500/40');

      return `
        <article class="tg-message-card border-amber-500/30 hover:border-amber-500/60 transition-colors cursor-pointer group ${urgentCardClass}" onclick="NavigationController.switchTab('map'); MapService.flyToRegion('${escapeHtml(n.territory)}');">
          <div class="flex items-center justify-between pb-1.5 border-b border-white/10 mb-2">
            <div class="flex items-center gap-2 flex-wrap">
              ${urgentBadgeHtml}
              <span class="px-2 py-0.5 rounded text-[10px] font-bold ${typeBadgeClass}">
                ${typeBadge}
              </span>
              <span class="text-[10px] font-mono text-gray-400">${escapeHtml(n.source || 'NEPTUN API')}</span>
            </div>
            <span class="font-mono text-[10px] text-amber-300 font-bold">${timeDisplay}</span>
          </div>
          <div class="flex items-center justify-between">
            <h4 class="text-sm font-bold text-amber-200 group-hover:text-amber-100">${escapeHtml(n.title)} ${n.territory ? `(${escapeHtml(n.territory)})` : ''}</h4>
            <span class="text-[10px] text-sky-400 opacity-0 group-hover:opacity-100 transition-opacity">Показати на карті →</span>
          </div>
          <p class="text-xs text-gray-300 mt-1 leading-relaxed">${escapeHtml(n.message)}</p>
        </article>
      `;
    }

    // Тип 'INFORMATION' або 'message'
    const key = n.sourceId || n.id;
    const analysis = n.analysis || this.analyzedCache.get(key) || (n.rawMsg ? n.rawMsg._analysis : null);
    const msgTimeDisplay = n.eventTime ? `Повідомлення: ${formatEventTime(n.eventTime, true)}` : `Час: ${formatEventTime(n.receivedAt, true)}`;
    const channelName = n.title || n.source || 'Telegram';

    let llmHtml = '';
    if (analysis) {
      const catClass = `cat-${analysis.category || 'info'}`;
      let catBadge = '';
      if (analysis.category === 'active_threat') {
        catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-red-500/20 text-red-300 border border-red-500/40">АКТИВНА ЗАГРОЗА</span>';
      } else if (analysis.category === 'possible_threat') {
        catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-amber-500/20 text-amber-300 border border-amber-500/40">МОЖЛИВА ЗАГРОЗА</span>';
      } else if (analysis.category === 'clear') {
        catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">ВІДБІЙ ЗАГРОЗИ</span>';
      } else {
        catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-sky-500/20 text-sky-300 border border-sky-400/40">ІНФО</span>';
      }

      const territoriesBadges = (analysis.territories || []).map(t =>
        `<span class="px-1.5 py-0.2 rounded text-[10px] font-mono bg-sky-500/15 text-sky-300 border border-sky-400/25">${escapeHtml(t)}</span>`
      ).join(' ');

      const timeText = analysis.timeMentioned ? `<span class="text-amber-300 font-mono text-[10px] ml-2">${escapeHtml(analysis.timeMentioned)}</span>` : '';
      const analysisTimeDisplay = analysis.analyzedAt ? `Аналіз LLM: ${formatEventTime(analysis.analyzedAt, true)}` : '';

      llmHtml = `
        <div class="tg-llm-box ${catClass} mt-2.5 space-y-1.5">
          <div class="flex items-center justify-between flex-wrap gap-1">
            <div class="flex items-center gap-1.5">
              ${catBadge}
              <span class="text-[9px] font-mono text-gray-400 uppercase tracking-wider">[${analysis.engine || 'NLP'}]</span>
              ${timeText}
            </div>
            <div class="flex items-center gap-2 font-mono text-[9px] text-gray-400">
              ${analysisTimeDisplay ? `<span>${analysisTimeDisplay}</span>` : ''}
              <span>Впевненість: ${Math.round((analysis.confidence || 0.9) * 100)}%</span>
            </div>
          </div>

          <p class="text-xs text-gray-100 font-medium leading-relaxed">${escapeHtml(analysis.summary)}</p>

          ${territoriesBadges ? `<div class="flex flex-wrap gap-1 pt-0.5">${territoriesBadges}</div>` : ''}

          <div class="pt-1 border-t border-white/5 flex items-center justify-between text-[9px] font-mono text-gray-400">
            <span>Підтверджено першоджерелом (без домислів)</span>
            <span>${analysis.analyzedAt ? new Date(analysis.analyzedAt).toLocaleTimeString('uk-UA') : ''}</span>
          </div>
        </div>`;
    }

    return `
      <article class="tg-message-card ${urgentCardClass}">
        <div class="flex items-center justify-between pb-2 border-b border-white/10 mb-2">
          <div class="flex items-center gap-2 flex-wrap">
            ${urgentBadgeHtml}
            <span class="text-xs font-bold text-sky-300 font-mono">${escapeHtml(channelName)}</span>
            <span class="px-1.5 py-0.2 rounded text-[9px] font-mono bg-blue-500/20 text-blue-300 border border-blue-400/30">ІНФО (НЕ ТРИВОГА)</span>
          </div>
          <span class="text-[10px] font-mono text-gray-400">${msgTimeDisplay}</span>
        </div>

        <p class="text-xs text-gray-200 leading-relaxed whitespace-pre-line select-text">${escapeHtml(n.message || '')}</p>

        ${llmHtml}
      </article>`;
  }
};

const MessagesService = {
  pollIntervalMs: 6000,
  timerId: null,
  isInitialMessagesLoad: true,

  start() {
    this.poll();
    this.timerId = setInterval(() => this.poll(), this.pollIntervalMs);
  },

  async poll() {
    try {
      const messagesUrl = NEPTUN_REST_BASE ? `${NEPTUN_REST_BASE}/api/v1/messages` : '/api/v1/messages';
      const data = await fetchUtf8Json(messagesUrl).catch(async () => {
        if (!NEPTUN_REST_BASE) return fetchUtf8Json('https://neptun.in.ua/api/v1/messages');
        return { messages: [] };
      });
      const messagesList = Array.isArray(data.messages) ? data.messages : [];

      if (this.isInitialMessagesLoad) {
        for (const m of messagesList) {
          const key = m.id || `${m.channel || 'Telegram'}::${m.date || ''}::${(m.text || '').trim()}`;
          seenMessageKeys.add(key);
          NotificationDispatcher.markSeen(`msg_${key}`);
        }
        this.isInitialMessagesLoad = false;
        TelegramFeedService.handleIncomingMessages(messagesList);
        return;
      }

      const newMessages = [];
      for (const m of messagesList) {
        const key = m.id || `${m.channel || 'Telegram'}::${m.date || ''}::${(m.text || '').trim()}`;
        if (!seenMessageKeys.has(key) && !NotificationDispatcher.isSeen(`msg_${key}`)) {
          seenMessageKeys.add(key);
          newMessages.push(m);
        }
      }

      TelegramFeedService.handleIncomingMessages(messagesList, newMessages);

      for (const m of newMessages) {
        this.processNewMessage(m);
      }
    } catch (err) {
      console.debug('[MessagesService] Помилка отримання повідомлень:', err.message);
    }
  },

  processNewMessage(msg) {
    const text = msg.text || '';
    const channel = msg.channel || 'Telegram';
    const textLower = text.toLowerCase();

    let matchedTerritory = null;
    for (const followed of FollowManager.followedSet) {
      if (this.matchesTerritoryInText(text, followed)) {
        matchedTerritory = followed;
        break;
      }
    }

    const isLaunch = textLower.includes('пуск') || textLower.includes('запуск') || textLower.includes('балістик') || textLower.includes('кинджал') || textLower.includes('циркон') || textLower.includes('іскандер') || textLower.includes('калібр');
    const isUrgent = isLaunch || textLower.includes('терміново') || textLower.includes('увага');
    const category = isLaunch ? NOTIFICATION_CATEGORIES.LAUNCH : NOTIFICATION_CATEGORIES.INFORMATION;

    const key = msg.id || `${channel}::${msg.date || ''}::${text.trim()}`;

    // Аналізуємо територіальну прив'язку за змістом повідомлення (НЕ за назвою каналу)
    // і кешуємо результат, щоб GlobalTerritoryFilter не робив повторний NLP.
    const msgParsed = (typeof TerritoriesManager !== 'undefined')
      ? TerritoriesManager.resolveMessageTerritory(text, channel)
      : null;

    NotificationDispatcher.dispatch({
      id: `msg_${key}`,
      type: category,
      priority: isUrgent ? NOTIFICATION_PRIORITIES.URGENT : NOTIFICATION_PRIORITIES.NORMAL,
      title: isLaunch ? `${channel}: Пуск / Загроза` : channel,
      body: text,
      place: msgParsed?.primaryPlace || matchedTerritory || '',
      eventTime: msg.date || null,
      source: channel,
      raw: { ...msg, _parsedTerritory: msgParsed }
    });
  },

  matchesTerritoryInText(text, territoryName) {
    if (!text || !territoryName) return false;
    const t = text.toLowerCase();
    const name = territoryName.toLowerCase();

    if (name.includes('вінниц')) {
      return (
        t.includes('вінниц') || t.includes('жмеринк') || t.includes('могилів-под') ||
        t.includes('гайсин') || t.includes('тульчин') || t.includes('хмільник') ||
        t.includes('козятин') || t.includes('ладижин') || t.includes('бар') ||
        t.includes('калинівк') || t.includes('вапнярк')
      );
    }

    const stem = name.replace(/\s*(область|район|місто|м\.)/gi, '').trim();
    if (stem.length >= 4) {
      const root = stem.slice(0, stem.length - 2);
      return t.includes(root);
    }
    return t.includes(stem);
  }
};

function formatHeading(deg) {
  if (deg == null || !Number.isFinite(Number(deg))) return null;
  const d = ((Number(deg) % 360) + 360) % 360;
  const cardinals = ['Пн (0°)', 'Пн-Сх (45°)', 'Сх (90°)', 'Пд-Сх (135°)', 'Пд (180°)', 'Пд-Зх (225°)', 'Зх (270°)', 'Пн-Зх (315°)'];
  const idx = Math.round(d / 45) % 8;
  return `${d}° [${cardinals[idx]}]`;
}

const NavigationController = {
  currentTab: 'map',

  init() {
    document.getElementById('tab-btn-map')?.addEventListener('click', () => this.switchTab('map'));
    document.getElementById('tab-btn-alerts')?.addEventListener('click', () => this.switchTab('alerts'));
    document.getElementById('tab-btn-telegram')?.addEventListener('click', () => this.switchTab('telegram'));
    document.getElementById('tab-btn-ai')?.addEventListener('click', () => this.switchTab('ai'));
    document.getElementById('tab-btn-settings')?.addEventListener('click', () => this.switchTab('settings'));

    document.getElementById('m-tab-map')?.addEventListener('click', () => this.switchTab('map'));
    document.getElementById('m-tab-alerts')?.addEventListener('click', () => this.switchTab('alerts'));
    document.getElementById('m-tab-telegram')?.addEventListener('click', () => this.switchTab('telegram'));
    document.getElementById('m-tab-ai')?.addEventListener('click', () => this.switchTab('ai'));
    document.getElementById('m-tab-settings')?.addEventListener('click', () => this.switchTab('settings'));

    this.applyTabVisibility();
    this.bindSwipeNavigation();
  },

  getAvailableTabs() {
    const s = StorageManager.getSettings();
    const tabs = ['map', 'alerts', 'telegram'];
    if (s.aiTabVisible !== false) tabs.push('ai');
    return tabs;
  },

  bindSwipeNavigation() {
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let isVerticalScroll = false;
    let isHorizontalGesture = false;

    const onTouchStart = (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      
      const target = e.target;
      if (target.closest('input, select, textarea, button, #settings-modal, #modal-tree, #user-location-modal')) {
        return;
      }

      // Якщо користувач взаємодіє з картою на вкладці map
      if (this.currentTab === 'map' && target.closest('#map')) {
        // Дозволяємо перемикання з карти тільки від лівого або правого краю екрана (крайовий свайп)
        const touchX = e.touches[0].clientX;
        if (touchX > 45 && touchX < window.innerWidth - 45) {
          return;
        }
      }

      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTime = Date.now();
      isVerticalScroll = false;
      isHorizontalGesture = false;
    };

    const onTouchMove = (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      if (isVerticalScroll) return;

      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const deltaX = currentX - startX;
      const deltaY = currentY - startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (!isHorizontalGesture && !isVerticalScroll) {
        if (absY > 8 && absY > absX) {
          isVerticalScroll = true; // Нативний вертикальний скрол списку тривог чи повідомлень
          return;
        }
        if (absX > 10 && absX > absY * 1.2) {
          isHorizontalGesture = true;
        }
      }
    };

    const onTouchEnd = (e) => {
      if (isVerticalScroll || !isHorizontalGesture) return;
      if (!e.changedTouches || e.changedTouches.length !== 1) return;

      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const duration = Date.now() - startTime;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (duration < 500 && absX >= 45 && absX > 1.3 * absY) {
        const availableTabs = this.getAvailableTabs();
        const currentIdx = availableTabs.indexOf(this.currentTab);
        if (currentIdx === -1) return;

        if (deltaX < 0 && currentIdx < availableTabs.length - 1) {
          this.switchTab(availableTabs[currentIdx + 1]);
        } else if (deltaX > 0 && currentIdx > 0) {
          this.switchTab(availableTabs[currentIdx - 1]);
        }
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
  },

  applyTabVisibility() {
    const s = StorageManager.getSettings();
    const visible = s.aiTabVisible !== false;
    const desktopBtn = document.getElementById('tab-btn-ai');
    const mobileBtn  = document.getElementById('m-tab-ai');
    if (desktopBtn) desktopBtn.classList.toggle('hidden', !visible);
    if (mobileBtn)  mobileBtn.classList.toggle('hidden', !visible);
    if (!visible && this.currentTab === 'ai') {
      this.switchTab('map');
    }
  },

  switchTab(tab) {
    if (tab === 'settings') {
      UIController.openSettingsModal?.();
      return;
    }

    this.currentTab = tab;

    // Desktop buttons
    document.querySelectorAll('.nav-tab').forEach(b => {
      b.classList.remove('active', 'bg-sky-600', 'text-white', 'shadow');
      b.classList.add('text-gray-300');
    });
    const activeDesktopBtn = document.getElementById(`tab-btn-${tab}`);
    if (activeDesktopBtn) {
      activeDesktopBtn.classList.add('active', 'bg-sky-600', 'text-white', 'shadow');
      activeDesktopBtn.classList.remove('text-gray-300');
      try {
        activeDesktopBtn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      } catch (e) {}
    }

    // Mobile buttons (Floating Pill + FAB)
    document.querySelectorAll('.floating-nav-pill .mobile-tab').forEach(b => {
      b.classList.remove('active', 'bg-white/15', 'text-sky-300');
      b.classList.add('text-gray-400');
    });
    const activeMobileBtn = document.getElementById(`m-tab-${tab}`);
    if (activeMobileBtn && activeMobileBtn.closest('.floating-nav-pill')) {
      activeMobileBtn.classList.add('active', 'bg-white/15', 'text-sky-300');
      activeMobileBtn.classList.remove('text-gray-400');
    }

    // FAB AI button styling
    const fabAi = document.getElementById('m-tab-ai');
    if (fabAi) {
      if (tab === 'ai') {
        fabAi.classList.add('bg-purple-600', 'border-purple-300', 'shadow-[0_0_20px_rgba(168,85,247,0.6)]');
      } else {
        fabAi.classList.remove('bg-purple-600', 'border-purple-300', 'shadow-[0_0_20px_rgba(168,85,247,0.6)]');
      }
    }

    const viewAlerts   = document.getElementById('view-alerts');
    const viewTelegram = document.getElementById('view-telegram');
    const viewAi       = document.getElementById('view-ai');
    const leftPanel    = document.getElementById('left-panel');
    const mobileToggle = document.getElementById('btn-mobile-toggle-panel');

    if (tab === 'alerts') {
      viewAlerts?.classList.remove('hidden');
      viewTelegram?.classList.add('hidden');
      viewAi?.classList.add('hidden');
      leftPanel?.classList.add('hidden');
      mobileToggle?.classList.add('hidden');
      AlertsService.render();
    } else if (tab === 'telegram') {
      viewAlerts?.classList.add('hidden');
      viewTelegram?.classList.remove('hidden');
      viewAi?.classList.add('hidden');
      leftPanel?.classList.add('hidden');
      mobileToggle?.classList.add('hidden');
      TelegramFeedService.render();
    } else if (tab === 'ai') {
      viewAlerts?.classList.add('hidden');
      viewTelegram?.classList.add('hidden');
      viewAi?.classList.remove('hidden');
      leftPanel?.classList.add('hidden');
      mobileToggle?.classList.add('hidden');
      AIService?.updateEnabledState();
      AIService?.render();
    } else {
      // map tab
      viewAlerts?.classList.add('hidden');
      viewTelegram?.classList.add('hidden');
      viewAi?.classList.add('hidden');
      mobileToggle?.classList.remove('hidden');
      // On desktop, left panel is visible; on mobile it starts collapsed unless opened
      if (window.innerWidth >= 640) {
        leftPanel?.classList.remove('hidden');
      }
      setTimeout(() => MapService.map?.invalidateSize(), 50);
    }
  }
};

/* ============================================================
   9. MAP SERVICE (LEAFLET + SAFE-AREA POPUP + AREA-ONLY THREATS)
============================================================ */
const MapService = {
  map:                   null,
  districtsGeoJsonLayer: null,
  regionsOutlineLayer:   null,

  districtLayersByRayon: new Map(),
  rayonsByRegion:        new Map(),

  threatMarkers:         new Map(),
  threatPolylines:       new Map(),

  currentSelectedLayer:  null,
  currentPopup:          null,

  async init() {
    this.map = L.map('map', {
      center:             [48.3794, 31.1656],
      zoom:               6,
      minZoom:            5,
      maxZoom:            14,
      zoomControl:        true,
      attributionControl: true
    });

    // 1. Створюємо окремий Leaflet pane для текстових підписів населених пунктів.
    // zIndex: 450 розташовує підписи НАД кольоровими полігонами тривог (overlayPane має zIndex: 400),
    // але ПІД тактичними маркерами цілей (markerPane має zIndex: 600).
    const labelsPane = this.map.createPane('labels');
    labelsPane.style.zIndex = 450;
    labelsPane.style.pointerEvents = 'none';

    // 2. Базовий темний картографічний шар (земля, вода, контури)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 16
    }).addTo(this.map);

    // 3. Шар підписів міст та населених пунктів України (Київ, Вінниця, Жмеринка, Літин, Хмільник тощо)
    // Рендериться в labelsPane, тому ніколи не перекривається червоними/жовтими зонами тривог!
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 16,
      pane: 'labels'
    }).addTo(this.map);

    await Promise.all([
      this.loadDistrictsGeoJson(),
      this.loadRegionsOutline()
    ]);

    this.map.on('click', (e) => {
      if (!e.originalEvent._handledByDistrict) {
        this.clearDistrictSelection();
      }
    });

    this.map.on('zoomend', () => this.updateMarkerScales());
    this.updateMarkerScales();

    const handleMapResize = () => {
      this.map?.invalidateSize();
      if (this.currentPopup && this.currentPopup.isOpen()) {
        this.ensurePopupVisible(this.currentPopup);
      }
    };
    window.addEventListener('resize', handleMapResize);
    window.addEventListener('orientationchange', () => {
      setTimeout(handleMapResize, 150);
    });
  },

  updateMarkerScales() {
    if (!this.map) return;
    const zoom = this.map.getZoom();
    const container = this.map.getContainer();
    if (!container) return;
    container.classList.remove('zoom-low', 'zoom-mid', 'zoom-high');
    if (zoom <= 6) {
      container.classList.add('zoom-low');
    } else if (zoom <= 9) {
      container.classList.add('zoom-mid');
    } else {
      container.classList.add('zoom-high');
    }
  },

  async loadDistrictsGeoJson() {
    try {
      const data = await fetchUtf8Json(`${BASE_PATH}ukraine_districts.geojson`);

      this.districtsGeoJsonLayer = L.geoJSON(data, {
        style:         (f) => this.getDistrictStyle(f.properties.rayon, f.properties.region),
        onEachFeature: (feature, layer) => {
          const rayon      = (feature.properties.rayon || '').trim();
          const region     = (feature.properties.region || '').trim();
          const normRayon  = normalizeName(rayon);
          const normRegion = normalizeName(region);

          this.districtLayersByRayon.set(normRayon, layer);

          if (!this.rayonsByRegion.has(normRegion)) {
            this.rayonsByRegion.set(normRegion, new Set());
          }
          this.rayonsByRegion.get(normRegion).add(normRayon);

          layer.on({
            mouseover: (e) => {
              if (layer !== this.currentSelectedLayer) {
                layer.setStyle({ weight: 2.2, color: '#38bdf8' });
                layer.bringToFront();
              }
            },
            mouseout: (e) => {
              if (layer !== this.currentSelectedLayer) {
                this.districtsGeoJsonLayer.resetStyle(layer);
              }
            },
            click: (e) => {
              e.originalEvent._handledByDistrict = true;
              this.onDistrictClicked(rayon, region, layer, e.latlng);
            }
          });
        }
      }).addTo(this.map);

      this.updateAllDistrictStyles();
    } catch (err) {
      console.error('[MapService] Помилка завантаження районів:', err);
    }
  },

  async loadRegionsOutline() {
    try {
      const data = await fetchUtf8Json(`${BASE_PATH}ukraine_regions.geojson`);
      this.regionsOutlineLayer = L.geoJSON(data, {
        style: {
          fill:        false,
          color:       '#475569',
          weight:      1.8,
          opacity:     0.85,
          interactive: false
        }
      }).addTo(this.map);
    } catch (e) {}
  },

  getDistrictAlert(rayonName, regionName) {
    const normRayon      = normalizeName(rayonName);
    const strippedRayon  = normRayon.replace(/\s+район$/, '').trim();
    const normRegion     = normalizeName(regionName);
    const strippedRegion = normRegion.replace(/\s+область$/, '').trim();

    if (normRayon === 'київ' || normRegion === 'київ') {
      return State.specialCities.get('київ') || null;
    }

    if (normRayon === 'севастополь' || normRegion === 'севастополь') {
      return State.specialCities.get('севастополь') || null;
    }

    if (State.raions.has(normRayon)) {
      return State.raions.get(normRayon);
    }
    if (strippedRayon && State.raions.has(strippedRayon)) {
      return State.raions.get(strippedRayon);
    }

    if (normRegion && State.oblasts.has(normRegion)) {
      return State.oblasts.get(normRegion);
    }
    if (strippedRegion && State.oblasts.has(strippedRegion)) {
      return State.oblasts.get(strippedRegion);
    }

    if (normRegion.includes('крим') && (State.oblasts.has('крим') || State.oblasts.has('автономна республіка крим'))) {
      return State.oblasts.get('крим') || State.oblasts.get('автономна республіка крим');
    }

    return null;
  },

  getDistrictStyle(rayonName, regionName) {
    const s = StorageManager.getSettings();
    const alert = this.getDistrictAlert(rayonName, regionName);

    if (alert && s.layerAlerts) {
      const lvl = (alert.level || '').toLowerCase();
      // Лише активні тривоги підсвічуються як небезпека (не green, none, clear, inactive)
      if (lvl === 'red' || lvl === 'yellow' || lvl === 'orange') {
        const color = getAlertColor(alert.level);
        return {
          fillColor:   color,
          fillOpacity: s.zoneOpacity || 0.35,
          color:       color,
          weight:      1.5,
          dashArray:   '',
          className:   'district-alert-active'
        };
      }
    }

    return {
      fillColor:   '#1e293b',
      fillOpacity: 0.08,
      color:       '#334155',
      weight:      0.8,
      dashArray:   '2, 4',
      className:   ''
    };
  },

  updateAllDistrictStyles() {
    if (!this.districtsGeoJsonLayer) return;
    this.districtsGeoJsonLayer.eachLayer((layer) => {
      if (layer === this.currentSelectedLayer) {
        layer.setStyle({ weight: 2.8, color: '#38bdf8' });
      } else {
        const rayon  = layer.feature.properties.rayon;
        const region = layer.feature.properties.region;
        layer.setStyle(this.getDistrictStyle(rayon, region));
      }
    });
  },

  onDistrictClicked(rayon, region, layer, clickLatLng) {
    if (this.currentSelectedLayer && this.currentSelectedLayer !== layer) {
      this.districtsGeoJsonLayer.resetStyle(this.currentSelectedLayer);
    }
    this.currentSelectedLayer = layer;
    layer.setStyle({ weight: 2.8, color: '#38bdf8' });
    layer.bringToFront();

    const center = clickLatLng || layer.getBounds().getCenter();
    const html   = this.buildDistrictCardHtml(rayon, region);

    if (this.currentPopup) {
      this.map.closePopup(this.currentPopup);
    }

    this.currentPopup = L.popup({
      className:   'radar-district-popup',
      autoPan:     false,
      closeButton: true,
      offset:      [0, -10]
    })
    .setLatLng(center)
    .setContent(html)
    .openOn(this.map);

    this.currentPopup.on('remove', () => {
      this.clearDistrictSelection();
    });

    requestAnimationFrame(() => {
      this.ensurePopupVisible(this.currentPopup);
    });

    UIController.updateSelectedTerritoryCard?.(rayon, rayon, region, false);
  },

  clearDistrictSelection() {
    if (this.currentSelectedLayer) {
      this.districtsGeoJsonLayer.resetStyle(this.currentSelectedLayer);
      this.currentSelectedLayer = null;
    }
    this.currentPopup = null;
    document.getElementById('selected-territory-card')?.classList.add('hidden');
  },

  buildDistrictCardHtml(rayon, region) {
    const alert = this.getDistrictAlert(rayon, region);
    const isKyiv = normalizeName(rayon) === 'київ';
    const isSevastopol = normalizeName(rayon) === 'севастополь';

    const territoryName = isKyiv ? 'м. Київ' : (isSevastopol ? 'Севастополь' : rayon);
    const parentName    = isKyiv || isSevastopol ? 'Місто зі спеціальним статусом' : region;

    const isStarred = FollowManager.isFollowed(territoryName);
    const starBtnText = isStarred ? 'Відстежується' : 'Слідкувати';
    const starBtnClass = isStarred
      ? 'px-2 py-1 rounded bg-amber-500/25 border border-amber-400 text-amber-300 font-bold text-[10px]'
      : 'px-2 py-1 rounded bg-white/10 hover:bg-white/20 border border-white/20 text-gray-200 text-[10px]';

    let threatCount = 0;
    const normR = normalizeName(rayon);
    const normReg = normalizeName(region);
    for (const t of State.threats.values()) {
      if (t.district && normalizeName(t.district) === normR) threatCount++;
      else if (t.region && normalizeName(t.region) === normReg && !t.district) threatCount++;
    }

    let statusBadge = '';
    let detailsHtml = '';

    if (alert) {
      const color = getAlertColor(alert.level);
      const lvlUpper = (alert.level || 'RED').toUpperCase();
      statusBadge = `<span class="px-2 py-0.5 rounded font-bold text-white text-[10px] shadow" style="background-color: ${color}">АКТИВНА [${lvlUpper}]</span>`;

      const sinceFormatted = alert.since ? new Date(alert.since).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : 'Не вказано';
      detailsHtml += `
        <div class="flex justify-between py-1 border-b border-white/10">
          <span class="text-gray-400">Час початку:</span>
          <span class="text-gray-200 font-mono">${sinceFormatted}</span>
        </div>
      `;

      if (alert.reasons && alert.reasons.length > 0) {
        detailsHtml += `
          <div class="py-1 border-b border-white/10">
            <span class="text-gray-400 block mb-0.5">Причина небезпеки:</span>
            <span class="text-amber-300 text-[10px]">${alert.reasons.join(', ')}</span>
          </div>
        `;
      }
    } else {
      statusBadge = `<span class="px-2 py-0.5 rounded font-bold text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 text-[10px]">СПОКІЙНО (Тривога: НІ)</span>`;
    }

    if (threatCount > 0) {
      detailsHtml += `
        <div class="flex justify-between py-1 border-b border-white/10 text-amber-400">
          <span>Активних цілей поруч:</span>
          <span class="font-bold">${threatCount}</span>
        </div>
      `;
    }

    return `
      <div class="radar-popup-content font-sans">
        <div class="flex items-start justify-between pb-2 border-b border-white/10 mb-2">
          <div>
            <h4 class="font-bold text-white text-xs tracking-wide">${territoryName}</h4>
            <p class="text-[10px] text-gray-400">${parentName}</p>
          </div>
          <button onclick="FollowManager.toggleFollowByName('${territoryName}'); MapService.refreshSelectedDistrictPopup();" class="${starBtnClass}">
            ${starBtnText}
          </button>
        </div>

        <div class="radar-popup-scrollable text-[11px] space-y-1 mb-2">
          <div class="flex justify-between items-center py-1 border-b border-white/10">
            <span class="text-gray-400">Статус:</span>
            ${statusBadge}
          </div>
          ${detailsHtml}
        </div>

        <div class="text-[9px] text-gray-400 text-right font-mono">
          Дані: NEPTUN API (${State.lastSyncTime || '--:--:--'})
        </div>
      </div>
    `;
  },

  refreshSelectedDistrictPopup() {
    if (!this.currentPopup || !this.currentSelectedLayer) return;
    const r = this.currentSelectedLayer.feature.properties.rayon;
    const reg = this.currentSelectedLayer.feature.properties.region;
    this.currentPopup.setContent(this.buildDistrictCardHtml(r, reg));
  },

  ensurePopupVisible(popupInstance) {
    if (!popupInstance || !popupInstance.isOpen()) return;

    const popupEl = popupInstance.getElement();
    if (!popupEl) return;

    const popupRect = popupEl.getBoundingClientRect();
    const header    = document.getElementById('main-header');
    const leftPanel = document.getElementById('left-panel');
    const mobileNav = document.getElementById('mobile-nav-bar');
    const footer    = document.getElementById('main-footer');

    const safeTop = header ? header.getBoundingClientRect().bottom + 14 : 72;
    let safeBottom = footer ? footer.getBoundingClientRect().top - 8 : window.innerHeight - 30;
    if (mobileNav && window.innerWidth < 1024) {
      safeBottom = Math.min(safeBottom, mobileNav.getBoundingClientRect().top - 8);
    }

    let safeLeft = 16;
    if (leftPanel && window.getComputedStyle(leftPanel).display !== 'none' && window.innerWidth >= 768) {
      const lpRect = leftPanel.getBoundingClientRect();
      if (lpRect.right > 0 && lpRect.width > 0) {
        safeLeft = Math.max(safeLeft, lpRect.right + 16);
      }
    }

    let safeRight = window.innerWidth - 16;

    let shiftX = 0;
    let shiftY = 0;

    if (popupRect.top < safeTop) {
      shiftY = popupRect.top - safeTop - 12;
    } else if (popupRect.bottom > safeBottom) {
      shiftY = popupRect.bottom - safeBottom + 12;
    }

    if (popupRect.left < safeLeft) {
      shiftX = popupRect.left - safeLeft - 12;
    } else if (popupRect.right > safeRight) {
      shiftX = popupRect.right - safeRight + 12;
    }

    if (Math.abs(shiftX) > 2 || Math.abs(shiftY) > 2) {
      this.map.panBy([shiftX, shiftY], { animate: true, duration: 0.35 });
    }
  },

  selectAndShowDistrict(territoryName, shouldZoom = false) {
    const norm = normalizeName(territoryName);
    const layer = this.districtLayersByRayon.get(norm);

    if (layer) {
      const bounds = layer.getBounds();
      const center = bounds.getCenter();

      if (shouldZoom) {
        const targetZoom = Math.min(Math.max(this.map.getZoom(), 8), 10);
        this.map.setView(center, targetZoom, { animate: true, duration: 0.8 });
      }

      const r = layer.feature.properties.rayon;
      const reg = layer.feature.properties.region;
      this.onDistrictClicked(r, reg, layer, center);
    }
  },

  flyToRegion(regionName) {
    if (regionName === 'all') {
      this.map.flyTo([48.3794, 31.1656], 6, { duration: 1.0 });
      return;
    }

    if (regionName === 'Київ') {
      this.map.flyTo([50.4501, 30.5234], 10, { duration: 1.0 });
      this.selectAndShowDistrict('Київ', false);
      return;
    }

    if (regionName === 'Севастополь') {
      this.map.flyTo([44.6166, 33.5254], 10, { duration: 1.0 });
      this.selectAndShowDistrict('Севастополь', false);
      return;
    }

    if (regionName === 'Автономна Республіка Крим' || regionName === 'Крим') {
      this.map.flyTo([45.3453, 34.4997], 8, { duration: 1.0 });
      return;
    }

    if (regionName === 'Луганська область') {
      this.map.flyTo([48.9725, 38.9950], 8, { duration: 1.0 });
      return;
    }

    if (regionName === 'Донецька область') {
      this.map.flyTo([48.0159, 37.8028], 8, { duration: 1.0 });
      return;
    }

    const normReg = normalizeName(regionName);
    const rayons = this.rayonsByRegion.get(normReg);
    if (rayons && rayons.size > 0) {
      const bounds = L.latLngBounds();
      for (const r of rayons) {
        const l = this.districtLayersByRayon.get(r);
        if (l?.getBounds) bounds.extend(l.getBounds());
      }
      if (bounds.isValid()) {
        this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 9, duration: 1.0 });
      }
    }
  },

  animateMarkerMovement(marker, toCoords, duration = 1200) {
    if (!marker || !toCoords || toCoords.length < 2) return;
    const [toLat, toLng] = toCoords;
    const currentLatLng = marker.getLatLng();
    if (!currentLatLng) {
      marker.setLatLng(toCoords);
      return;
    }
    const fromLat = currentLatLng.lat;
    const fromLng = currentLatLng.lng;

    // Якщо координати практично не змінилися (< 1м)
    if (Math.abs(fromLat - toLat) < 0.00001 && Math.abs(fromLng - toLng) < 0.00001) {
      marker.setLatLng(toCoords);
      return;
    }

    // Скасовуємо попередній кадр анімації, якщо рух ще тривав
    if (marker._moveAnimId) {
      cancelAnimationFrame(marker._moveAnimId);
      marker._moveAnimId = null;
    }

    const startTime = performance.now();

    const step = (currentTime) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1.0);

      // Плавна cubic ease-out інтерполяція між точкою A і точкою B
      const ease = 1 - Math.pow(1 - progress, 3);

      const curLat = fromLat + (toLat - fromLat) * ease;
      const curLng = fromLng + (toLng - fromLng) * ease;

      marker.setLatLng([curLat, curLng]);

      if (progress < 1.0) {
        marker._moveAnimId = requestAnimationFrame(step);
      } else {
        // Зупиняємося чітко в реальній точці B (без вигаданого руху далі)
        marker.setLatLng([toLat, toLng]);
        marker._moveAnimId = null;
      }
    };

    marker._moveAnimId = requestAnimationFrame(step);
  },

  updateThreat(threat) {
    const s = StorageManager.getSettings();
    const coords = threat.coordinates;
    if (!coords || !s.layerThreats) {
      this.removeThreat(threat.id);
      return;
    }

    const [lat, lng] = coords;
    const now = Date.now();
    threat._receivedAt = threat._receivedAt || now;
    threat._lastSeen = now;

    // 1. Керування маркером цілі
    let marker = this.threatMarkers.get(threat.id);
    if (!marker) {
      marker = L.marker([lat, lng], {
        icon: SvgIconFactory.createThreatIcon(threat.type, threat.heading, threat.areaOnly)
      }).addTo(this.map);
      marker._threatData = threat;
      marker._lastUpdated = now;
      this.threatMarkers.set(threat.id, marker);
    } else {
      marker._threatData = threat;
      marker._lastUpdated = now;
      marker.setIcon(SvgIconFactory.createThreatIcon(threat.type, threat.heading, threat.areaOnly));

      if (threat.areaOnly) {
        // Для areaOnly не імітуємо рух/політ — маркер фіксується у центрі зони
        if (marker._moveAnimId) {
          cancelAnimationFrame(marker._moveAnimId);
          marker._moveAnimId = null;
        }
        marker.setLatLng([lat, lng]);
      } else {
        // Для реальних цілей з точними координатами: плавний рух з точки A в точку B
        this.animateMarkerMovement(marker, [lat, lng], 1200);
      }
    }

    // 2. Реальний трек / шлях (TRAIL)
    // Рендериться ТІЛЬКИ якщо є реальний масив точок (з API trail або накопичених оновлень >= 2)
    // і ЦІЛЬ НЕ Є areaOnly
    let displayTrail = null;
    if (!threat.areaOnly) {
      if (Array.isArray(threat.trail) && threat.trail.length >= 2) {
        displayTrail = threat.trail;
      } else {
        let traj = State.trajectories.get(threat.id);
        if (!traj) {
          traj = [[lat, lng]];
          State.trajectories.set(threat.id, traj);
        } else {
          const lastPt = traj[traj.length - 1];
          if (!lastPt || lastPt[0] !== lat || lastPt[1] !== lng) {
            traj.push([lat, lng]);
            if (traj.length > 30) traj.shift();
          }
        }
        if (traj.length >= 2) {
          displayTrail = traj;
        }
      }
    }

    let poly = this.threatPolylines.get(threat.id);
    if (displayTrail && displayTrail.length >= 2) {
      if (!poly) {
        poly = L.polyline(displayTrail, {
          color: getThreatColor(threat.type),
          weight: 2,
          dashArray: '4,4',
          opacity: 0.75
        }).addTo(this.map);
        this.threatPolylines.set(threat.id, poly);
      } else {
        poly.setLatLngs(displayTrail);
      }
    } else if (poly) {
      this.map.removeLayer(poly);
      this.threatPolylines.delete(threat.id);
    }

    // 3. Формування тактичного опису та перевірка на застарілість (Stale Target)
    const isStale = (now - (marker._lastUpdated || now)) > 45000;
    const details = [];
    if (threat.areaOnly) {
      details.push(`<div class="text-amber-400 font-semibold mb-1">Загроза по області (орієнтовний район, не точні координати)</div>`);
    } else {
      if (threat.locality) details.push(`<div><span class="text-gray-400">Населений пункт:</span> <b>${escapeHtml(threat.locality)}</b></div>`);
      if (threat.heading != null) details.push(`<div><span class="text-gray-400">Курс:</span> <b>${formatHeading(threat.heading)}</b></div>`);
      if (threat.speed != null) details.push(`<div><span class="text-gray-400">Швидкість:</span> <b>${threat.speed} км/год</b></div>`);
      if (threat.altitude != null) details.push(`<div><span class="text-gray-400">Висота:</span> <b>${threat.altitude} м</b></div>`);
      details.push(`<div><span class="text-gray-400">Координати:</span> <span class="font-mono text-[10px] text-gray-300">${lat.toFixed(4)}, ${lng.toFixed(4)}</span></div>`);
    }

    if (isStale) {
      details.push(`<div class="text-amber-300 font-mono text-[10px] mt-1 bg-amber-500/10 p-1 rounded border border-amber-500/20">Останнє оновлення &gt; 45 сек тому</div>`);
    }

    marker.bindPopup(`
      <div class="custom-radar-popup p-1 font-mono text-[11px]">
        <div class="pb-1 mb-1 border-b border-amber-500/30 text-amber-400 font-bold uppercase">
          ${threat.areaOnly ? 'ОБЛАСНА ЗАГРОЗА' : 'АКТИВНА ЦІЛЬ'} (${threat.title || threat.type})
        </div>
        <div><span class="text-gray-400">ID:</span> <b>${threat.id}</b></div>
        <div><span class="text-gray-400">Регіон:</span> ${threat.region}${threat.district ? ` (${threat.district})` : ''}</div>
        ${details.join('')}
        <div><span class="text-gray-400">Час засічки:</span> ${threat.time || 'Н/Д'}</div>
      </div>`, {
        className: 'custom-radar-popup',
        autoPanPaddingTopLeft: [15, 80],
        autoPanPaddingBottomRight: [15, 90]
      });
  },

  removeThreat(threatId) {
    const marker = this.threatMarkers.get(threatId);
    if (marker) {
      if (marker._moveAnimId) {
        cancelAnimationFrame(marker._moveAnimId);
        marker._moveAnimId = null;
      }
      this.map.removeLayer(marker);
      this.threatMarkers.delete(threatId);
    }
    const poly = this.threatPolylines.get(threatId);
    if (poly) {
      this.map.removeLayer(poly);
      this.threatPolylines.delete(threatId);
    }
    State.trajectories.delete(threatId);
  },

  userMarker: null,
  userRadiusCircle: null,

  updateUserLocation(lat, lon, accuracy, radiusKm) {
    if (!this.map || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

    if (!this.userMarker) {
      const icon = L.divIcon({
        className: 'user-location-marker-container',
        html: '<div class="user-location-marker"><div class="user-location-pulse"></div><div class="user-location-dot"></div></div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });
      this.userMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 }).addTo(this.map);
    } else {
      this.userMarker.setLatLng([lat, lon]);
    }

    if (radiusKm && radiusKm > 0) {
      if (!this.userRadiusCircle) {
        this.userRadiusCircle = L.circle([lat, lon], {
          radius: radiusKm * 1000,
          color: '#0284c7',
          weight: 1.5,
          dashArray: '4, 6',
          fillColor: '#38bdf8',
          fillOpacity: 0.08,
          interactive: false
        }).addTo(this.map);
      } else {
        this.userRadiusCircle.setLatLng([lat, lon]);
        this.userRadiusCircle.setRadius(radiusKm * 1000);
      }
    } else if (this.userRadiusCircle) {
      this.map.removeLayer(this.userRadiusCircle);
      this.userRadiusCircle = null;
    }
  },

  removeUserLocation() {
    if (this.userMarker && this.map) {
      this.map.removeLayer(this.userMarker);
      this.userMarker = null;
    }
    if (this.userRadiusCircle && this.map) {
      this.map.removeLayer(this.userRadiusCircle);
      this.userRadiusCircle = null;
    }
  }
};

/* ============================================================
   10. FOLLOW MANAGER (ВІДСТЕЖЕННЯ ТЕРИТОРІЙ + ВІННИЦЯ)
============================================================ */
const FollowManager = {
  followedSet: new Set(),

  init() {
    try {
      const saved = localStorage.getItem('radar_followed_territories_v5');
      if (saved) {
        this.followedSet = new Set(JSON.parse(saved));
      } else {
        // За замовчуванням пропонуємо Вінницьку область
        this.followedSet = new Set(['Вінницька область']);
      }
    } catch (e) {
      this.followedSet = new Set(['Вінницька область']);
    }
    this.renderFollowedList();
  },

  isFollowed(name) {
    return this.followedSet.has(name);
  },

  matchesFollowed(name) {
    if (!name) return false;
    if (this.followedSet.has(name)) return true;
    const norm = normalizeName(name);
    for (const f of this.followedSet) {
      if (normalizeName(f) === norm) return true;
    }
    return false;
  },

  toggleFollowByName(name) {
    if (!name) return;
    if (this.followedSet.has(name)) {
      this.followedSet.delete(name);
      showToast(`Припинено стеження за: ${name}`);
    } else {
      this.followedSet.add(name);
      showToast(`Стеження за: ${name}`);
    }
    this.save();
    this.renderFollowedList();
  },

  save() {
    try {
      localStorage.setItem('radar_followed_territories_v5', JSON.stringify(Array.from(this.followedSet)));
    } catch (e) {}
  },

  renderFollowedList() {
    const listEl  = document.getElementById('followed-territories-list');
    const countEl = document.getElementById('followed-count');
    if (!listEl) return;

    if (countEl) countEl.textContent = this.followedSet.size;

    if (this.followedSet.size === 0) {
      listEl.innerHTML = `<p class="text-[10px] text-gray-400 text-center py-2 italic">Натисніть зірочку біля території для швидкого стеження</p>`;
      return;
    }

    const items = Array.from(this.followedSet);
    listEl.innerHTML = items.map(name => {
      const norm = normalizeName(name);
      let alert = null;
      if (norm === 'київ') alert = State.specialCities.get('київ');
      else if (norm === 'севастополь') alert = State.specialCities.get('севастополь');
      else if (State.raions.has(norm)) alert = State.raions.get(norm);
      else if (State.oblasts.has(norm)) alert = State.oblasts.get(norm);

      const isAct = !!alert;
      const statusBadge = isAct
        ? `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold text-white shadow-sm" style="background-color: ${getAlertColor(alert.level)}">ТРИВОГА</span>`
        : `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20">СПОКІЙНО</span>`;

      return `
        <div class="flex items-center justify-between p-1.5 rounded-lg bg-black/40 hover:bg-white/5 border border-white/10 transition-colors cursor-pointer group" onclick="MapService.selectAndShowDistrict('${name}', true)">
          <div class="flex items-center gap-1.5 truncate">
            <svg class="w-3.5 h-3.5 text-sky-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/><circle cx="12" cy="10" r="3"/></svg>
            <span class="text-xs font-semibold text-gray-200 truncate group-hover:text-sky-300">${name}</span>
          </div>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            ${statusBadge}
            <button onclick="event.stopPropagation(); FollowManager.toggleFollowByName('${name}');" class="text-amber-400 hover:text-white p-0.5" title="Видалити">
              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        </div>
      `;
    }).join('');
  }
};

/* ============================================================
   11. TERRITORIES MANAGER (ПОШУК, ІЄРАРХІЯ ТА АДМІНІСТРАТИВНИЙ РЕЗОЛВЕР)
============================================================ */
const TerritoriesManager = {
  hierarchy:          [],
  flat:               [],
  byId:               new Map(),
  oblastDistrictsMap: {},
  districtOblastMap:  {},
  cityDistrictMap:    {},
  cityOblastMap:      {},
  allDistricts:       new Set(),
  allOblasts:         new Set(),
  allCities:          new Set(),

  extraLocalities: [
    // Населені пункти Вінницького району
    { city: 'Стрижавка', district: 'Вінницький район', oblast: 'Вінницька область' },
    { city: 'Вороновиця', district: 'Вінницький район', oblast: 'Вінницька область' },
    { city: 'Літин', district: 'Вінницький район', oblast: 'Вінницька область' },
    { city: 'Погребище', district: 'Вінницький район', oblast: 'Вінницька область' },
    { city: 'Оратів', district: 'Вінницький район', oblast: 'Вінницька область' },
    { city: 'Тиврів', district: 'Вінницький район', oblast: 'Вінницька область' },
    { city: 'Сутиски', district: 'Вінницький район', oblast: 'Вінницька область' },
    { city: 'Лука-Мелешківська', district: 'Вінницький район', oblast: 'Вінницька область' },
    { city: 'Якушинці', district: 'Вінницький район', oblast: 'Вінницька область' },
    { city: 'Агрономічне', district: 'Вінницький район', oblast: 'Вінницька область' },
    // Інші райони Вінницької області
    { city: 'Ладижин', district: 'Гайсинський район', oblast: 'Вінницька область' },
    { city: 'Бершадь', district: 'Гайсинський район', oblast: 'Вінницька область' },
    { city: 'Теплик', district: 'Гайсинський район', oblast: 'Вінницька область' },
    { city: 'Тростянець', district: 'Гайсинський район', oblast: 'Вінницька область' },
    { city: 'Чечельник', district: 'Гайсинський район', oblast: 'Вінницька область' },
    { city: 'Бар', district: 'Жмеринський район', oblast: 'Вінницька область' },
    { city: 'Шаргород', district: 'Жмеринський район', oblast: 'Вінницька область' },
    { city: 'Калинівка', district: 'Хмільницький район', oblast: 'Вінницька область' },
    { city: 'Козятин', district: 'Хмільницький район', oblast: 'Вінницька область' },
    { city: 'Вапнярка', district: 'Тульчинський район', oblast: 'Вінницька область' },
    { city: 'Крижопіль', district: 'Тульчинський район', oblast: 'Вінницька область' },
    { city: 'Томашпіль', district: 'Тульчинський район', oblast: 'Вінницька область' },
    { city: 'Піщанка', district: 'Тульчинський район', oblast: 'Вінницька область' },
    { city: 'Ямпіль', district: 'Могилів-Подільський район', oblast: 'Вінницька область' },
    { city: 'Муровані Курилівці', district: 'Могилів-Подільський район', oblast: 'Вінницька область' },
    // Інші ключові міста та райони України
    { city: 'Кременчук', district: 'Кременчуцький район', oblast: 'Полтавська область' },
    { city: 'Миргород', district: 'Миргородський район', oblast: 'Полтавська область' },
    { city: 'Лубни', district: 'Лубенський район', oblast: 'Полтавська область' },
    { city: 'Очаків', district: 'Миколаївський район', oblast: 'Миколаївська область' },
    { city: 'Вознесенськ', district: 'Вознесенський район', oblast: 'Миколаївська область' },
    { city: 'Первомайськ', district: 'Первомайський район', oblast: 'Миколаївська область' },
    { city: 'Бровари', district: 'Броварський район', oblast: 'Київська область' },
    { city: 'Бориспіль', district: 'Бориспільський район', oblast: 'Київська область' },
    { city: 'Біла Церква', district: 'Білоцерківський район', oblast: 'Київська область' },
    { city: 'Фастів', district: 'Фастівський район', oblast: 'Київська область' },
    { city: 'Буча', district: 'Бучанський район', oblast: 'Київська область' },
    { city: 'Ірпінь', district: 'Бучанський район', oblast: 'Київська область' },
    { city: 'Вишгород', district: 'Вишгородський район', oblast: 'Київська область' },
    { city: 'Обухів', district: 'Обухівський район', oblast: 'Київська область' },
    { city: 'Кривий Ріг', district: 'Криворізький район', oblast: 'Дніпропетровська область' },
    { city: 'Нікополь', district: 'Нікопольський район', oblast: 'Дніпропетровська область' },
    { city: 'Павлоград', district: 'Павлоградський район', oblast: 'Дніпропетровська область' },
    { city: 'Камʼянське', district: 'Камʼянський район', oblast: 'Дніпропетровська область' },
    { city: 'Новомосковськ', district: 'Самарівський район', oblast: 'Дніпропетровська область' }
  ],

  async load() {
    try {
      const territoriesUrl = NEPTUN_REST_BASE ? `${NEPTUN_REST_BASE}/api/v1/territories` : '/api/v1/territories';
      const data = await fetchUtf8Json(territoriesUrl).catch(async () => {
        if (!NEPTUN_REST_BASE) return fetchUtf8Json('https://neptun.in.ua/api/v1/territories');
        throw new Error('Territories API unavailable');
      });
      this.hierarchy = data.hierarchy || [];
      this.flat      = data.flat || [];
      this.byId.clear();
      for (const item of this.flat) this.byId.set(item.id, item);
    } catch (err) {
      console.warn('[TerritoriesManager] Завантаження з локального файлу...');
      const data = await fetchUtf8Json(`${BASE_PATH}territories.json`);
      this.hierarchy = data.hierarchy || [];
      this.flat      = data.flat || [];
      this.byId.clear();
      for (const item of this.flat) this.byId.set(item.id, item);
    }
    this.buildIndices();
  },

  buildIndices() {
    this.oblastDistrictsMap = {};
    this.districtOblastMap  = {};
    this.cityDistrictMap    = {};
    this.cityOblastMap      = {};
    this.allDistricts.clear();
    this.allOblasts.clear();
    this.allCities.clear();

    for (const reg of this.hierarchy) {
      const regName = reg.name;
      this.allOblasts.add(regName);
      if (!this.oblastDistrictsMap[regName]) this.oblastDistrictsMap[regName] = [];

      for (const dist of (reg.districts || [])) {
        const distName = dist.name;
        this.allDistricts.add(distName);
        this.oblastDistrictsMap[regName].push(distName);
        this.districtOblastMap[distName] = regName;

        for (const city of (dist.cities || [])) {
          const cityName = city.name;
          this.allCities.add(cityName);
          this.cityDistrictMap[cityName] = distName;
          this.cityOblastMap[cityName]   = regName;
        }
      }
    }

    // Додаємо розширений словник населених пунктів
    for (const item of this.extraLocalities) {
      this.allCities.add(item.city);
      this.cityDistrictMap[item.city] = item.district;
      this.cityOblastMap[item.city]   = item.oblast;
      if (item.oblast && this.oblastDistrictsMap[item.oblast]) {
        if (!this.oblastDistrictsMap[item.oblast].includes(item.district)) {
          this.oblastDistrictsMap[item.oblast].push(item.district);
        }
      }
      this.districtOblastMap[item.district] = item.oblast;
      this.allDistricts.add(item.district);
    }
  },

  getDistrictsForOblast(oblastName) {
    if (!oblastName || oblastName === 'all') return [];
    return this.oblastDistrictsMap[oblastName] || [];
  },

  resolveMessageTerritory(text, channel = '') {
    if (!text && !channel) {
      return {
        territories: { country: 'Україна', oblasts: [], districts: [], localities: [] },
        isNational: false,
        confidence: 0,
        source: 'message_text',
        primaryPlace: ''
      };
    }

    const t = (text || '').toLowerCase();
    const ch = (channel || '').toLowerCase();

    // 1. Перевірка на загальноукраїнські події (National events)
    const nationalPatterns = [
      /зліт.*міг-31к/i, /міг-31к.*зліт/i, /зліт.*ту-95/i, /зліт.*ту-22/i,
      /по всій.*україн/i, /для всієї.*україн/i, /вся україн/i,
      /масштабна.*тривог/i, /ракетна небезпека по всій/i,
      /загроза балістики по всій/i, /загроза крилатих ракет по всій/i
    ];
    let isNational = false;
    for (const pat of nationalPatterns) {
      if (pat.test(t)) {
        isNational = true;
        break;
      }
    }

    const oblastsFound   = new Set();
    const districtsFound = new Set();
    const localitiesFound = new Set();

    // 2. Строгі правила для спец-суб'єктів та частих міст (Київ, Севастополь, Дніпро):
    const hasKyivOblast = /київськ\p{sc=Cyrillic}*\s+обл|київщин\p{sc=Cyrillic}*/iu.test(t);
    const hasKyivCity   = /(?:^|[^\p{L}\d_])ки(?:їв|єв[аеуоі]|євом)(?:[^\p{L}\d_]|$)/iu.test(t);
    if (hasKyivOblast) oblastsFound.add('Київська область');
    if (hasKyivCity && !hasKyivOblast) {
      oblastsFound.add('Київ');
      localitiesFound.add('Київ');
    }

    const hasCrimea     = /(?:^|[^\p{L}\d_])крим\p{sc=Cyrillic}*(?:[^\p{L}\d_]|$)/iu.test(t);
    const hasSevastopol = /(?:^|[^\p{L}\d_])севастопол\p{sc=Cyrillic}*(?:[^\p{L}\d_]|$)/iu.test(t);
    if (hasCrimea) oblastsFound.add('Автономна Республіка Крим');
    if (hasSevastopol) {
      oblastsFound.add('Севастополь');
      localitiesFound.add('Севастополь');
    }

    const hasDniproOblast = /дніпропетровськ\p{sc=Cyrillic}*\s+обл|дніпропетровщин\p{sc=Cyrillic}*/iu.test(t);
    const hasDniproCity   = /(?:^|[^\p{L}\d_])дніпр[оаіеу][м]?(?:[^\p{L}\d_]|$)/iu.test(t);
    if (hasDniproOblast) oblastsFound.add('Дніпропетровська область');
    if (hasDniproCity) {
      localitiesFound.add('Дніпро');
      districtsFound.add('Дніпровський район');
      oblastsFound.add('Дніпропетровська область');
    }

    const hasVinnOblast   = /вінницьк\p{sc=Cyrillic}*\s+обл|вінниччин\p{sc=Cyrillic}*/iu.test(t);
    const hasVinnDistrict = /вінницьк\p{sc=Cyrillic}*\s+район/iu.test(t);
    const hasVinnCity     = /(?:^|[^\p{L}\d_])вінниц[яіеюь][ю]?(?:[^\p{L}\d_]|$)/iu.test(t);
    if (hasVinnOblast)   oblastsFound.add('Вінницька область');
    if (hasVinnDistrict) {
      districtsFound.add('Вінницький район');
      oblastsFound.add('Вінницька область');
    }
    if (hasVinnCity && !hasVinnOblast && !hasVinnDistrict) {
      localitiesFound.add('Вінниця');
      districtsFound.add('Вінницький район');
      oblastsFound.add('Вінницька область');
    }

    const hasPoltavaOblast   = /полтавськ\p{sc=Cyrillic}*\s+обл|полтавщин\p{sc=Cyrillic}*/iu.test(t);
    const hasPoltavaDistrict = /полтавськ\p{sc=Cyrillic}*\s+район/iu.test(t);
    const hasPoltavaCity     = /(?:^|[^\p{L}\d_])полтав[аіеуо][ю]?(?:[^\p{L}\d_]|$)/iu.test(t);
    if (hasPoltavaOblast)   oblastsFound.add('Полтавська область');
    if (hasPoltavaDistrict) {
      districtsFound.add('Полтавський район');
      oblastsFound.add('Полтавська область');
    }
    if (hasPoltavaCity && !hasPoltavaOblast && !hasPoltavaDistrict) {
      localitiesFound.add('Полтава');
      districtsFound.add('Полтавський район');
      oblastsFound.add('Полтавська область');
    }

    const hasMykOblast   = /миколаївськ\p{sc=Cyrillic}*\s+обл|миколаївщин\p{sc=Cyrillic}*/iu.test(t);
    const hasMykDistrict = /миколаївськ\p{sc=Cyrillic}*\s+район/iu.test(t);
    const hasMykCity     = /(?:^|[^\p{L}\d_])микола[єїв][а-я]*(?:[^\p{L}\d_]|$)/iu.test(t);
    if (hasMykOblast)   oblastsFound.add('Миколаївська область');
    if (hasMykDistrict) {
      districtsFound.add('Миколаївський район');
      oblastsFound.add('Миколаївська область');
    }
    if (hasMykCity && !hasMykOblast && !hasMykDistrict) {
      localitiesFound.add('Миколаїв');
      districtsFound.add('Миколаївський район');
      oblastsFound.add('Миколаївська область');
    }

    // 3. Сканування населених пунктів за словником
    for (const city of this.allCities) {
      if (localitiesFound.has(city)) continue;
      const stem = city.replace(/район|область/gi, '').trim();
      if (stem.length < 3) continue;
      const baseStem = stem.length > 5 ? stem.slice(0, -1) : stem;
      const hasSzkSuffix = /[сцз]ьк$/i.test(stem);
      let regex;
      if (hasSzkSuffix) {
        regex = new RegExp(`(?:^|[^\\p{L}\\d_])${baseStem}\\p{sc=Cyrillic}*(?:[^\\p{L}\\d_]|$)`, 'iu');
      } else {
        regex = new RegExp(`(?:^|[^\\p{L}\\d_])${baseStem}(?!\\p{sc=Cyrillic}*(?:ьк|[сцз]ьк|обл|район))\\p{sc=Cyrillic}*(?:[^\\p{L}\\d_]|$)`, 'iu');
      }
      if (regex.test(t)) {
        localitiesFound.add(city);
        const dist = this.cityDistrictMap[city];
        if (dist) districtsFound.add(dist);
        const obl = this.cityOblastMap[city];
        if (obl) oblastsFound.add(obl);
      }
    }

    // 4. Сканування районів за словником
    for (const dist of this.allDistricts) {
      if (districtsFound.has(dist)) continue;
      const stem = dist.replace(/район/gi, '').trim();
      const baseStem = stem.length > 5 ? stem.slice(0, -2) : stem;
      const regex = new RegExp(`(?:^|[^\\p{L}\\d_])${baseStem}\\p{sc=Cyrillic}*\\s+(?:район|р-н)`, 'iu');
      if (regex.test(t)) {
        districtsFound.add(dist);
        const obl = this.districtOblastMap[dist];
        if (obl) oblastsFound.add(obl);
      }
    }

    // 5. Сканування інших областей
    const oblastSuffixPatterns = [
      { name: 'Волинська область', re: /волинськ\p{sc=Cyrillic}*\s+обл|волинь/iu },
      { name: 'Донецька область', re: /донецьк\p{sc=Cyrillic}*\s+обл|донеччин/iu },
      { name: 'Житомирська область', re: /житомирськ\p{sc=Cyrillic}*\s+обл|житомирщин/iu },
      { name: 'Закарпатська область', re: /закарпатськ\p{sc=Cyrillic}*\s+обл|закарпатт/iu },
      { name: 'Запорізька область', re: /запорізьк\p{sc=Cyrillic}*\s+обл|запоріжж/iu },
      { name: 'Івано-Франківська область', re: /івано-франківськ\p{sc=Cyrillic}*\s+обл|прикарпатт/iu },
      { name: 'Кіровоградська область', re: /кіровоградськ\p{sc=Cyrillic}*\s+обл|кропивниччин|кіровоградщин/iu },
      { name: 'Луганська область', re: /луганськ\p{sc=Cyrillic}*\s+обл|луганщин/iu },
      { name: 'Львівська область', re: /львівськ\p{sc=Cyrillic}*\s+обл|львівщин/iu },
      { name: 'Одеська область', re: /одеськ\p{sc=Cyrillic}*\s+обл|одещин/iu },
      { name: 'Рівненська область', re: /рівненськ\p{sc=Cyrillic}*\s+обл|рівненщин/iu },
      { name: 'Сумська область', re: /сумськ\p{sc=Cyrillic}*\s+обл|сумщин/iu },
      { name: 'Тернопільська область', re: /тернопільськ\p{sc=Cyrillic}*\s+обл|тернопільщин/iu },
      { name: 'Харківська область', re: /харківськ\p{sc=Cyrillic}*\s+обл|харківщин/iu },
      { name: 'Херсонська область', re: /херсонськ\p{sc=Cyrillic}*\s+обл|херсонщин/iu },
      { name: 'Хмельницька область', re: /хмельницьк\p{sc=Cyrillic}*\s+обл|хмельниччин/iu },
      { name: 'Черкаська область', re: /черкаськ\p{sc=Cyrillic}*\s+обл|черкащин/iu },
      { name: 'Чернівецька область', re: /чернівецьк\p{sc=Cyrillic}*\s+обл|буковин/iu },
      { name: 'Чернігівська область', re: /чернігівськ\p{sc=Cyrillic}*\s+обл|чернігівщин/iu }
    ];

    for (const item of oblastSuffixPatterns) {
      if (!oblastsFound.has(item.name) && item.re.test(t)) {
        oblastsFound.add(item.name);
      }
    }

    const totalFound = oblastsFound.size + districtsFound.size + localitiesFound.size;
    const confidence = isNational ? 0.99 : (totalFound > 0 ? Math.min(0.95, 0.7 + totalFound * 0.1) : 0);

    const localitiesArr = Array.from(localitiesFound);
    const districtsArr  = Array.from(districtsFound);
    const oblastsArr    = Array.from(oblastsFound);

    let primaryPlace = '';
    if (localitiesArr.length) primaryPlace = localitiesArr[0];
    else if (districtsArr.length) primaryPlace = districtsArr[0];
    else if (oblastsArr.length) primaryPlace = oblastsArr[0];
    else if (isNational) primaryPlace = 'Вся Україна';

    return {
      territories: {
        country: 'Україна',
        oblasts: oblastsArr,
        districts: districtsArr,
        localities: localitiesArr
      },
      isNational,
      confidence,
      source: 'message_text',
      primaryPlace
    };
  },

  isMatchingTerritory(parsed, selectedRegion, selectedDistrict, showOblastWide = true) {
    if (!selectedRegion || selectedRegion === 'all') {
      return true;
    }
    if (parsed.isNational) {
      return true;
    }

    const { oblasts, districts, localities } = parsed.territories || { oblasts: [], districts: [], localities: [] };
    const hasAnyTerritory = oblasts.length > 0 || districts.length > 0 || localities.length > 0;
    if (!hasAnyTerritory) {
      // Якщо територія взагалі не розпізнана, НЕ показуємо в локальному фільтрі конкретного регіону/району
      return false;
    }

    // Режим 1: Вибрано конкретний район
    if (selectedDistrict && selectedDistrict !== 'all') {
      // Прямий збіг району
      if (districts.includes(selectedDistrict)) {
        return true;
      }
      // Збіг населеного пункту всередині цього району
      for (const loc of localities) {
        if (this.cityDistrictMap[loc] === selectedDistrict) {
          return true;
        }
      }
      // Загальне повідомлення всієї області (якщо дозволено опцією)
      const districtOblast = this.districtOblastMap[selectedDistrict] || selectedRegion;
      if (showOblastWide && oblasts.includes(districtOblast)) {
        // Якщо в повідомленні явно вказано ІНШИЙ район цієї ж області — це локальна подія іншого району, не показуємо
        const conflictingDistrict = districts.some(d => d !== selectedDistrict && this.districtOblastMap[d] === districtOblast);
        if (!conflictingDistrict) {
          return true;
        }
      }
      return false;
    }

    // Режим 2: Вибрано всю область (district === 'all')
    if (selectedRegion && selectedRegion !== 'all') {
      if (oblasts.includes(selectedRegion)) {
        return true;
      }
      for (const dist of districts) {
        if (this.districtOblastMap[dist] === selectedRegion) return true;
      }
      for (const loc of localities) {
        if (this.cityOblastMap[loc] === selectedRegion) return true;
      }
      return false;
    }

    return true;
  },

  isNotificationRelevantForUser(notif) {
    if (!notif) return true;

    // Якщо користувач увімкнув лише "Обрані території" (зірочки) і список не порожній
    if (FollowManager && FollowManager.followedSet && FollowManager.followedSet.size > 0) {
      const place = notif.territory || '';
      if (!FollowManager.matchesFollowed(place)) {
        // Перевіряємо текст
        const text = `${notif.title || ''} ${notif.message || ''}`.toLowerCase();
        let matchesFollowed = false;
        for (const f of FollowManager.followedSet) {
          if (text.includes(f.toLowerCase())) { matchesFollowed = true; break; }
        }
        if (!matchesFollowed) return false;
      }
    }

    // Перевірка за вибраною областю та районом
    const selectedRegion = State.selectedRegion || 'all';
    const selectedDistrict = State.selectedDistrict || 'all';
    const showOblastWide = State.showEntireRegionWithDistrict !== false;

    if (selectedRegion === 'all' && selectedDistrict === 'all') {
      return true;
    }

    let parsed = notif.parsedTerritory;
    if (!parsed) {
      const combinedText = `${notif.title || ''} ${notif.message || ''} ${notif.territory || ''}`;
      parsed = this.resolveMessageTerritory(combinedText, notif.source || '');
      notif.parsedTerritory = parsed;
    }

    return this.isMatchingTerritory(parsed, selectedRegion, selectedDistrict, showOblastWide);
  },

  search(query) {
    if (!query || !query.trim()) return [];
    const q = query.trim().toLowerCase();

    const matches = this.flat.filter(item => {
      const n = (item.name || '').toLowerCase();
      const d = (item.districtName || '').toLowerCase();
      const r = (item.regionName || '').toLowerCase();
      return n.includes(q) || d.includes(q) || r.includes(q);
    });

    matches.sort((a, b) => {
      const aN = a.name.toLowerCase();
      const bN = b.name.toLowerCase();

      if (q === 'київ' || q.startsWith('ки')) {
        if (aN === 'київ' && bN !== 'київ') return -1;
        if (bN === 'київ' && aN !== 'київ') return 1;
      }
      if (q.startsWith('він')) {
        if (aN.includes('вінниц') && !bN.includes('вінниц')) return -1;
        if (bN.includes('вінниц') && !aN.includes('вінниц')) return 1;
      }

      return a.name.localeCompare(b.name, 'uk');
    });

    return matches.slice(0, 15);
  },

  resolveStatus(territory) {
    if (!territory) return { active: false, level: null };
    const norm = normalizeName(territory.name);

    if (norm === 'київ') {
      const a = State.specialCities.get('київ');
      return a ? { active: true, level: a.level } : { active: false, level: null };
    }
    if (norm === 'севастополь') {
      const a = State.specialCities.get('севастополь');
      return a ? { active: true, level: a.level } : { active: false, level: null };
    }
    if (territory.type === 'district') {
      if (State.raions.has(norm)) {
        const a = State.raions.get(norm);
        return { active: true, level: a.level };
      }
      if (territory.regionName) {
        const rNorm = normalizeName(territory.regionName);
        if (State.oblasts.has(rNorm)) {
          const a = State.oblasts.get(rNorm);
          return { active: true, level: a.level };
        }
      }
    }
    if (territory.type === 'region' && State.oblasts.has(norm)) {
      const a = State.oblasts.get(norm);
      return { active: true, level: a.level };
    }
    if (territory.type === 'city') {
      const dNorm = normalizeName(territory.districtName);
      if (dNorm && State.raions.has(dNorm)) {
        const a = State.raions.get(dNorm);
        return { active: true, level: a.level };
      }
      const rNorm = normalizeName(territory.regionName);
      if (rNorm === 'київ' && State.specialCities.has('київ')) {
        const a = State.specialCities.get('київ');
        return { active: true, level: a.level };
      }
      if (rNorm === 'севастополь' && State.specialCities.has('севастополь')) {
        const a = State.specialCities.get('севастополь');
        return { active: true, level: a.level };
      }
      if (rNorm && State.oblasts.has(rNorm)) {
        const a = State.oblasts.get(rNorm);
        return { active: true, level: a.level };
      }
    }

    return { active: false, level: null };
  }
};

/* ============================================================
   11.5. ЦЕНТРАЛІЗОВАНИЙ ГЛОБАЛЬНИЙ ФІЛЬТР ТЕРИТОРІЙ
   Єдина точка фільтрації для ВСІХ типів сповіщень.
   Використовується NotificationDispatcher.dispatch() та всіма
   компонентами, що генерують сповіщення.
============================================================ */
const GlobalTerritoryFilter = {

  /**
   * Перевіряє, чи повинна подія показуватися користувачу згідно
   * з вибраними ним територіями (State.selectedRegion / selectedDistrict).
   *
   * @param {object} event — нормалізована структура події:
   *   type            : 'OFFICIAL_ALERT' | 'THREAT' | 'LAUNCH' | 'INFORMATION' | 'AI_ANALYSIS'
   *   oblastKey       : точний ключ з API (для офіційних тривог)
   *   oblastName      : назва області/міста з API
   *   apiRegion       : регіон з API (для цілей)
   *   apiDistrict     : район з API (для цілей)
   *   apiLocality     : населений пункт з API (для цілей)
   *   areaOnly        : true → координати є центроїдом, не використовуємо для прив'язки
   *   text            : повний текст повідомлення для NLP
   *   title           : заголовок
   *   source          : назва каналу / джерела
   *   place           : підказка-рядок (запасна)
   *   parsedTerritory : кешований результат TerritoriesManager.resolveMessageTerritory
   * @returns {boolean}
   */
  passes(event) {
    if (!event) return true;

    const sel  = State.selectedRegion   || 'all';
    const dist = State.selectedDistrict || 'all';

    // Якщо користувач не вибрав конкретну територію — показуємо все
    if (sel === 'all' && dist === 'all') return true;

    // ── Офіційні тривоги (OFFICIAL_ALERT) ─────────────────────────────────────
    // Використовуємо точне зіставлення ключа/назви з API, без NLP.
    if (event.type === 'OFFICIAL_ALERT') {
      if (sel === 'all') return true;
      const normSel  = normalizeName(sel);
      const normKey  = normalizeName(event.oblastKey  || '');
      const normName = normalizeName(event.oblastName || '');
      const normSelStripped = normSel.replace(/\s+область$/, '').trim();

      const matchesOblast = normKey  === normSel
          || normName === normSel
          || normKey  === normSelStripped
          || normName === normSelStripped
          || (event.apiRegion && (normalizeName(event.apiRegion) === normSel || normalizeName(event.apiRegion) === normSelStripped));

      if (!matchesOblast) return false;

      // Якщо вибрано конкретний район
      if (dist && dist !== 'all') {
        const normDist = normalizeName(dist);
        const normDistStripped = normDist.replace(/\s+район$/, '').trim();
        const alertDist = event.apiDistrict ? normalizeName(event.apiDistrict) : '';

        // Якщо в тривозі явно вказано район в окремому полі:
        if (alertDist) {
          return alertDist === normDist || alertDist === normDistStripped;
        }

        // Перевіряємо, чи в назві/ключі тривоги зазначено конкретний район:
        const isDistrictAlert = normName.includes('район') || normKey.includes('район') || normKey.includes('::');
        if (isDistrictAlert) {
          return normName === normDist || normKey === normDist || normName.includes(normDistStripped) || normKey.includes(normDistStripped);
        }

        // Тривога на всю область: показуємо лише якщо користувач дозволив включати всю область
        return State.showEntireRegionWithDistrict !== false;
      }

      return true;
    }

    // ── Реальні цілі та запуски (THREAT / LAUNCH) ──────────────────────────────
    // Використовуємо явні поля API: region, district, locality.
    // Якщо areaOnly: true — координати є центроїдом, НЕ використовуємо їх як точне місце.
    if (event.type === 'THREAT' || event.type === 'LAUNCH') {
      const placeStr = [
        event.apiLocality,
        event.apiDistrict,
        event.apiRegion
      ].filter(Boolean).join(' ');

      if (!placeStr && !event.text) {
        // Немає жодних достовірних даних про місце — не показуємо в конкретному регіоні
        return false;
      }

      let parsed = event.parsedTerritory;
      if (!parsed && typeof TerritoriesManager !== 'undefined') {
        const combined = `${placeStr} ${event.text || ''}`.trim();
        parsed = TerritoriesManager.resolveMessageTerritory(combined, event.source || '');
        event.parsedTerritory = parsed;
      }
      if (!parsed) return false;

      return TerritoriesManager.isMatchingTerritory(
        parsed, sel, dist, State.showEntireRegionWithDistrict !== false
      );
    }

    // ── INFORMATION / AI_ANALYSIS / решта — NLP за текстом ─────────────────────
    let parsed = event.parsedTerritory;
    if (!parsed && typeof TerritoriesManager !== 'undefined') {
      const combined = `${event.title || ''} ${event.text || event.body || ''} ${event.place || ''}`.trim();
      parsed = TerritoriesManager.resolveMessageTerritory(combined, event.source || '');
      event.parsedTerritory = parsed;
    }
    if (!parsed) return false;

    return TerritoriesManager.isMatchingTerritory(
      parsed, sel, dist, State.showEntireRegionWithDistrict !== false
    );
  },

  /**
   * Викликати при зміні вибраної території.
   * Реактивно перебудовує всі залежні UI-компоненти без reload.
   */
  onTerritoryChanged() {
    // Перебудова вкладки «Сповіщення»
    if (typeof TelegramFeedService !== 'undefined') {
      TelegramFeedService.syncDistrictDropdown();
      TelegramFeedService.render();
    }
    // Перебудова вкладки «Тривоги»
    if (typeof AlertsService !== 'undefined') {
      AlertsService.updateCounters();
      if (NavigationController?.currentTab === 'alerts') {
        AlertsService.render();
      }
    }
    // Оновлення слідкування та лічильників
    if (typeof FollowManager !== 'undefined') FollowManager.renderFollowedList();
    if (typeof UIController !== 'undefined') UIController.updateCounters?.();
    // ШІ вкладка
    if (typeof AIService !== 'undefined') AIService?.render?.();
  }
};

/* ============================================================
   12. ALERTS SERVICE — ОФІЦІЙНІ ТРИВОГИ (NEPTUN API)
   Повноцінний вертикальний скрол, реальний час since, фільтри за регіоном
============================================================ */
function getAlertTimestamp(alert) {
  if (!alert) return 0;
  const s = alert.started_at || alert.since || alert.startTime;
  if (!s) return 0;
  const t = new Date(s).getTime();
  return isNaN(t) ? 0 : t;
}

const AlertsService = {
  activeAlerts:     new Map(), // key -> alert object
  alertsHistory:    [],        // list of cleared alerts
  activeFilter:     'all',      // 'all' | 'red' | 'yellow' | 'followed' | 'history'
  searchQuery:      '',
  userScrolledDown: false,
  newAlertsCount:   0,

  init() {
    this.loadStoredHistory();

    // Прив'язка кнопок фільтрів
    document.querySelectorAll('.alerts-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const filter = btn.getAttribute('data-filter') || 'all';
        this.setFilter(filter);
      });
    });

    // Швидкий пошук тривог за назвою території
    const searchInput = document.getElementById('alerts-input-search');
    const clearBtn    = document.getElementById('alerts-btn-clear-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim().toLowerCase();
        clearBtn?.classList.toggle('hidden', !this.searchQuery);
        this.render();
      });
    }
    clearBtn?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      this.searchQuery = '';
      clearBtn.classList.add('hidden');
      this.render();
    });

    // Чіп на карті: клік перемикає на вкладку "Тривоги"
    document.getElementById('map-alerts-chip')?.addEventListener('click', () => {
      NavigationController.switchTab('alerts');
    });

    // Лічильник тривог у шапці: клік перемикає на вкладку "Тривоги"
    document.getElementById('stat-active-alerts')?.parentElement?.addEventListener('click', () => {
      NavigationController.switchTab('alerts');
    });

    // Скрол та плаваюча кнопка "Нова тривога" (не стрибати вгору, якщо користувач читає старі)
    const container = document.getElementById('alerts-list-container');
    const newAlertBtn = document.getElementById('btn-alerts-new');
    if (container) {
      container.addEventListener('scroll', () => {
        this.userScrolledDown = container.scrollTop > 60;
        if (!this.userScrolledDown && this.newAlertsCount > 0) {
          this.newAlertsCount = 0;
          newAlertBtn?.classList.add('hidden');
        }
      }, { passive: true });
    }

    if (newAlertBtn) {
      newAlertBtn.addEventListener('click', () => {
        container?.scrollTo({ top: 0, behavior: 'smooth' });
        this.newAlertsCount = 0;
        newAlertBtn.classList.add('hidden');
        this.render();
      });
    }

    // Оновлення тривалості тривог у реальному часі кожні 30 секунд
    setInterval(() => {
      if (NavigationController?.currentTab === 'alerts' && this.activeAlerts.size > 0) {
        this.render();
      }
    }, 30000);
  },

  loadStoredHistory() {
    try {
      const saved = localStorage.getItem('radar_alerts_history');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          this.alertsHistory = parsed;
        }
      }
    } catch (e) {}
  },

  saveStoredHistory() {
    try {
      localStorage.setItem('radar_alerts_history', JSON.stringify(this.alertsHistory.slice(0, 150)));
    } catch (e) {}
  },

  setFilter(filter) {
    this.activeFilter = filter;
    document.querySelectorAll('.alerts-filter-btn').forEach(btn => {
      const f = btn.getAttribute('data-filter');
      if (f === filter) {
        btn.classList.add('active', 'bg-red-600', 'text-white', 'font-semibold');
        btn.classList.remove('text-gray-300');
      } else {
        btn.classList.remove('active', 'bg-red-600', 'text-white', 'font-semibold');
        btn.classList.add('text-gray-300');
      }
    });
    this.render();
  },

  // Обробка оновлень офіційних тривог від NEPTUN (WebSocket alerts або REST alerts)
  handleRealtimeAlerts(rawAlerts) {
    if (!rawAlerts) return;
    const nowIso = new Date().toISOString();

    const incomingUnits = [];
    if (Array.isArray(rawAlerts.data)) {
      for (const item of rawAlerts.data) {
        if (!item) continue;
        const startedAt = item.started_at || item.since || item.start_time || item.startTime || null;
        incomingUnits.push({
          key:        item.key || (item.name || item.region || item.district || '').toLowerCase(),
          name:       item.name || item.district || item.region || '',
          oblast:     item.oblast || item.region || '',
          started_at: startedAt,
          since:      startedAt,
          level:      (item.level || item.alertLevel || 'red').toLowerCase(),
          reasons:    Array.isArray(item.reasons) ? item.reasons : (item.reason ? [item.reason] : [])
        });
      }
    } else {
      if (Array.isArray(rawAlerts.oblasts)) {
        for (const o of rawAlerts.oblasts) {
          if (!o) continue;
          const startedAt = o.started_at || o.since || o.start_time || o.startTime || null;
          incomingUnits.push({
            key:        o.key || o.name.toLowerCase(),
            name:       o.name,
            oblast:     o.oblast || o.name,
            started_at: startedAt,
            since:      startedAt,
            level:      (o.level || 'red').toLowerCase(),
            reasons:    o.reasons || []
          });
        }
      }
      if (Array.isArray(rawAlerts.raions)) {
        for (const r of rawAlerts.raions) {
          if (!r) continue;
          const startedAt = r.started_at || r.since || r.start_time || r.startTime || null;
          incomingUnits.push({
            key:        r.key || `${r.name.toLowerCase()}::${(r.oblast || '').toLowerCase()}`,
            name:       r.name,
            oblast:     r.oblast || '',
            started_at: startedAt,
            since:      startedAt,
            level:      (r.level || 'red').toLowerCase(),
            reasons:    Array.isArray(r.reasons) ? r.reasons : (r.reason ? [r.reason] : [])
          });
        }
      }
    }

    const currentKeys = new Set();
    let hasBrandNewAlert = false;

    for (const unit of incomingUnits) {
      if (!unit.name) continue;
      const key = unit.key || `${unit.name.toLowerCase()}::${unit.oblast.toLowerCase()}`;
      currentKeys.add(key);

      const existing = this.activeAlerts.get(key);
      if (existing) {
        existing.level   = unit.level;
        existing.reasons = unit.reasons;
        existing.oblast  = unit.oblast;
        existing.name    = unit.name;
        if (unit.started_at && !existing.started_at) {
          existing.started_at = unit.started_at;
          existing.since      = unit.started_at;
        }
      } else {
        hasBrandNewAlert = true;
        this.activeAlerts.set(key, {
          key,
          name:       unit.name,
          oblast:     unit.oblast,
          started_at: unit.started_at,
          since:      unit.started_at,
          level:      unit.level,
          reasons:    unit.reasons,
          status:     'active'
        });
      }
    }

    // Визначаємо відбої: тривоги, яких більше немає в поточному стані
    for (const [key, alert] of this.activeAlerts.entries()) {
      if (!currentKeys.has(key)) {
        alert.status = 'cleared';
        alert.finishedAt = nowIso;
        const exists = this.alertsHistory.some(h => h.key === key && h.started_at === alert.started_at);
        if (!exists) {
          this.alertsHistory.unshift({ ...alert });
          if (this.alertsHistory.length > 200) this.alertsHistory.pop();
        }
        this.activeAlerts.delete(key);
      }
    }

    this.saveStoredHistory();
    this.updateCounters();

    if (NavigationController.currentTab === 'alerts') {
      if (this.userScrolledDown && hasBrandNewAlert) {
        this.newAlertsCount++;
        const btn = document.getElementById('btn-alerts-new');
        const countEl = document.getElementById('btn-alerts-new-count');
        if (countEl) countEl.textContent = this.newAlertsCount;
        btn?.classList.remove('hidden');
      } else {
        this.render();
      }
    }
  },

  updateCounters() {
    const list = Array.from(this.activeAlerts.values());
    const total = list.length;
    let redCount = 0;
    let yellowCount = 0;
    let followedCount = 0;

    for (const a of list) {
      if (a.level === 'yellow') yellowCount++;
      else redCount++;
      if (FollowManager.matchesFollowed(a.name) || (a.oblast && FollowManager.matchesFollowed(a.oblast))) {
        followedCount++;
      }
    }

    const setEl = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setEl('alerts-stat-active', total);
    setEl('alerts-stat-red', redCount);
    setEl('alerts-stat-yellow', yellowCount);
    setEl('alerts-stat-cleared', this.alertsHistory.length);

    setEl('alerts-count-all', total);
    setEl('alerts-count-red', redCount);
    setEl('alerts-count-yellow', yellowCount);
    setEl('alerts-count-followed', followedCount);
    setEl('alerts-count-history', this.alertsHistory.length);

    // Оновлюємо бейджі у верхньому меню
    const navBadge = document.getElementById('nav-alerts-badge');
    const mNavBadge = document.getElementById('m-nav-alerts-badge');
    if (navBadge) {
      navBadge.textContent = total;
      navBadge.classList.toggle('hidden', total === 0);
    }
    if (mNavBadge) {
      mNavBadge.textContent = total;
      mNavBadge.classList.toggle('hidden', total === 0);
    }

    // Оновлюємо чіп на карті
    const chipText = document.getElementById('map-alerts-chip-text');
    if (chipText) {
      chipText.textContent = total > 0 ? `Тривог: ${total}` : 'Спокійно';
    }
  },

  render() {
    const container = document.getElementById('alerts-list-container');
    const emptyEl   = document.getElementById('alerts-empty-placeholder');
    if (!container) return;

    let items = [];

    if (this.activeFilter === 'history') {
      items = [...this.alertsHistory];
    } else {
      items = Array.from(this.activeAlerts.values());

      if (this.activeFilter === 'red') {
        items = items.filter(a => a.level !== 'yellow');
      } else if (this.activeFilter === 'yellow') {
        items = items.filter(a => a.level === 'yellow');
      } else if (this.activeFilter === 'followed') {
        items = items.filter(a => FollowManager.matchesFollowed(a.name) || (a.oblast && FollowManager.matchesFollowed(a.oblast)));
      }
    }

    // Застосовуємо централізований територіальний фільтр до списку тривог
    if (typeof GlobalTerritoryFilter !== 'undefined') {
      items = items.filter(a => GlobalTerritoryFilter.passes({
        type: 'OFFICIAL_ALERT',
        oblastKey: a.key || a.oblast || a.name,
        oblastName: a.name || a.oblast,
        apiRegion: a.oblast || a.name,
        apiDistrict: a.district || null
      }));
    }

    if (this.searchQuery) {
      const q = this.searchQuery;
      items = items.filter(a => 
        (a.name && a.name.toLowerCase().includes(q)) ||
        (a.oblast && a.oblast.toLowerCase().includes(q)) ||
        (Array.isArray(a.reasons) && a.reasons.some(r => r.toLowerCase().includes(q)))
      );
    }

    // СОРТУВАННЯ ВКЛАДКИ «ТРИВОГИ»:
    // Найновіші тривоги повинні завжди знаходитися на початку списку.
    // Сортувати строго за реальним часом початку тривоги (started_at / since).
    // Позиція завершених тривог також визначається часом початку started_at.
    items.sort((a, b) => {
      const timeA = getAlertTimestamp(a);
      const timeB = getAlertTimestamp(b);
      if (timeB !== timeA) return timeB - timeA; // newest started_at first
      return (a.name || '').localeCompare(b.name || ''); // deterministic fallback for same start time
    });

    if (items.length === 0) {
      container.innerHTML = '';
      if (emptyEl) {
        emptyEl.classList.remove('hidden');
        container.appendChild(emptyEl);
      }
      return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');

    const html = items.map(alert => {
      const isHistory = this.activeFilter === 'history' || alert.status === 'cleared';
      const isYellow  = alert.level === 'yellow';

      const badgeColor = isHistory
        ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
        : (isYellow ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' : 'bg-red-500/20 text-red-400 border-red-500/30');

      const borderColor = isHistory
        ? 'border-emerald-500/25 hover:border-emerald-500/50'
        : (isYellow ? 'border-yellow-500/30 hover:border-yellow-500/60' : 'border-red-500/30 hover:border-red-500/60');

      const iconSvg = isHistory
        ? `<svg class="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`
        : (isYellow
            ? `<svg class="w-4 h-4 text-yellow-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
            : `<svg class="w-4 h-4 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`);

      const levelTitle = isHistory
        ? 'ВІДБІЙ ТРИВОГИ'
        : (isYellow ? 'ЖОВТИЙ РІВЕНЬ (ПІДВИЩЕНА НЕБЕЗПЕКА)' : 'ПОВІТРЯНА ТРИВОГА');

      const formattedTime = formatAlertTimestamp(alert.since, alert.finishedAt);
      const durationStr   = formatAlertDuration(alert.since, alert.finishedAt);

      const reasonsHtml = Array.isArray(alert.reasons) && alert.reasons.length > 0
        ? `<div class="text-[11px] text-gray-300 mt-1 flex flex-wrap gap-1">
             ${alert.reasons.map(r => `<span class="px-1.5 py-0.2 rounded bg-white/5 border border-white/10 ${isYellow ? 'text-yellow-300' : 'text-red-300'}">${escapeHtml(r)}</span>`).join('')}
           </div>`
        : '';

      const targetPlace = escapeHtml(alert.name);

      return `
        <article class="p-3 sm:p-4 rounded-xl border ${borderColor} bg-black/40 hover:bg-black/60 transition-all flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-lg">
          <div class="flex items-start gap-3 flex-1 min-w-0">
            <div class="w-9 h-9 rounded-lg flex items-center justify-center font-bold text-base ${badgeColor} border flex-shrink-0 mt-0.5">
              ${iconSvg}
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <h3 class="text-sm sm:text-base font-bold text-white tracking-wide truncate">${targetPlace}</h3>
                ${alert.oblast && alert.oblast !== alert.name ? `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-white/10 text-gray-300">${escapeHtml(alert.oblast)}</span>` : ''}
                <span class="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase ${badgeColor} border font-bold">${levelTitle}</span>
              </div>

              ${reasonsHtml}

              <div class="text-[11px] font-mono text-gray-400 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span><span class="text-gray-400">Початок:</span> <b class="text-gray-200">${formattedTime}</b></span>
                ${durationStr ? `<span class="${isYellow ? 'text-yellow-400' : (isHistory ? 'text-gray-400' : 'text-amber-400')}"><span class="text-gray-400">${isHistory ? 'Тривала:' : 'Триває:'}</span> <b>${durationStr}</b></span>` : ''}
                <span class="text-gray-500 text-[10px]">Джерело: NEPTUN</span>
              </div>
            </div>
          </div>

          <div class="flex-shrink-0 self-end sm:self-center flex items-center gap-2">
            <button class="px-3 py-1.5 rounded-lg text-xs font-mono font-semibold bg-sky-600/20 hover:bg-sky-600 text-sky-200 hover:text-white border border-sky-500/30 transition-all flex items-center gap-1.5" onclick="NavigationController.switchTab('map'); MapService.flyToRegion('${targetPlace}'); MapService.selectAndShowDistrict('${targetPlace}', true);">
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line></svg>
              <span>На карті</span>
            </button>
          </div>
        </article>`;
    }).join('');

    const prevScroll = container.scrollTop;
    container.innerHTML = html;
    if (prevScroll > 0) {
      container.scrollTop = prevScroll;
    }
  },

  // Зворотна сумісність
  addEvent(item) {
    if (item && item.title) {
      if (item.type === 'clear') {
        this.alertsHistory.unshift({
          key:        normalizeName(item.title),
          name:       item.title,
          oblast:     '',
          since:      new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          level:      'clear',
          reasons:    [],
          status:     'cleared'
        });
      }
    }
    this.render();
  }
};

// Аліас для зворотної сумісності
const FeedService = AlertsService;

/* ============================================================
   13. UI CONTROLLER
============================================================ */
const UIController = {
  currentCardTerritory: null,
  currentCardDistrict:  null,
  currentCardRegion:    null,

  init() {
    this.bindButtons();
    this.bindSearch();
    this.bindShortcuts();
    this.bindSettingsModal();
    this.bindTreeModal();
    this.startClock();

    // 1. Старт WebSocket як основного джерела
    RealtimeClient.connect();

    // 2. Миттєве завантаження початкового стану (щоб карта не чекала рукостискання WS)
    PollingService.poll();

    // 3. Старт фонового опитування повідомлень Telegram
    MessagesService.start();
  },

  updateSelectedTerritoryCard(name, districtName, regionName, isCity = false) {
    const card = document.getElementById('selected-territory-card');
    if (!card) return;

    this.currentCardTerritory = name;
    this.currentCardDistrict  = districtName || name;
    this.currentCardRegion    = regionName || name;

    card.classList.remove('hidden');

    const nameEl      = document.getElementById('card-territory-name');
    const parentEl    = document.getElementById('card-territory-parent');
    const typeBadgeEl = document.getElementById('card-territory-type-badge');
    const iconEl      = document.getElementById('card-territory-icon');
    const starBtn     = document.getElementById('card-btn-star');
    const starText    = document.getElementById('card-star-text');

    if (nameEl)      nameEl.textContent = name;
    if (parentEl)    parentEl.textContent = districtName ? `${districtName}, ${regionName}` : regionName;
    if (typeBadgeEl) typeBadgeEl.textContent = isCity ? 'МІСТО' : 'РАЙОН';
    if (iconEl) {
      iconEl.innerHTML = isCity
        ? '<svg class="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v8h4"/><path d="M18 9h2a2 2 0 0 1 2 2v11h-4"/></svg>'
        : '<svg class="w-4 h-4 text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/><circle cx="12" cy="10" r="3"/></svg>';
    }

    const isStarred = FollowManager.isFollowed(name);
    if (starText) starText.textContent = isStarred ? 'Відстежується' : 'Слідкувати';
    if (starBtn) {
      starBtn.className = isStarred
        ? 'px-2 py-1 rounded-lg border border-amber-400 bg-amber-500/30 text-amber-200 font-mono text-[10px] font-bold flex items-center gap-1 transition-all'
        : 'px-2 py-1 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 text-gray-300 font-mono text-[10px] font-medium flex items-center gap-1 transition-all';
    }

    // Статуси
    const statusCityEl = document.getElementById('card-status-city');
    const statusDistEl = document.getElementById('card-status-district');
    const statusRegEl  = document.getElementById('card-status-region');

    const normName = normalizeName(name);
    const normDist = normalizeName(districtName || name);
    const normReg  = normalizeName(regionName || name);

    const cityAlert = (normName === 'київ' || normName === 'севастополь')
      ? State.specialCities.get(normName)
      : (State.raions.get(normName) || null);

    const distAlert = State.raions.get(normDist) || null;

    const regAlert = (normReg === 'київ' || normReg === 'севастополь')
      ? State.specialCities.get(normReg)
      : (State.oblasts.get(normReg) || null);

    const formatStatus = (a) => {
      if (!a) return '<span class="font-bold text-emerald-400">СПОКІЙНО (Тривога: НІ)</span>';
      const c = getAlertColor(a.level);
      return `<span class="font-bold text-white px-1.5 py-0.5 rounded text-[10px]" style="background-color: ${c}">ТРИВОГА [${(a.level || 'RED').toUpperCase()}]</span>`;
    };

    if (statusCityEl) statusCityEl.innerHTML = formatStatus(cityAlert || distAlert || regAlert);
    if (statusDistEl) statusDistEl.innerHTML = formatStatus(distAlert || regAlert);
    if (statusRegEl)  statusRegEl.innerHTML  = formatStatus(regAlert);
  },

  updateCounters() {
    const activeAlerts = State.specialCities.size + State.oblasts.size + State.raions.size;
    const activeThreats = State.threats.size;

    const uniqueRegions = new Set();
    for (const a of State.oblasts.values()) if (a.name) uniqueRegions.add(a.name);
    for (const sc of State.specialCities.values()) if (sc.name) uniqueRegions.add(sc.name);
    for (const r of State.raions.values()) if (r.oblast) uniqueRegions.add(r.oblast);

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    set('stat-active-alerts',   activeAlerts);
    set('stat-active-threats',  activeThreats);
    set('stat-regions-alert',   uniqueRegions.size);
    set('stat-last-update',     State.lastSyncTime || '--:--:--');
    set('footer-sync-time',     `Остання синхронізація: ${State.lastSyncTime || '--:--:--'}`);
    set('count-filter-all',     activeAlerts + activeThreats);
    set('count-filter-alerts',  activeAlerts);
    set('count-filter-threats', activeThreats);

    let d = 0, m = 0, b = 0;
    for (const t of State.threats.values()) {
      if (t.type === 'drone')          d++;
      else if (t.type === 'missile')   m++;
      else if (t.type === 'ballistic') b++;
    }
    set('count-sub-drone',      d);
    set('count-sub-missile',    m);
    set('count-sub-ballistic',  b);
  },

  bindSearch() {
    const input    = document.getElementById('input-search-location');
    const btnClear = document.getElementById('btn-clear-search');
    const dropdown = document.getElementById('search-results-dropdown');

    input?.addEventListener('input', (e) => {
      const val = e.target.value;
      btnClear?.classList.toggle('hidden', val.length === 0);
      if (!val.trim()) { dropdown?.classList.add('hidden'); return; }

      const results = TerritoriesManager.search(val);
      if (!results.length) {
        dropdown.innerHTML = `<div class="p-2 text-center text-gray-400 text-xs font-mono">Нічого не знайдено</div>`;
        dropdown.classList.remove('hidden');
        return;
      }

      dropdown.innerHTML = results.map(item => {
        let iconSvg = '<svg class="w-3.5 h-3.5 text-purple-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 10h18M5 10v11M19 10v11M9 10v11M15 10v11M12 3l9 7H3z"/></svg>';
        let typeBadge = '<span class="text-[9px] text-purple-400 font-bold">ОБЛАСТЬ</span>';
        let subtext = 'Адміністративна область';

        if (item.name === 'Київ' || item.name === 'Севастополь') {
          iconSvg = '<svg class="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v8h4"/><path d="M18 9h2a2 2 0 0 1 2 2v11h-4"/></svg>';
          typeBadge = '<span class="text-[9px] text-emerald-400 font-bold">СПЕЦ. СТАТУС</span>';
          subtext = 'Місто зі спеціальним статусом';
        } else if (item.type === 'city') {
          iconSvg = '<svg class="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v8h4"/><path d="M18 9h2a2 2 0 0 1 2 2v11h-4"/></svg>';
          typeBadge = '<span class="text-[9px] text-emerald-400 font-bold">МІСТО</span>';
          subtext = `${item.districtName ? item.districtName + ', ' : ''}${item.regionName}`;
        } else if (item.type === 'district') {
          iconSvg = '<svg class="w-3.5 h-3.5 text-sky-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/><circle cx="12" cy="10" r="3"/></svg>';
          typeBadge = '<span class="text-[9px] text-sky-400 font-bold">РАЙОН</span>';
          subtext = item.regionName;
        }

        const isStarred   = FollowManager.isFollowed(item.name);
        const statusInfo  = TerritoriesManager.resolveStatus(item);
        const statusBadge = statusInfo.active
          ? `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold text-white shadow-sm" style="background-color: ${getAlertColor(statusInfo.level)}">ТРИВОГА</span>`
          : `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20">СПОКІЙНО</span>`;

        return `
          <div class="flex items-center justify-between p-2 rounded-lg hover:bg-white/10 cursor-pointer border border-transparent hover:border-white/10 transition-colors" data-name="${item.name}">
            <div class="flex items-center gap-2 truncate">
              <span class="flex-shrink-0">${iconSvg}</span>
              <div class="truncate">
                <div class="flex items-center gap-1.5"><span class="font-bold text-xs text-gray-100">${item.name}</span>${typeBadge}</div>
                <div class="text-[10px] text-gray-400 truncate">${subtext}</div>
              </div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              ${statusBadge}
              <button class="star-btn ${isStarred ? 'text-amber-400' : 'text-gray-400 hover:text-amber-300'} p-1" data-name="${item.name}" title="Слідкувати">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="${isStarred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              </button>
            </div>
          </div>`;
      }).join('');

      dropdown.querySelectorAll('[data-name]').forEach(el => {
        el.addEventListener('click', (ev) => {
          const name = el.dataset.name;
          if (ev.target.closest('.star-btn')) {
            ev.stopPropagation();
            FollowManager.toggleFollowByName(name);
            return;
          }
          const item = results.find(r => r.name === name);
          if (item) {
            UIController.updateSelectedTerritoryCard(item.name, item.districtName, item.regionName, item.type === 'city');
            if (item.type === 'region') {
              MapService.flyToRegion(item.name);
            } else {
              MapService.selectAndShowDistrict(item.name, true);
            }
          } else {
            MapService.selectAndShowDistrict(name, true);
          }
          dropdown.classList.add('hidden');
        });
      });

      dropdown.classList.remove('hidden');
    });

    btnClear?.addEventListener('click', () => {
      if (input) input.value = '';
      btnClear.classList.add('hidden');
      dropdown?.classList.add('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#search-container')) dropdown?.classList.add('hidden');
    });
  },

  bindTreeModal() {
    const modal       = document.getElementById('territory-tree-modal');
    const btnOpen     = document.getElementById('btn-open-tree');
    const btnClose    = document.getElementById('btn-close-tree-modal');
    const content     = document.getElementById('territory-tree-content');
    const filterInput = document.getElementById('input-tree-filter');

    const renderTree = (q = '') => {
      if (!content) return;
      const query = q.trim().toLowerCase();

      content.innerHTML = TerritoriesManager.hierarchy.map(reg => {
        if (query && !reg.name.toLowerCase().includes(query) && !reg.districts.some(d => d.name.toLowerCase().includes(query))) {
          return '';
        }

        const regStatus = TerritoriesManager.resolveStatus(reg);
        const regBadge  = regStatus.active
          ? `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold text-white" style="background-color: ${getAlertColor(regStatus.level)}">ТРИВОГА</span>`
          : `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold text-emerald-400 bg-emerald-500/10">СПОКІЙНО</span>`;
        const isRegStarred = FollowManager.isFollowed(reg.name);

        const districtsHtml = reg.districts.map(dist => {
          if (query && !dist.name.toLowerCase().includes(query) && !reg.name.toLowerCase().includes(query)) return '';
          const dStatus = TerritoriesManager.resolveStatus(dist);
          const dBadge  = dStatus.active
            ? `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold text-white" style="background-color: ${getAlertColor(dStatus.level)}">ТРИВОГА</span>`
            : `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold text-emerald-400 bg-emerald-500/10">СПОКІЙНО</span>`;
          const isDStarred = FollowManager.isFollowed(dist.name);

          return `
            <div class="pl-3 border-l border-white/10 my-1">
              <div class="flex items-center justify-between p-1 hover:bg-white/5 rounded cursor-pointer group" onclick="MapService.selectAndShowDistrict('${dist.name}', true); document.getElementById('territory-tree-modal').classList.add('hidden');">
                <span class="font-semibold text-gray-200 group-hover:text-sky-300">${dist.name}</span>
                <div class="flex items-center gap-2">
                  ${dBadge}
                  <button onclick="event.stopPropagation(); FollowManager.toggleFollowByName('${dist.name}'); UIController.bindTreeModal();" class="p-1 ${isDStarred ? 'text-amber-400' : 'text-gray-500 hover:text-amber-300'}" title="Слідкувати">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="${isDStarred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                  </button>
                </div>
              </div>
            </div>
          `;
        }).join('');

        return `
          <div class="p-2 rounded-xl bg-black/40 border border-white/10 mb-2">
            <div class="flex items-center justify-between cursor-pointer group" onclick="MapService.flyToRegion('${reg.name}'); document.getElementById('territory-tree-modal').classList.add('hidden');">
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-purple-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 10h18M5 10v11M19 10v11M9 10v11M15 10v11M12 3l9 7H3z"/></svg>
                <span class="font-bold text-sm text-white group-hover:text-sky-300">${reg.name}</span>
              </div>
              <div class="flex items-center gap-2">
                ${regBadge}
                <button onclick="event.stopPropagation(); FollowManager.toggleFollowByName('${reg.name}'); UIController.bindTreeModal();" class="p-1 ${isRegStarred ? 'text-amber-400' : 'text-gray-500 hover:text-amber-300'}" title="Слідкувати">
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="${isRegStarred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </button>
              </div>
            </div>
            <div class="mt-2">${districtsHtml}</div>
          </div>
        `;
      }).join('');
    };

    btnOpen?.addEventListener('click',  () => { renderTree(); modal?.classList.remove('hidden'); });
    btnClose?.addEventListener('click', () => modal?.classList.add('hidden'));
    filterInput?.addEventListener('input', (e) => renderTree(e.target.value));
  },

  bindButtons() {
    document.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', () => this.setFilter(btn.dataset.filter)));
    document.querySelectorAll('.subtype-btn').forEach(btn => btn.addEventListener('click', () => this.setFilter(btn.dataset.subtype)));

    document.getElementById('select-region')?.addEventListener('change', (e) => {
      State.selectedRegion = e.target.value;
      State.selectedDistrict = 'all';
      localStorage.setItem('radar_selected_region', State.selectedRegion);
      localStorage.setItem('radar_selected_district', 'all');

      const tgRegionSelect = document.getElementById('tg-select-region');
      if (tgRegionSelect) tgRegionSelect.value = State.selectedRegion;
      const setRegSelect = document.getElementById('setting-selected-region');
      if (setRegSelect) setRegSelect.value = State.selectedRegion;

      MapService.flyToRegion(State.selectedRegion);
      GlobalTerritoryFilter.onTerritoryChanged();
    });

    // Мобільна шторка панелі фільтрів (щоб карта не перекривалася на телефоні)
    const btnMobileTogglePanel = document.getElementById('btn-mobile-toggle-panel');
    const btnCloseLeftPanel    = document.getElementById('btn-close-left-panel');
    const leftPanelBackdrop    = document.getElementById('left-panel-backdrop');
    const leftPanel            = document.getElementById('left-panel');

    const openMobilePanel = () => {
      leftPanel?.classList.remove('hidden');
      leftPanel?.classList.add('mobile-open');
      leftPanelBackdrop?.classList.remove('hidden');
    };

    const closeMobilePanel = () => {
      leftPanel?.classList.remove('mobile-open');
      if (window.innerWidth < 640) {
        leftPanel?.classList.add('hidden');
      }
      leftPanelBackdrop?.classList.add('hidden');
      setTimeout(() => MapService.map?.invalidateSize(), 100);
    };

    btnMobileTogglePanel?.addEventListener('click', openMobilePanel);
    btnCloseLeftPanel?.addEventListener('click', closeMobilePanel);
    leftPanelBackdrop?.addEventListener('click', closeMobilePanel);

    document.getElementById('btn-status-active')?.addEventListener('click', () => {
      State.statusFilter = 'active';
      document.getElementById('btn-status-active').className = 'status-toggle-btn active py-1 text-center text-xs font-semibold rounded bg-sky-600 text-white transition-colors';
      document.getElementById('btn-status-all').className    = 'status-toggle-btn py-1 text-center text-xs font-medium text-gray-400 hover:text-white rounded transition-colors';
      FeedService.render();
    });

    document.getElementById('btn-status-all')?.addEventListener('click', () => {
      State.statusFilter = 'all';
      document.getElementById('btn-status-all').className    = 'status-toggle-btn active py-1 text-center text-xs font-semibold rounded bg-sky-600 text-white transition-colors';
      document.getElementById('btn-status-active').className = 'status-toggle-btn py-1 text-center text-xs font-medium text-gray-400 hover:text-white rounded transition-colors';
      FeedService.render();
    });

    document.getElementById('btn-clear-session-history')?.addEventListener('click', () => {
      State.history = [];
      FeedService.render();
      showToast('Історію очищено');
    });

    document.getElementById('btn-toggle-fullscreen')?.addEventListener('click', () => {
      document.body.classList.toggle('fullscreen-radar');
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      else document.exitFullscreen().catch(() => {});
      setTimeout(() => MapService.map?.invalidateSize(), 200);
    });

    document.getElementById('btn-mobile-toggle-feed')?.addEventListener('click', () => {
      NavigationController.switchTab('alerts');
    });

    // Reconnect з debounce / guard
    const btnReconnect = document.getElementById('btn-reconnect-now');
    btnReconnect?.addEventListener('click', () => {
      if (btnReconnect.disabled) return;
      btnReconnect.disabled = true;
      btnReconnect.textContent = 'З\'єднання...';
      RealtimeClient.connect();
      PollingService.poll();
      setTimeout(() => {
        btnReconnect.disabled = false;
        btnReconnect.textContent = 'Перепідключитися зараз';
      }, 2500);
    });

    // Header Logo кнопка: повернення до карти всієї України
    const btnLogo = document.getElementById('btn-header-logo');
    const handleLogoClick = () => {
      MapService.flyToRegion('all');
      NavigationController.switchTab('map');
    };
    btnLogo?.addEventListener('click', handleLogoClick);
    btnLogo?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleLogoClick();
      }
    });

    // Retry Sync на оверлеї помилки
    const btnRetry = document.getElementById('btn-retry-sync');
    btnRetry?.addEventListener('click', () => {
      if (btnRetry.disabled) return;
      btnRetry.disabled = true;
      btnRetry.textContent = 'Синхронізація...';
      window.location.reload();
    });

    // Кнопка закриття картки території
    document.getElementById('card-btn-close')?.addEventListener('click', () => {
      document.getElementById('selected-territory-card')?.classList.add('hidden');
      MapService.clearDistrictSelection();
    });

    // Кнопка зірочки на картці території
    document.getElementById('card-btn-star')?.addEventListener('click', () => {
      if (this.currentCardTerritory) {
        FollowManager.toggleFollowByName(this.currentCardTerritory);
        this.updateSelectedTerritoryCard(this.currentCardTerritory, this.currentCardDistrict, this.currentCardRegion);
      }
    });
  },

  setFilter(key) {
    State.activeFilter = key;
    document.querySelectorAll('.filter-btn').forEach(b => {
      const match = b.dataset.filter === key;
      b.className = match
        ? 'filter-btn active w-full text-left px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-sky-600/80 text-white border border-sky-400/40 transition-all flex items-center justify-between'
        : 'filter-btn w-full text-left px-2.5 py-1.5 text-xs font-medium rounded-lg text-gray-200 hover:bg-white/10 transition-all flex items-center justify-between';
    });
    FeedService.render();
  },

  bindShortcuts() {
    window.addEventListener('keydown', (e) => {
      const tag = e.target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') { if (e.key === 'Escape') e.target.blur(); return; }
      if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') { e.preventDefault(); document.getElementById('btn-toggle-fullscreen')?.click(); }
      else if (e.key === 'Escape') {
        document.getElementById('settings-modal')?.classList.add('hidden');
        document.getElementById('territory-tree-modal')?.classList.add('hidden');
        MapService.clearDistrictSelection();
        document.body.classList.remove('fullscreen-radar');
      }
      else if (e.key === '/') { e.preventDefault(); document.getElementById('input-search-location')?.focus(); }
      else if (e.key === '1') this.setFilter('all');
      else if (e.key === '2') this.setFilter('alerts');
      else if (e.key === '3') this.setFilter('threats');
    });
  },

  bindSettingsModal() {
    const modal          = document.getElementById('settings-modal');
    const btnOpen        = document.getElementById('btn-open-settings');
    const btnClose       = document.getElementById('btn-close-settings');
    const btnSave        = document.getElementById('btn-save-settings');
    const notifCheck     = document.getElementById('setting-notifications-enabled');
    const officialCheck  = document.getElementById('setting-official-alerts-enabled');
    const threatsCheck   = document.getElementById('setting-threats-alerts-enabled');
    const launchesCheck  = document.getElementById('setting-launches-alerts-enabled');
    const infoCheck      = document.getElementById('setting-info-messages-enabled');
    const urgentCheck    = document.getElementById('setting-urgent-alerts-enabled');
    const soundCheck     = document.getElementById('setting-sound-enabled');
    const quietCheck     = document.getElementById('setting-quiet-hours');
    const opRange        = document.getElementById('setting-zone-opacity');
    const opLabel        = document.getElementById('label-zone-opacity');
    const layerAlerts    = document.getElementById('setting-layer-alerts');
    const layerThreats   = document.getElementById('setting-layer-threats');
    const animCheck      = document.getElementById('setting-enable-animations');

    // Фільтрація сповіщень за районами та областями
    const settingRegionSelect      = document.getElementById('setting-selected-region');
    const settingDistrictSelect    = document.getElementById('setting-selected-district');
    const settingDistrictContainer = document.getElementById('setting-district-container');
    const settingShowOblastWide    = document.getElementById('setting-show-oblast-wide');

    settingRegionSelect?.addEventListener('change', (e) => {
      const reg = e.target.value;
      if (reg && reg !== 'all') {
        settingDistrictContainer?.classList.remove('hidden');
        const districts = (window.TerritoriesManager && typeof TerritoriesManager.getDistrictsForOblast === 'function')
          ? TerritoriesManager.getDistrictsForOblast(reg)
          : [];
        if (settingDistrictSelect) {
          settingDistrictSelect.innerHTML = `<option value="all">Усі райони (${reg})</option>` +
            districts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
          settingDistrictSelect.value = 'all';
        }
      } else {
        settingDistrictContainer?.classList.add('hidden');
        if (settingDistrictSelect) settingDistrictSelect.innerHTML = `<option value="all">Усі райони</option>`;
      }
    });

    // Персональна небезпека (Вимога Розділу 11)
    const geoCheck            = document.getElementById('setting-geo-enabled');
    const geoSuboptions       = document.getElementById('personal-danger-suboptions');
    const radiusSelect        = document.getElementById('setting-personal-radius');
    const customRadiusBox     = document.getElementById('personal-radius-custom-box');
    const customRadiusInput   = document.getElementById('setting-personal-radius-custom');
    const radiusHint          = document.getElementById('personal-danger-status-hint');
    const personalNotifCheck  = document.getElementById('setting-personal-notif');
    const personalUrgentCheck = document.getElementById('setting-personal-urgent');
    const personalSoundCheck  = document.getElementById('setting-personal-sound');

    const updateGeoSuboptionsState = (enabled) => {
      if (geoSuboptions) {
        geoSuboptions.classList.toggle('opacity-50', !enabled);
        geoSuboptions.classList.toggle('pointer-events-none', !enabled);
      }
    };

    const updateRadiusHint = (rad) => {
      if (radiusHint) {
        radiusHint.textContent = `Високий рівень: ціль у радіусі ${rad} км`;
      }
    };

    geoCheck?.addEventListener('change', async (e) => {
      if (e.target.checked) {
        const granted = await PersonalDangerService.enableWithPermission();
        if (!granted) {
          e.target.checked = false;
          showToast('Дозвіл на доступ до геолокації не надано');
        }
      } else {
        PersonalDangerService.disable();
      }
      updateGeoSuboptionsState(geoCheck.checked);
    });

    radiusSelect?.addEventListener('change', (e) => {
      const isCustom = e.target.value === 'custom';
      if (customRadiusBox) {
        customRadiusBox.classList.toggle('hidden', !isCustom);
      }
      const rad = isCustom ? (parseFloat(customRadiusInput?.value) || 10) : parseFloat(e.target.value);
      updateRadiusHint(rad);
    });

    customRadiusInput?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value) || 10;
      updateRadiusHint(val);
    });

    // ШІ налаштування (Вимога п.7)
    const aiMasterCheck    = document.getElementById('setting-ai-master-enabled');
    const aiAnalyzeCheck   = document.getElementById('setting-ai-analyze-messages');
    const aiNotifCheck     = document.getElementById('setting-ai-notifications');
    const aiRegionsSelect  = document.getElementById('setting-ai-regions');
    const aiTypeThreats    = document.getElementById('setting-ai-type-threats');
    const aiTypeLaunches   = document.getElementById('setting-ai-type-launches');
    const aiTypeInfo       = document.getElementById('setting-ai-type-info');

    const updateAiSuboptionsState = (enabled) => {
      const sub = document.getElementById('ai-settings-suboptions');
      const lbl = document.getElementById('ai-toggle-label');
      const subtxt = document.getElementById('ai-status-subtext');
      if (sub) {
        sub.classList.toggle('opacity-50', !enabled);
        sub.classList.toggle('pointer-events-none', !enabled);
      }
      if (lbl) {
        lbl.textContent = enabled ? 'Увімкнено' : 'Вимкнено';
        lbl.className = enabled ? 'text-xs font-mono font-bold text-purple-400' : 'text-xs font-mono font-bold text-gray-400';
      }
      if (subtxt) {
        subtxt.textContent = enabled ? '● Активний (аналіз у реальному часі)' : 'Вимкнено за замовчуванням';
        subtxt.className = enabled ? 'text-[10px] text-purple-300 mt-0.5 font-medium' : 'text-[10px] text-gray-400 mt-0.5';
      }
    };

    aiMasterCheck?.addEventListener('change', (e) => {
      updateAiSuboptionsState(e.target.checked);
    });

    const openModal = () => {
      const s = StorageManager.getSettings();
      if (notifCheck)      notifCheck.checked      = s.notificationsEnabled;
      if (officialCheck)   officialCheck.checked   = s.officialAlertsEnabled !== false;
      if (threatsCheck)    threatsCheck.checked    = s.threatsAlertsEnabled !== false;
      if (launchesCheck)   launchesCheck.checked   = s.launchesAlertsEnabled !== false;
      if (infoCheck)       infoCheck.checked       = s.infoMessagesEnabled !== false;
      if (urgentCheck)     urgentCheck.checked     = s.urgentAlertsEnabled !== false;
      if (soundCheck)      soundCheck.checked      = s.soundEnabled !== false;
      if (quietCheck)      quietCheck.checked      = s.quietHours || false;
      if (opRange)         opRange.value           = s.zoneOpacity || 0.35;
      if (opLabel)         opLabel.textContent     = `${Math.round((s.zoneOpacity || 0.35) * 100)}%`;
      if (layerAlerts)     layerAlerts.checked     = s.layerAlerts;
      if (layerThreats)    layerThreats.checked    = s.layerThreats;
      if (animCheck)       animCheck.checked       = s.enableAnimations;

      // Персональна небезпека
      const geoOn = s.geoEnabled === true;
      if (geoCheck) geoCheck.checked = geoOn;
      updateGeoSuboptionsState(geoOn);

      const currentRadius = s.personalDangerRadiusKm || 10;
      const standardRadii = ['5', '10', '15', '20'];
      if (standardRadii.includes(String(currentRadius))) {
        if (radiusSelect) radiusSelect.value = String(currentRadius);
        if (customRadiusBox) customRadiusBox.classList.add('hidden');
      } else {
        if (radiusSelect) radiusSelect.value = 'custom';
        if (customRadiusBox) customRadiusBox.classList.remove('hidden');
        if (customRadiusInput) customRadiusInput.value = currentRadius;
      }
      updateRadiusHint(currentRadius);

      if (personalNotifCheck)  personalNotifCheck.checked  = s.personalDangerNotif !== false;
      if (personalUrgentCheck) personalUrgentCheck.checked = s.personalDangerUrgent !== false;
      if (personalSoundCheck)  personalSoundCheck.checked  = s.personalDangerSound !== false;

      // Завантаження стану ШІ
      const aiOn = s.aiEnabled === true;
      if (aiMasterCheck)   aiMasterCheck.checked   = aiOn;
      if (aiAnalyzeCheck)  aiAnalyzeCheck.checked  = s.aiAnalyzeMessages !== false;
      if (aiNotifCheck)    aiNotifCheck.checked    = s.aiNotifications === true;
      if (aiRegionsSelect) aiRegionsSelect.value   = s.aiRegions || 'all';
      if (aiTypeThreats)   aiTypeThreats.checked   = s.aiTypeThreats !== false;
      if (aiTypeLaunches)  aiTypeLaunches.checked  = s.aiTypeLaunches !== false;
      if (aiTypeInfo)      aiTypeInfo.checked      = s.aiTypeInfo !== false;
      updateAiSuboptionsState(aiOn);

      // Територія та райони сповіщень
      if (settingRegionSelect) settingRegionSelect.value = State.selectedRegion || 'all';
      if (State.selectedRegion && State.selectedRegion !== 'all') {
        settingDistrictContainer?.classList.remove('hidden');
        const districts = (window.TerritoriesManager && typeof TerritoriesManager.getDistrictsForOblast === 'function')
          ? TerritoriesManager.getDistrictsForOblast(State.selectedRegion)
          : [];
        if (settingDistrictSelect) {
          settingDistrictSelect.innerHTML = `<option value="all">Усі райони (${State.selectedRegion})</option>` +
            districts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
          settingDistrictSelect.value = State.selectedDistrict || 'all';
        }
      } else {
        settingDistrictContainer?.classList.add('hidden');
        if (settingDistrictSelect) settingDistrictSelect.innerHTML = `<option value="all">Усі райони</option>`;
      }
      if (settingShowOblastWide) {
        settingShowOblastWide.checked = State.showEntireRegionWithDistrict !== false;
      }

      modal?.classList.remove('hidden');
    };

    this.openSettingsModal = openModal;
    btnOpen?.addEventListener('click', openModal);

    btnClose?.addEventListener('click', () => modal?.classList.add('hidden'));

    opRange?.addEventListener('input', (e) => {
      if (opLabel) opLabel.textContent = `${Math.round(parseFloat(e.target.value) * 100)}%`;
    });

    notifCheck?.addEventListener('change', async () => {
      if (notifCheck.checked) {
        const ok = await NotificationManager.requestPermission();
        if (!ok) { notifCheck.checked = false; showToast('Дозвіл на сповіщення відхилено'); }
      }
    });

    document.getElementById('btn-test-alert')?.addEventListener('click', () => {
      SoundService.playAlertSiren();
      showToast('Тест: Оголошення тривоги');
    });

    document.getElementById('btn-test-clear')?.addEventListener('click', () => {
      SoundService.playClearSound();
      showToast('Тест: Відбій тривоги');
    });

    document.getElementById('btn-test-urgent')?.addEventListener('click', () => {
      SoundService.playUrgentSiren();
      showToast('Тест: Високий рівень небезпеки', true);
    });

    const testSoundBtn = document.getElementById('btn-test-sound');
    testSoundBtn?.addEventListener('click', () => {
      SoundService.playAlertSiren();
      showToast('Тест звуку: Оголошення тривоги');
    });

    btnSave?.addEventListener('click', () => {
      if (btnSave.disabled) return;
      btnSave.disabled = true;
      btnSave.textContent = 'Збереження...';

      let personalRad = 10;
      if (radiusSelect?.value === 'custom') {
        personalRad = Math.max(1, Math.min(200, parseFloat(customRadiusInput?.value) || 10));
      } else {
        personalRad = parseFloat(radiusSelect?.value || '10') || 10;
      }

      const isGeoEnabled = geoCheck?.checked === true;

      const chosenRegion     = settingRegionSelect?.value || 'all';
      const chosenDistrict   = settingDistrictSelect?.value || 'all';
      const chosenOblastWide = settingShowOblastWide?.checked !== false;

      State.selectedRegion = chosenRegion;
      State.selectedDistrict = chosenDistrict;
      State.showEntireRegionWithDistrict = chosenOblastWide;

      localStorage.setItem('radar_selected_region', chosenRegion);
      localStorage.setItem('radar_selected_district', chosenDistrict);
      localStorage.setItem('radar_show_oblast_wide', chosenOblastWide);

      const selMain = document.getElementById('select-region');
      if (selMain) selMain.value = chosenRegion;
      const tgReg = document.getElementById('tg-select-region');
      if (tgReg) tgReg.value = chosenRegion;

      GlobalTerritoryFilter.onTerritoryChanged();

      const updated = {
        notificationsEnabled:   notifCheck?.checked || false,
        officialAlertsEnabled:  officialCheck?.checked !== false,
        threatsAlertsEnabled:   threatsCheck?.checked !== false,
        launchesAlertsEnabled:  launchesCheck?.checked !== false,
        infoMessagesEnabled:    infoCheck?.checked !== false,
        urgentAlertsEnabled:    urgentCheck?.checked !== false,
        geoEnabled:             isGeoEnabled,
        personalDangerRadiusKm: personalRad,
        personalDangerNotif:    personalNotifCheck?.checked !== false,
        personalDangerUrgent:   personalUrgentCheck?.checked !== false,
        personalDangerSound:    personalSoundCheck?.checked !== false,
        aiEnabled:              aiMasterCheck?.checked === true,
        aiAnalyzeMessages:      aiAnalyzeCheck?.checked !== false,
        aiNotifications:        aiNotifCheck?.checked === true,
        aiRegions:              aiRegionsSelect?.value || 'all',
        aiTypeThreats:          aiTypeThreats?.checked !== false,
        aiTypeLaunches:         aiTypeLaunches?.checked !== false,
        aiTypeInfo:             aiTypeInfo?.checked !== false,
        aiTabVisible:           true,
        soundEnabled:           soundCheck?.checked !== false,
        quietHours:             quietCheck?.checked || false,
        zoneOpacity:            parseFloat(opRange?.value || 0.35),
        layerAlerts:            layerAlerts?.checked !== false,
        layerThreats:           layerThreats?.checked !== false,
        enableAnimations:       animCheck?.checked !== false
      };
      StorageManager.saveSettings(updated);
      NavigationController.applyTabVisibility();
      AIService?.updateEnabledState();
      AIService?.render();

      if (isGeoEnabled) {
        PersonalDangerService.startWatching(true);
      } else {
        PersonalDangerService.disable();
      }

      modal?.classList.add('hidden');
      document.body.classList.toggle('disable-animations', !updated.enableAnimations);
      MapService.updateAllDistrictStyles();
      for (const t of State.threats.values()) MapService.updateThreat(t);
      showToast(updated.aiEnabled ? 'Налаштування збережено (ШІ увімкнено)' : 'Налаштування збережено (ШІ вимкнено)');

      setTimeout(() => {
        btnSave.disabled = false;
        btnSave.textContent = 'Зберегти налаштування';
      }, 600);
    });
  },

  startClock() {
    const clockEl = document.getElementById('header-clock');
    const upd = () => { if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('uk-UA'); };
    setInterval(upd, 1000);
    upd();
  },

  hideLoading() {
    const ov = document.getElementById('loading-overlay');
    if (ov) { ov.style.pointerEvents = 'none'; ov.style.opacity = '0'; ov.classList.add('hidden'); }
  }
};

/* ============================================================
   14. SOUND ТА NOTIFICATION SERVICES
============================================================ */
const SoundService = {
  ctx: null,
  sirenAudio: null,
  clearAudio: null,
  urgentAudio: null,
  chimeAudio: null,
  notificationAudio: null,  // звук інформаційного сповіщення (notification.mp3)

  init() {
    try {
      this.sirenAudio = new Audio(`${BASE_PATH}sounds/siren.mp3`);
      this.sirenAudio.preload = 'auto';
      this.clearAudio = new Audio(`${BASE_PATH}sounds/clear.mp3`);
      this.clearAudio.preload = 'auto';
      this.urgentAudio = new Audio(`${BASE_PATH}sounds/urgent.mp3`);
      this.urgentAudio.preload = 'auto';
      this.chimeAudio = new Audio(`${BASE_PATH}sounds/chime.ogg`);
      this.chimeAudio.preload = 'auto';
      this.notificationAudio = new Audio(`${BASE_PATH}sounds/notification.mp3`);
      this.notificationAudio.preload = 'auto';
    } catch (e) {
      console.warn('[SoundService] Audio error:', e);
    }
  },

  ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) this.ctx = new Ctx();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },

  isQuietTime() {
    const s = StorageManager.getSettings();
    if (!s.quietHours) return false;
    const h = new Date().getHours();
    return h >= 23 || h < 7;
  },

  stopAll() {
    [this.sirenAudio, this.clearAudio, this.urgentAudio, this.chimeAudio, this.notificationAudio].forEach(a => {
      if (a) {
        try {
          a.pause();
          a.currentTime = 0;
        } catch (e) {}
      }
    });
  },

  playUrgentSiren() {
    if (isInitialLoad) return;
    const s = StorageManager.getSettings();
    if (!s.soundEnabled || s.urgentAlertsEnabled === false || this.isQuietTime()) return;

    this.stopAll();
    if (this.urgentAudio) {
      this.urgentAudio.currentTime = 0;
      this.urgentAudio.play().catch(() => {
        this.synthesizeUrgentAlert();
      });
    } else {
      this.synthesizeUrgentAlert();
    }
  },

  playAlertSiren() {
    if (isInitialLoad) return;
    const s = StorageManager.getSettings();
    if (!s.soundEnabled || this.isQuietTime()) return;

    this.stopAll();
    if (this.sirenAudio) {
      this.sirenAudio.currentTime = 0;
      this.sirenAudio.play().catch(() => {
        this.synthesizeSiren();
      });
    } else {
      this.synthesizeSiren();
    }
  },

  playClearSound() {
    if (isInitialLoad) return;
    const s = StorageManager.getSettings();
    if (!s.soundEnabled || this.isQuietTime()) return;

    this.stopAll();
    if (this.clearAudio) {
      this.clearAudio.currentTime = 0;
      this.clearAudio.play().catch(() => {
        this.synthesizeChime();
      });
    } else {
      this.synthesizeChime();
    }
  },

  playInfoChime() {
    if (isInitialLoad) return;
    const s = StorageManager.getSettings();
    if (!s.soundEnabled || this.isQuietTime()) return;

    this.stopAll();
    // Спочатку намагаємося відтворити notification.mp3 (завантажений користувачем звук),
    // fallback — chime.ogg, і нарешті — синтезований звук.
    const audio = this.notificationAudio || this.chimeAudio;
    if (audio) {
      audio.currentTime = 0;
      audio.play().catch(() => {
        // Якщо основний звук не відтворився — спробуємо резервний chime
        if (this.notificationAudio && this.chimeAudio) {
          this.chimeAudio.currentTime = 0;
          this.chimeAudio.play().catch(() => this.synthesizeChime());
        } else {
          this.synthesizeChime();
        }
      });
    } else {
      this.synthesizeChime();
    }
  },

  synthesizeUrgentAlert() {
    try {
      this.ensureContext();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(587.33, now + 0.15);
      osc.frequency.setValueAtTime(880, now + 0.3);
      osc.frequency.setValueAtTime(587.33, now + 0.45);
      osc.frequency.setValueAtTime(880, now + 0.6);

      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(0.3, now + 0.05);
      gain.gain.setValueAtTime(0.25, now + 0.6);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.85);
    } catch (e) {}
  },

  synthesizeSiren() {
    try {
      this.ensureContext();
      if (!this.ctx) return;
      const now  = this.ctx.currentTime;
      const osc  = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.linearRampToValueAtTime(740, now + 0.35);
      osc.frequency.linearRampToValueAtTime(440, now + 0.7);
      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.75);
    } catch (e) {}
  },

  synthesizeChime() {
    try {
      this.ensureContext();
      if (!this.ctx) return;
      const now  = this.ctx.currentTime;
      const osc  = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.15);
      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.35);
    } catch (e) {}
  }
};

const NotificationManager = {
  swRegistration: null,

  async init() {
    if ('serviceWorker' in navigator) {
      try {
        this.swRegistration = await navigator.serviceWorker.register('/sw.js');
        console.log('[PWA] Service Worker успішно зареєстровано');
      } catch (err) {
        console.warn('[PWA] Не вдалося зареєструвати Service Worker:', err);
      }
    }
  },

  async requestPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    return (await Notification.requestPermission()) === 'granted';
  },

  send(title, body, tag = 'radar-alert', isUrgent = false) {
    if (isInitialLoad) return;
    const s = StorageManager.getSettings();
    if (!s.notificationsEnabled || SoundService.isQuietTime()) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const options = {
        body,
        icon: isUrgent
          ? 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23ef4444"><path d="M12 2L1 21h22L12 2zm0 3.5L20 19H4L12 5.5zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg>'
          : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%230284c7"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>',
        tag,
        requireInteraction: isUrgent
      };
      if (this.swRegistration && this.swRegistration.showNotification) {
        this.swRegistration.showNotification(title, options);
      } else {
        new Notification(title, options);
      }
    } catch (e) {}
  }
};

/* ============================================================
   ПЕРСОНАЛЬНА НЕБЕЗПЕКА ТА ГЕОЛОКАЦІЯ (PersonalDangerService)
   Повна конфіденційність: координати зберігаються тільки в пам'яті
============================================================ */
const PersonalDangerService = {
  userCoords: null, // { lat, lon, accuracy, timestamp } (IN-MEMORY ONLY)
  watchId: null,
  previousLevel: 'NORMAL', // 'NORMAL' | 'ELEVATED' | 'HIGH'
  minDistKm: null,
  closestTarget: null,

  init() {
    const s = StorageManager.getSettings();
    if (s.geoEnabled) {
      this.startWatching(false);
    }
    document.getElementById('personal-danger-pill')?.addEventListener('click', () => {
      UIController.openSettingsModal?.();
    });
  },

  calculateDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Радіус Землі в км
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  },

  async enableWithPermission() {
    if (!('geolocation' in navigator)) {
      showToast('Геолокація не підтримується цим браузером');
      return false;
    }

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.userCoords = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            timestamp: Date.now()
          };
          this.startWatching(true);
          resolve(true);
        },
        () => {
          this.disable();
          resolve(false);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
    });
  },

  startWatching(evaluateImmediately = true) {
    if (!('geolocation' in navigator)) return;
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.userCoords = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: Date.now()
        };
        const s = StorageManager.getSettings();
        const radius = Number(s.personalDangerRadiusKm) || 10;
        MapService.updateUserLocation(this.userCoords.lat, this.userCoords.lon, this.userCoords.accuracy, radius);
        this.evaluate();
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );

    if (evaluateImmediately && this.userCoords) {
      const s = StorageManager.getSettings();
      const radius = Number(s.personalDangerRadiusKm) || 10;
      MapService.updateUserLocation(this.userCoords.lat, this.userCoords.lon, this.userCoords.accuracy, radius);
      this.evaluate();
    }
  },

  disable() {
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.userCoords = null;
    this.previousLevel = 'NORMAL';
    this.minDistKm = null;
    this.closestTarget = null;
    MapService.removeUserLocation();
    this.updateUI('DISABLED');
  },

  evaluate() {
    const s = StorageManager.getSettings();
    if (!s.geoEnabled || !this.userCoords) {
      this.updateUI('DISABLED');
      return;
    }

    const radius = Number(s.personalDangerRadiusKm) || 10;
    let minDist = Infinity;
    let closest = null;

    for (const t of State.threats.values()) {
      if (!t) continue;
      // Ігноруємо неактивні цілі
      if (t.status === 'inactive' || t.status === 'destroyed' || t.status === 'cancelled') continue;
      // ВАЖЛИВО (п. 11.4): areaOnly === true — це центроїд адміністративної одиниці, а НЕ реальна точка цілі
      if (t.areaOnly === true) continue;
      // Перевірка валідності координат
      if (!Array.isArray(t.coordinates) || t.coordinates.length < 2 ||
          !Number.isFinite(t.coordinates[0]) || !Number.isFinite(t.coordinates[1])) {
        continue;
      }

      const dist = this.calculateDistanceKm(
        this.userCoords.lat,
        this.userCoords.lon,
        t.coordinates[0],
        t.coordinates[1]
      );

      if (dist < minDist) {
        minDist = dist;
        closest = t;
      }
    }

    this.minDistKm = (minDist !== Infinity) ? minDist : null;
    this.closestTarget = closest;

    let currentLevel = 'NORMAL';
    if (this.minDistKm !== null) {
      if (this.minDistKm <= radius) {
        currentLevel = 'HIGH';
      } else if (this.minDistKm <= radius * 1.5) {
        currentLevel = 'ELEVATED';
      }
    }

    // Подієве сповіщення: ТІЛЬКИ при переході в HIGH (п. 11.8, 11.9)
    if (currentLevel === 'HIGH' && this.previousLevel !== 'HIGH') {
      if (s.personalDangerNotif !== false && !isInitialLoad) {
        NotificationDispatcher.dispatch({
          id: `personal-danger-${Date.now()}`,
          type: NOTIFICATION_CATEGORIES.THREAT,
          title: 'Персональна небезпека',
          message: `Реальна ціль (${closest?.title || 'БпЛА/ракета'}) знаходиться приблизно за ${this.minDistKm.toFixed(1)} км від вашого місцезнаходження.`,
          isUrgent: s.personalDangerUrgent !== false,
          isPersonal: true,
          distanceKm: this.minDistKm,
          time: new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
          source: 'RADAR Geolocation'
        });

        if (s.personalDangerSound !== false && s.soundEnabled && !SoundService.isQuietTime()) {
          SoundService.playUrgentSiren();
        }
      }
    } else if (currentLevel === 'NORMAL' && this.previousLevel === 'HIGH') {
      if (!isInitialLoad) {
        showToast('Ціль вийшла з персонального радіуса небезпеки');
      }
    }

    this.previousLevel = currentLevel;
    this.updateUI(currentLevel, this.minDistKm, radius);
  },

  updateUI(level, distKm, radiusKm) {
    const pill = document.getElementById('personal-danger-pill');
    const dot = document.getElementById('personal-danger-dot');
    const text = document.getElementById('personal-danger-text');
    if (!pill || !dot || !text) return;

    if (level === 'DISABLED') {
      pill.classList.add('hidden');
      return;
    }

    pill.classList.remove('hidden', 'personal-danger-high', 'personal-danger-elevated', 'personal-danger-normal');

    if (level === 'HIGH') {
      pill.classList.add('personal-danger-high');
      dot.className = 'w-2 h-2 rounded-full bg-red-500 animate-ping';
      text.textContent = `НЕБЕЗПЕКА: ціль ~${distKm.toFixed(1)} км`;
    } else if (level === 'ELEVATED') {
      pill.classList.add('personal-danger-elevated');
      dot.className = 'w-2 h-2 rounded-full bg-amber-400';
      text.textContent = `Увага: ціль ~${distKm.toFixed(1)} км`;
    } else {
      pill.classList.add('personal-danger-normal');
      dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
      text.textContent = `Безпечно (${radiusKm || 10} км)`;
    }
  }
};

const StorageManager = {
  KEYS: {
    SETTINGS: 'radar_settings_v6'
  },

  defaultSettings: {
    notificationsEnabled:   false,
    officialAlertsEnabled:  true,
    threatsAlertsEnabled:   true,
    launchesAlertsEnabled:  true,
    infoMessagesEnabled:    true,
    urgentAlertsEnabled:    true,
    geoEnabled:             false, // За замовчуванням вимкнено (Вимога п. 11.1)
    personalDangerRadiusKm: 10,
    personalDangerNotif:    true,
    personalDangerUrgent:   true,
    personalDangerSound:    true,
    aiEnabled:              false, // Вимога п.6: ШІ за замовчуванням вимкнений!
    aiAnalyzeMessages:      false,
    aiNotifications:        false,
    aiRegions:              'all',
    aiTypeThreats:          true,
    aiTypeLaunches:         true,
    aiTypeInfo:             true,
    aiTabVisible:           true,
    soundEnabled:           true,
    quietHours:            false,
    zoneOpacity:           0.35,
    layerAlerts:           true,
    layerThreats:          true,
    enableAnimations:      true
  },

  getSettings() {
    try {
      const data = localStorage.getItem(this.KEYS.SETTINGS);
      if (data) return { ...this.defaultSettings, ...JSON.parse(data) };
    } catch (e) {}
    return { ...this.defaultSettings };
  },

  saveSettings(settings) {
    try {
      localStorage.setItem(this.KEYS.SETTINGS, JSON.stringify(settings));
    } catch (e) {}
  }
};

/* ============================================================
   ШІ-СЕРВІС (AIService) — ОПЕРАТИВНО-ТАКТИЧНИЙ АНАЛІЗ ЗАГРОЗ
============================================================ */
const AIService = {
  activeCategory: 'all',
  searchQuery:    '',

  init() {
    document.getElementById('btn-refresh-ai-status')?.addEventListener('click', () => {
      this.fetchEngineStatus(true);
    });

    document.getElementById('btn-run-ai-test')?.addEventListener('click', () => {
      this.runInteractiveTest();
    });

    document.getElementById('btn-ai-open-settings')?.addEventListener('click', () => {
      UIController.openSettingsModal?.();
    });

    ['all', 'threats', 'movements'].forEach(cat => {
      document.getElementById(`ai-filter-${cat}`)?.addEventListener('click', () => {
        this.activeCategory = cat;
        document.querySelectorAll('.ai-filter-btn').forEach(b => {
          b.classList.remove('active', 'bg-purple-600', 'text-white');
          b.classList.add('text-gray-300');
        });
        const btn = document.getElementById(`ai-filter-${cat}`);
        btn?.classList.add('active', 'bg-purple-600', 'text-white');
        btn?.classList.remove('text-gray-300');
        this.renderFeed();
      });
    });

    const searchInput = document.getElementById('ai-input-search');
    const clearBtn    = document.getElementById('ai-btn-clear-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim().toLowerCase();
        clearBtn?.classList.toggle('hidden', !this.searchQuery);
        this.renderFeed();
      });
    }
    clearBtn?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      this.searchQuery = '';
      clearBtn.classList.add('hidden');
      this.renderFeed();
    });

    this.updateEnabledState();
  },

  updateEnabledState() {
    const s = StorageManager.getSettings();
    const disabledContainer = document.getElementById('ai-disabled-container');
    const enabledContainer  = document.getElementById('ai-enabled-container');
    const isEnabled = s.aiEnabled === true;

    if (disabledContainer) disabledContainer.classList.toggle('hidden', isEnabled);
    if (enabledContainer)  enabledContainer.classList.toggle('hidden', !isEnabled);

    if (isEnabled) {
      this.fetchEngineStatus();
    }
  },

  async fetchEngineStatus(notify = false) {
    try {
      const res = await fetchUtf8Json('/api/v1/llm-status').catch(() => null);
      if (res && res.status === 'ok') {
        const providerEl = document.getElementById('ai-provider-name');
        const tagEl      = document.getElementById('ai-engine-status-tag');
        const cacheEl    = document.getElementById('ai-cache-val');

        if (providerEl) {
          if (res.isFallback && res.fallbackReason) {
            const shortReason = res.cooldownRemainingSec > 0 
              ? `Локальний NLP (429 Cooldown: ${res.cooldownRemainingSec}s)` 
              : `Локальний NLP (Fallback: ${res.fallbackReason.slice(0, 30)})`;
            providerEl.textContent = shortReason;
          } else {
            providerEl.textContent = res.hasApiKey ? res.engine : 'Локальний евристичний NLP';
          }
        }
        if (tagEl) {
          if (res.hasApiKey && !res.isFallback) {
            tagEl.textContent = 'GEMINI FREE TIER';
            tagEl.className   = 'px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-400/30 font-bold';
          } else if (res.isFallback && res.cooldownRemainingSec > 0) {
            tagEl.textContent = `COOLDOWN ${res.cooldownRemainingSec}s`;
            tagEl.className   = 'px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/20 text-amber-300 border border-amber-400/30 font-bold';
          } else if (res.isFallback) {
            tagEl.textContent = 'NLP FALLBACK';
            tagEl.className   = 'px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/20 text-amber-300 border border-amber-400/30 font-bold';
          } else {
            tagEl.textContent = 'NLP ONLINE';
            tagEl.className   = 'px-2 py-0.5 rounded text-[10px] font-mono bg-purple-500/20 text-purple-300 border border-purple-400/30 font-bold';
          }
        }
        if (cacheEl) {
          cacheEl.textContent = `${res.cacheEntries || 0} записів`;
        }

        if (notify) showToast('Статус ШІ оновлено');
      } else {
        // Клієнтський режим для GitHub Pages
        const providerEl = document.getElementById('ai-provider-name');
        const tagEl      = document.getElementById('ai-engine-status-tag');
        const cacheEl    = document.getElementById('ai-cache-val');
        if (providerEl) providerEl.textContent = 'Клієнтський NLP (Static Mode)';
        if (tagEl) {
          tagEl.textContent = 'CLIENT NLP';
          tagEl.className   = 'px-2 py-0.5 rounded text-[10px] font-mono bg-purple-500/20 text-purple-300 border border-purple-400/30 font-bold';
        }
        if (cacheEl) {
          cacheEl.textContent = `${TelegramFeedService?.analyzedCache?.size || 0} записів`;
        }
        if (notify) showToast('Режим: Клієнтський аналітичний NLP');
      }
    } catch (e) {
      if (notify) showToast('Помилка перевірки статусу ШІ');
    }
  },

  async runInteractiveTest() {
    const inputEl = document.getElementById('ai-test-input');
    const outEl   = document.getElementById('ai-test-output');
    if (!inputEl || !outEl) return;
    const text = inputEl.value.trim();
    if (!text) {
      showToast('Введіть текст повідомлення для тесту');
      return;
    }

    outEl.classList.remove('hidden');
    outEl.innerHTML = '<span class="text-purple-300 animate-pulse font-mono text-xs">Виконується аналіз моделі...</span>';

    try {
      const start = performance.now();
      let analysis = null;

      try {
        const res = await fetch('/api/v1/analyze-message', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            message:             { text, date: new Date().toISOString() },
            followedTerritories: Array.from(FollowManager.followedSet)
          })
        }).catch(() => null);

        if (res && res.ok) {
          const data = await res.json().catch(() => null);
          if (data && data.analysis) analysis = data.analysis;
        }
      } catch (e) {}

      if (!analysis) {
        analysis = analyzeWithLocalNlp(text, Array.from(FollowManager.followedSet));
      }

      const latency = Math.round(performance.now() - start);

      const latEl = document.getElementById('ai-latency-val');
      if (latEl) latEl.textContent = `${latency} ms`;

      if (analysis) {
        const a = analysis;
        const isThreat = a.category === 'active_threat';
        const isMvmt   = a.category === 'possible_threat';
        const catBadge = isThreat ? 'ПРЯМА ЗАГРОЗА' : (isMvmt ? 'МОЖЛИВА ЗАГРОЗА' : 'ОБСТАНОВКА');

        outEl.innerHTML = `
          <div class="text-xs text-purple-200 pb-1 border-b border-purple-500/20 flex justify-between">
            <span>Категорія: <b>${catBadge}</b></span>
            <span class="text-gray-400">Затримка: ${latency} ms</span>
          </div>
          <div class="text-[11px] text-gray-300"><b>Території:</b> ${a.territories && a.territories.length ? a.territories.join(', ') : 'Не виявлено'}</div>
          <div class="text-[11px] text-purple-200"><b>Висновки:</b> ${escapeHtml(a.summary || '')}</div>
          <div class="text-[10px] text-gray-400 font-mono">Впевненість: ${Math.round((a.confidence || 0.9) * 100)}% | Рушій: ${a.engine || 'client-local-nlp'}</div>
        `;
      } else {
        outEl.innerHTML = '<span class="text-red-400">Помилка обробки повідомлення</span>';
      }
    } catch (e) {
      outEl.innerHTML = `<span class="text-red-400">Помилка: ${escapeHtml(e.message)}</span>`;
    }
  },

  render() {
    const s = StorageManager.getSettings();
    this.updateEnabledState();
    if (!s.aiEnabled) return;
    this.renderFeed();
  },

  renderFeed() {
    const container = document.getElementById('ai-analysis-feed');
    if (!container) return;

    const all = TelegramFeedService.notifications.filter(n => n.analysis);

    let countThreats = 0, countMovements = 0;
    all.forEach(n => {
      if (n.analysis.category === 'active_threat') countThreats++;
      else if (n.analysis.category === 'possible_threat') countMovements++;
    });

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    setVal('ai-stat-analyzed', TelegramFeedService.analyzedCache.size || all.length);
    setVal('ai-stat-threats', countThreats);
    setVal('ai-count-all', all.length);
    setVal('ai-count-threats', countThreats);
    setVal('ai-count-movements', countMovements);

    let filtered = all;

    if (this.activeCategory === 'threats') {
      filtered = filtered.filter(n => n.analysis.category === 'active_threat');
    } else if (this.activeCategory === 'movements') {
      filtered = filtered.filter(n => n.analysis.category === 'possible_threat');
    }

    const s = StorageManager.getSettings();
    if (s.aiRegions === 'followed' && FollowManager.followedSet.size > 0) {
      filtered = filtered.filter(n => TelegramFeedService.isFollowedNotification(n));
    } else if (State.selectedRegion && State.selectedRegion !== 'all') {
      filtered = filtered.filter(n => TelegramFeedService.matchesRegion(n));
    }

    if (this.searchQuery) {
      const q = this.searchQuery;
      filtered = filtered.filter(n => {
        const text        = (n.message || '').toLowerCase();
        const summary     = (n.analysis?.summary || '').toLowerCase();
        const territories = (n.analysis?.territories || []).join(' ').toLowerCase();
        return text.includes(q) || summary.includes(q) || territories.includes(q);
      });
    }

    // Сортування: найновіші спочатку
    filtered.sort((a, b) => {
      const ta = new Date(a.eventTime || a.receivedAt).getTime();
      const tb = new Date(b.eventTime || b.receivedAt).getTime();
      return tb - ta;
    });

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="text-center py-20 text-gray-400">
          <div class="w-12 h-12 mx-auto mb-2 text-purple-400/60 flex items-center justify-center rounded-full bg-purple-500/10 border border-purple-500/20">
            <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
          </div>
          <p class="text-sm font-semibold text-gray-200">Аналітичних карток не знайдено</p>
          <p class="text-xs text-gray-400 mt-1">Змініть фільтр категорій або очистіть критерій пошуку</p>
        </div>`;
      return;
    }

    container.innerHTML = filtered.map(n => this.renderAiCard(n)).join('');
  },

  renderAiCard(n) {
    const a = n.analysis;
    const isThreat = a.category === 'active_threat';
    const isMovement = a.category === 'possible_threat';
    const borderCol = isThreat ? 'border-red-500/40 hover:border-red-500/80' : (isMovement ? 'border-amber-500/40 hover:border-amber-500/80' : 'border-purple-500/30 hover:border-purple-500/60');
    const badgeText = isThreat ? 'ПРЯМА ЗАГРОЗА' : (isMovement ? 'МОЖЛИВА ЗАГРОЗА' : 'ОБСТАНОВКА');
    const badgeBg = isThreat ? 'bg-red-500/20 text-red-300 border-red-500/30' : (isMovement ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' : 'bg-sky-500/20 text-sky-300 border-sky-500/30');

    // Вимога п.11: AI не має вигадувати — якщо територія не вказана, виводимо "Не вказано у джерелі"
    const territories = (a.territories && a.territories.length)
      ? a.territories.map(t => 
          `<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-white/10 text-gray-200 border border-white/15">${escapeHtml(t)}</span>`
        ).join(' ')
      : '<span class="text-[10px] text-gray-400 font-mono italic">Територія: Не вказано у джерелі</span>';

    const timeStr = n.eventTime ? formatApiDate(n.eventTime) : (n.receivedAt ? formatApiDate(n.receivedAt) : '');
    const firstTerritory = (a.territories && a.territories[0]) || n.territory || '';

    return `
      <article class="ai-analysis-card ${borderCol}">
        <div class="flex items-center justify-between pb-2 mb-2 border-b border-white/10">
          <div class="flex items-center gap-2">
            <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${badgeBg}">${badgeText}</span>
            <span class="text-xs font-semibold text-gray-200">${escapeHtml(n.title || 'Оперативне зведення')}</span>
          </div>
          <span class="text-[10px] font-mono text-gray-400">${timeStr}</span>
        </div>

        <div class="mb-2">
          <p class="text-xs text-purple-200 font-medium leading-relaxed">${escapeHtml(a.summary || '')}</p>
        </div>

        <div class="px-2 py-1 rounded bg-purple-950/40 border border-purple-500/30 text-[10px] text-purple-300 font-mono flex items-center gap-1.5 mb-2">
          <span class="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse"></span>
          <span>Прогноз ШІ, не офіційний час завершення</span>
        </div>

        <div class="flex flex-wrap items-center gap-1.5 mb-2.5">
          ${territories}
        </div>

        <!-- Обов'язкове збереження оригінального тексту повідомлення (Вимога п.10) -->
        <div class="p-2.5 rounded-lg bg-black/50 border border-white/10 text-[11px] text-gray-300 font-sans leading-relaxed mb-2">
          <div class="text-[9px] uppercase font-bold text-gray-400 mb-1 font-mono">Оригінальне повідомлення:</div>
          «${escapeHtml(n.message || '')}»
        </div>

        <div class="flex items-center justify-between pt-1.5 border-t border-white/5 text-[10px] text-gray-400 font-mono">
          <span class="flex items-center gap-1">
            <span>Рушій:</span> <b>${a.engine === 'gemini' ? 'Gemini Free Tier' : 'Локальний NLP'}</b> | Впевненість: <b>${Math.round((a.confidence || 0.9) * 100)}%</b>
          </span>
          <div class="flex items-center gap-2">
            <span class="text-[9px] text-gray-500 hidden sm:inline">ШІ не замінює дані NEPTUN</span>
            ${firstTerritory ? `
              <button class="px-2 py-1 rounded bg-purple-600/30 hover:bg-purple-600/60 text-purple-200 border border-purple-400/40 text-[10px] font-mono font-semibold transition-colors" onclick="NavigationController.switchTab('map'); MapService.flyToRegion('${escapeHtml(firstTerritory)}');">
                На карті
              </button>` : ''}
          </div>
        </div>
      </article>`;
  }
};

/* ============================================================
   ФАБРИКА 2D-МОДЕЛЕЙ ЦІЛЕЙ (SvgIconFactory)
   Категорично заборонено: трикутники, стрілки, емодзі, chevrons, pin.
   Справжні 2D тактичні силуети військових об'єктів з тонкою лінією курсу.
============================================================ */
const SvgIconFactory = {
  createThreatIcon(type, heading, areaOnly = false) {
    const color = getThreatColor(type);
    const hasHeading = heading != null && Number.isFinite(Number(heading)) && !areaOnly;
    const rot = hasHeading ? Number(heading) : 0;

    if (areaOnly) {
      // Маркер для areaOnly: true (без емодзі та без стрілок! Тактичний ретикул орієнтовної зони)
      const html = `
        <div class="area-reticle-animated" style="width:48px;height:48px;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 0 6px ${color});">
          <svg viewBox="-24 -24 48 48" width="46" height="46" style="overflow:visible;">
            <circle cx="0" cy="0" r="20" stroke="${color}" stroke-width="1.8" stroke-dasharray="4 3" opacity="0.85" fill="none"/>
            <circle cx="0" cy="0" r="11" stroke="${color}" stroke-width="1.2" fill="rgba(245, 158, 11, 0.18)"/>
            <line x1="0" y1="-22" x2="0" y2="-13" stroke="${color}" stroke-width="2"/>
            <line x1="0" y1="13" x2="0" y2="22" stroke="${color}" stroke-width="2"/>
            <line x1="-22" y1="0" x2="-13" y2="0" stroke="${color}" stroke-width="2"/>
            <line x1="13" y1="0" x2="22" y2="0" stroke="${color}" stroke-width="2"/>
            <circle cx="0" cy="0" r="3" fill="${color}"/>
          </svg>
        </div>`;
      return L.divIcon({ html, className: 'radar-svg-marker', iconSize: [48, 48], iconAnchor: [24, 24], popupAnchor: [0, -24] });
    }

    let svgModel = '';
    const t = String(type || '').toLowerCase();

    if (t === 'drone' || t === 'shahed' || t === 'fpv') {
      // 1. Ударний БПЛА / Shahed-136 (реалістична 2D-модель дельтоподібного крила з вінглетами)
      svgModel = `
        <g id="shahed-model">
          <polygon points="0,-18 24,14 16,14 6,11 6,15 -6,15 -6,11 -16,14 -24,14" fill="#0f172a" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
          <polygon points="-24,15 -24,2 -26,3 -26,16" fill="${color}"/>
          <polygon points="24,15 24,2 26,3 26,16" fill="${color}"/>
          <path d="M-2.5,-16 L2.5,-16 L4,10 L-4,10 Z" fill="#1e293b" stroke="${color}" stroke-width="1.2"/>
          <line x1="0" y1="-14" x2="0" y2="8" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round"/>
          <circle cx="0" cy="14" r="2.5" fill="${color}"/>
          <line x1="-5" y1="16" x2="5" y2="16" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
        </g>`;
    } else if (t === 'missile' || t === 'cruise') {
      // 2. Крилата ракета (Х-101 / Калібр / Р-360 Нептун)
      svgModel = `
        <g id="cruise-missile-model">
          <path d="M0,-25 C3,-18 3,-10 3,18 L-3,18 C-3,-10 -3,-18 0,-25 Z" fill="#0f172a" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
          <polygon points="-3,-2 -25,2 -25,5 -3,3" fill="#1e293b" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
          <polygon points="3,-2 25,2 25,5 3,3" fill="#1e293b" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
          <polygon points="-3,14 -13,19 -13,22 -3,20" fill="${color}"/>
          <polygon points="3,14 13,19 13,22 3,20" fill="${color}"/>
          <line x1="0" y1="18" x2="0" y2="23" stroke="${color}" stroke-width="2"/>
          <circle cx="0" cy="-18" r="1.5" fill="#ffffff"/>
          <ellipse cx="0" cy="8" rx="2" ry="3" fill="#1e293b" stroke="${color}" stroke-width="1"/>
          <circle cx="0" cy="20" r="2" fill="#ef4444"/>
        </g>`;
    } else if (t === 'ballistic') {
      // 3. Балістична ракета (Іскандер-М / Кинджал / Циркон)
      svgModel = `
        <g id="ballistic-missile-model">
          <polygon points="0,-25 5,-8 4.5,18 -4.5,18 -5,-8" fill="#0f172a" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>
          <polygon points="-4.5,10 -17,21 -17,23 -4.5,20" fill="${color}"/>
          <polygon points="4.5,10 17,21 17,23 4.5,20" fill="${color}"/>
          <line x1="-4.5" y1="4" x2="4.5" y2="4" stroke="${color}" stroke-width="1.2"/>
          <line x1="0" y1="-20" x2="0" y2="15" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
          <polygon points="-3,19 0,27 3,19" fill="#f43f5e"/>
          <circle cx="0" cy="18" r="2" fill="#fbbf24"/>
        </g>`;
    } else if (t === 'recon' || t === 'uav') {
      // 4. Розвідувальний БПЛА (Орлан / Zala / Supercam)
      svgModel = `
        <g id="recon-uav-model">
          <path d="M-27,-2 L0,-4 L27,-2 L27,2 L0,0 L-27,2 Z" fill="#0f172a" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
          <ellipse cx="0" cy="0" rx="3.5" ry="14" fill="#1e293b" stroke="${color}" stroke-width="1.8"/>
          <line x1="-9" y1="0" x2="-9" y2="18" stroke="${color}" stroke-width="1.8"/>
          <line x1="9" y1="0" x2="9" y2="18" stroke="${color}" stroke-width="1.8"/>
          <line x1="-12" y1="18" x2="12" y2="18" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
          <circle cx="0" cy="-9" r="2.8" fill="#ffffff" stroke="${color}" stroke-width="1.2"/>
          <circle cx="0" cy="-9" r="1.2" fill="#0284c7"/>
        </g>`;
    } else {
      // 5. Нейтральна 2D-модель контакту (НЕ стрілка, НЕ трикутник)
      svgModel = `
        <g id="neutral-contact-model">
          <polygon points="0,-22 4,-10 18,6 18,10 4,8 3,18 8,22 -8,22 -3,18 -4,8 -18,10 -18,6 -4,-10" fill="#0f172a" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
          <line x1="0" y1="-18" x2="0" y2="16" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round"/>
          <circle cx="0" cy="0" r="3" fill="${color}"/>
        </g>`;
    }

    // Тонка передня напрямна польоту (Flight Vector Leader Line)
    // Рендериться ТІЛЬКИ коли API надав достовірний курс! Без фейків!
    let leaderLine = '';
    if (hasHeading) {
      leaderLine = `
        <g id="flight-vector-leader">
          <line x1="0" y1="-26" x2="0" y2="-52" stroke="${color}" stroke-width="1.5" class="threat-leader-line"/>
          <circle cx="0" cy="-52" r="2" fill="${color}"/>
        </g>`;
    }

    const transformStyle = hasHeading ? `transform:rotate(${rot}deg);` : '';

    const html = `
      <div class="threat-marker-animated" style="width:56px;height:56px;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 0 6px ${color});">
        <div class="radar-target-rotator" style="${transformStyle}transform-origin:center;display:flex;align-items:center;justify-content:center;width:100%;height:100%;transition:transform 0.6s ease-out;">
          <svg viewBox="-32 -56 64 88" width="56" height="77" style="overflow:visible;">
            ${leaderLine}
            ${svgModel}
          </svg>
        </div>
      </div>`;

    return L.divIcon({ html, className: 'radar-svg-marker', iconSize: [56, 56], iconAnchor: [28, 28], popupAnchor: [0, -28] });
  }
};

function showToast(message, isUrgent = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className   = isUrgent ? 'radar-toast urgent-toast font-mono' : 'radar-toast font-mono';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.4s ease'; setTimeout(() => toast.remove(), 400); }, isUrgent ? 5500 : 4000);
}

/* ============================================================
   СТАРТ СИСТЕМИ
============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  NotificationManager.init();
  NotificationDispatcher.init();
  SoundService.init();
  PersonalDangerService.init();
  FollowManager.init();
  NavigationController.init();
  AlertsService.init();
  await TelegramFeedService.init();
  AIService.init();
  await TerritoriesManager.load();
  await MapService.init();
  UIController.init();
  console.log('[РАДАР] Realtime WebSocket (wss://neptun.in.ua/api/v1/stream) + Telegram + LLM модуль активовано!');
});
