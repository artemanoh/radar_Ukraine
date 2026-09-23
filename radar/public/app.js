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
 * 7. Чітке візуальне розділення: 🔴 Офіційна тривога vs 📰 Інформаційне повідомлення.
 * 8. Обробка areaOnly: true для загроз (орієнтовний район, без вигаданих курсів).
 * 9. Налаштування сповіщень (офіційні тривоги, інформаційні повідомлення, звук, нічний режим).
 * 10. Чисте UTF-8 декодування з автоматичним виправленням Windows-1251 mojibake.
 */

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
  selectedRegion:'all'
};

const previousAlertSnapshot  = new Map(); // uniqueKey -> { level, status, since, name }
const previousThreatSnapshot = new Map(); // id -> { type, status }
const seenMessageKeys        = new Set();

let isInitialLoad = true;

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

      result.raions.set(normName, {
        key,
        name:    item.name || rawName,
        oblast:  item.oblast || item.region || '',
        since,
        level,
        reasons,
        type:    'raion'
      });
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
    const s = StorageManager.getSettings();
    const timeStr = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

    // 1. Відбої тривог
    for (const item of removed) {
      TelegramFeedService.addAlertNotification(item, true);

      if (!isInitialLoad) {
        const place = item.name;
        const isFollowed = FollowManager.matchesFollowed(place) || (item.oblast && FollowManager.matchesFollowed(item.oblast));

        if (isFollowed && s.officialAlertsEnabled) {
          SoundService.playAlertSiren();
          NotificationManager.send(`✅ ВІДБІЙ ТРИВОГИ: ${place}`, 'Повітряний простір спокійний');
          showToast(`✅ Відбій тривоги: ${place}`);
        }

        FeedService.addEvent({
          time:   timeStr,
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
      const icon = isYellow ? '🟡' : '🔴';
      const levelTitle = isYellow ? 'зафіксовано офіційний жовтий рівень' : 'оголошено повітряну тривогу';

      const isFollowed = FollowManager.matchesFollowed(place) || (item.oblast && FollowManager.matchesFollowed(item.oblast));

      // Завжди реєструємо сповіщення в універсальному хабі сповіщень
      TelegramFeedService.addAlertNotification(item, false);

      const exactStartTime = item.since ? new Date(item.since).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : timeStr;

      if (isInitialLoad) {
        // Початкове завантаження: тихо додаємо в історію, без звуку та спаму
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
        if (isFollowed && s.officialAlertsEnabled) {
          SoundService.playAlertSiren();
          NotificationManager.send(`${icon} ${place}: ${levelTitle}`, item.reasons?.join(', ') || `Офіційний рівень [${lvlUpper}]`);
          showToast(`${icon} ${place}: ${levelTitle} [${lvlUpper}]`);
        }

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
      TelegramFeedService.addAlertNotification(unit, false);

      if (!isInitialLoad) {
        const place = unit.name;
        const newLvl = (unit.level || '').toUpperCase();
        const isFollowed = FollowManager.matchesFollowed(place) || (unit.oblast && FollowManager.matchesFollowed(unit.oblast));

        if (isFollowed && s.officialAlertsEnabled) {
          SoundService.playAlertSiren();
          NotificationManager.send(`⚠️ Зміна рівня тривоги: ${place}`, `${prev.level.toUpperCase()} → ${newLvl}`);
          showToast(`⚠️ ${place}: зміна рівня на ${newLvl}`);
        }

        FeedService.addEvent({
          time:   unit.since ? new Date(unit.since).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : timeStr,
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

    for (const t of added) {
      TelegramFeedService.addThreatNotification(t, false);
    }
    for (const t of removed) {
      TelegramFeedService.addThreatNotification(t, true);
    }

    if (!isInitialLoad) {
      const s = StorageManager.getSettings();
      const timeStr = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

      for (const t of added) {
        const typeLabel = (t.title || t.type || 'Ціль').toUpperCase();
        const place     = t.locality ? `${t.locality}, ${t.region}` : (t.district || t.region || 'Україна');
        const isFollowed = FollowManager.matchesFollowed(t.region) || (t.district && FollowManager.matchesFollowed(t.district));

        if (isFollowed && s.threatsAlertsEnabled) {
          SoundService.playInfoChime();
          NotificationManager.send(`🟠 ЗАГРОЗА (${typeLabel})`, place);
          showToast(`🟠 Загроза: ${typeLabel} (${place})`);
        }

        FeedService.addEvent({
          time:   t.time || timeStr,
          type:   t.type || 'drone',
          title:  place,
          status: 'АКТИВНА',
          desc:   t.explanation || `Виявлено ціль (${typeLabel})`,
          isOfficial: false
        });
      }

      for (const t of removed) {
        FeedService.addEvent({
          time:   timeStr,
          type:   'clear',
          title:  'Ціль зникла',
          status: 'ЛІКВІДОВАНО',
          desc:   `Ціль (${(t.type || '').toUpperCase()}) більше не спостерігається`,
          isOfficial: false
        });
      }
    }
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

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (e) {
      console.warn('[RealtimeClient] Помилка створення WebSocket, запуск REST fallback:', e.message);
      this.startRestFallback();
      return;
    }

    this.ws.onopen = () => {
      console.info('⚡ [NEPTUN WS] Підключено до wss://neptun.in.ua/api/v1/stream');
      this.isWsConnected = true;
      this.reconnectAttempts = 0;
      this.stopRestFallback();
      this.updateStatusUI(true, 'WS REALTIME');
      document.getElementById('connection-warning-banner')?.classList.add('hidden');
    };

    this.ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        this.handleFrame(frame);
      } catch (err) {
        console.warn('[NEPTUN WS] Помилка парсингу фрейму:', err);
      }
    };

    this.ws.onclose = (event) => {
      console.warn(`[NEPTUN WS] Зв'язок розірвано (код: ${event.code}). Запуск REST fallback...`);
      this.isWsConnected = false;
      this.updateStatusUI(false, 'REST FALLBACK');
      this.startRestFallback();
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.warn('[NEPTUN WS] Помилка з\'єднання WebSocket');
      this.ws?.close();
    };
  },

  handleFrame(frame) {
    if (!frame || !frame.type) return;

    switch (frame.type) {
      case 'heartbeat':
        State.lastSyncTime = new Date().toLocaleTimeString('uk-UA');
        this.updateStatusUI(true, 'WS REALTIME');
        break;

      case 'snapshot':
        if (frame.data) {
          const threatsMap = NeptunParser.parseThreats(frame.data);
          ChangeDetector.applyThreats(threatsMap);
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
          }
        }
        break;

      case 'remove':
        const removeId = frame.data?.id || (typeof frame.data === 'string' ? frame.data : null);
        if (removeId) {
          State.threats.delete(removeId);
          MapService.removeThreat(removeId);
          UIController.updateCounters();
        }
        break;

      case 'alerts':
        if (frame.data) {
          const parsedAlerts = NeptunParser.parseAlerts(frame.data);
          ChangeDetector.applyAlerts(parsedAlerts);
          if (isInitialLoad) {
            isInitialLoad = false;
            UIController.hideLoading();
          }
        }
        break;

      default:
        console.debug('[NEPTUN WS] Невідомий тип фрейму:', frame.type);
    }
  },

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  },

  startRestFallback() {
    if (this.fallbackPollingTimer) return;
    console.info('🔄 [REST FALLBACK] Активовано резервне 5-секундне опитування');
    PollingService.poll();
    this.fallbackPollingTimer = setInterval(() => {
      PollingService.poll();
    }, 5000);
  },

  stopRestFallback() {
    if (this.fallbackPollingTimer) {
      clearInterval(this.fallbackPollingTimer);
      this.fallbackPollingTimer = null;
      console.info('🛑 [REST FALLBACK] Зупинено — WebSocket активний');
    }
  },

  updateStatusUI(isOk, modeLabel) {
    const dot   = document.getElementById('conn-dot');
    const label = document.getElementById('conn-label');
    const sub   = document.getElementById('conn-sublabel');

    if (isOk) {
      if (dot)   dot.className   = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
      if (label) { label.className = 'text-emerald-400 font-bold leading-tight'; label.textContent = `● ${modeLabel}`; }
      if (sub)   sub.textContent = `Синхронізовано: ${State.lastSyncTime || '--:--:--'}`;
    } else {
      if (dot)   dot.className   = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
      if (label) { label.className = 'text-amber-400 font-bold leading-tight'; label.textContent = `⚡ ${modeLabel}`; }
      if (sub)   sub.textContent = `Резервне опитування`;
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
      const [rawAlerts, rawThreats] = await Promise.all([
        fetchUtf8Json('/api/v1/alerts'),
        fetchUtf8Json('/api/v1/threats')
      ]);

      const parsedAlerts  = NeptunParser.parseAlerts(rawAlerts);
      const parsedThreats = NeptunParser.parseThreats(rawThreats);

      ChangeDetector.applyAlerts(parsedAlerts);
      ChangeDetector.applyThreats(parsedThreats);

      if (isInitialLoad) {
        isInitialLoad = false;
        UIController.hideLoading();
      }

      State.lastSyncTime  = new Date().toLocaleTimeString('uk-UA');
      State.lastSyncError = null;
    } catch (err) {
      State.lastSyncError = err.message;
      console.error('[REST FALLBACK] Помилка запиту:', err.message);
    } finally {
      this._inflight = false;
      UIController.updateCounters();
      FeedService.render();
      if (MapService.currentSelectedLayer) {
        MapService.refreshSelectedDistrictPopup();
      }
    }
  }
};

/* ============================================================
   8. MESSAGES SERVICE & NOTIFICATIONS HUB (ВКЛАДКА СПОВІЩЕННЯ + LLM)
============================================================ */
const NOTIFICATIONS_STORAGE_KEY = 'radar_notifications_history_v3';

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

  addAlertNotification(item, isRemoved = false) {
    if (!item) return;
    const name = item.name || item.oblast || 'Україна';
    const lvl = (item.level || 'red').toLowerCase();
    const lvlUpper = lvl.toUpperCase();

    // Унікальний стабільний ідентифікатор події
    const id = isRemoved
      ? `alert_clear_${item.key || name}_${item.since || Date.now()}`
      : `alert_active_${item.key || name}_${item.since || 'init'}`;

    const existingIdx = this.notifications.findIndex(n => n.id === id);

    const notif = {
      id,
      type:       'alert',
      territory:  name,
      title:      name,
      message:    isRemoved
        ? `Відбій повітряної тривоги в ${name}`
        : (item.reasons && item.reasons.length ? item.reasons.join(', ') : `Офіційний рівень [${lvlUpper}]`),
      // Точний API timestamp початку тривоги (Section 53: NEVER Date.now() якщо є since)
      eventTime:  isRemoved ? (item.since || null) : (item.since || item.started_at || null),
      receivedAt: new Date().toISOString(),
      source:     'neptun_alerts',
      sourceId:   item.key || name,
      level:      item.level || 'red',
      status:     isRemoved ? 'ВІДБІЙ' : lvlUpper
    };

    if (existingIdx >= 0) {
      this.notifications[existingIdx] = notif;
    } else {
      this.notifications.unshift(notif);
      if (this.notifications.length > 250) this.notifications.pop();
    }

    this.saveNotifications();
    this.updateCounters();
    if (NavigationController.currentTab === 'telegram') {
      this.render();
    }
  },

  addThreatNotification(threat, isRemoved = false) {
    if (!threat) return;
    const place = threat.locality ? `${threat.locality}, ${threat.region}` : (threat.district || threat.region || 'Україна');
    const typeLabel = (threat.title || threat.type || 'Ціль').toUpperCase();

    const id = isRemoved
      ? `threat_clear_${threat.id}_${Date.now()}`
      : `threat_active_${threat.id}_${threat.time || threat.updatedAt || ''}`;

    const existingIdx = this.notifications.findIndex(n => n.id === id);

    const notif = {
      id,
      type:       'threat',
      territory:  place,
      title:      `Загроза: ${typeLabel}`,
      message:    isRemoved
        ? `Ціль (${typeLabel}) більше не спостерігається`
        : (threat.explanation || `Виявлено повітряну ціль (${typeLabel})`),
      // Точний timestamp загрози з API
      eventTime:  threat.time || threat.updatedAt || threat.timestamp || null,
      receivedAt: new Date().toISOString(),
      source:     'neptun_threats',
      sourceId:   threat.id,
      subtype:    threat.type || 'drone',
      status:     isRemoved ? 'ЛІКВІДОВАНО' : 'АКТИВНА'
    };

    if (existingIdx >= 0) {
      this.notifications[existingIdx] = notif;
    } else {
      this.notifications.unshift(notif);
      if (this.notifications.length > 250) this.notifications.pop();
    }

    this.saveNotifications();
    this.updateCounters();
    if (NavigationController.currentTab === 'telegram') {
      this.render();
    }
  },

  bindEvents() {
    const btnAll      = document.getElementById('tg-btn-filter-all');
    const btnAlerts   = document.getElementById('tg-btn-filter-alerts');
    const btnThreats  = document.getElementById('tg-btn-filter-threats');
    const btnMessages = document.getElementById('tg-btn-filter-messages');
    const btnFollowed = document.getElementById('tg-btn-filter-followed');
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
    btnAlerts?.addEventListener('click',   () => setFilter('alerts', btnAlerts));
    btnThreats?.addEventListener('click',  () => setFilter('threats', btnThreats));
    btnMessages?.addEventListener('click', () => setFilter('messages', btnMessages));
    btnFollowed?.addEventListener('click', () => setFilter('followed', btnFollowed));

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

    document.getElementById('tg-btn-reset-region')?.addEventListener('click', () => {
      State.selectedRegion = 'all';
      const sel = document.getElementById('select-region');
      if (sel) sel.value = 'all';
      this.render();
      AIService?.render();
      showToast('Фільтр території скинуто: Вся Україна');
    });
  },

  async fetchLlmStatus() {
    try {
      const res = await fetchUtf8Json('/api/v1/llm-status');
      if (res && res.status === 'ok') {
        this.llmEngine = res.engine;
        this.hasApiKey = res.hasApiKey;
        const badge = document.getElementById('tg-llm-badge-text');
        if (badge) {
          badge.textContent = res.hasApiKey ? 'LLM: Gemini 1.5 Flash' : 'LLM: Локальний NLP';
        }
      }
    } catch (e) {}
  },

  async handleIncomingMessages(messagesList, newMessages = []) {
    if (!Array.isArray(messagesList)) return;
    this.allMessages = messagesList;

    const followedList = Array.from(FollowManager.followedSet);

    for (const msg of messagesList) {
      const key = msg.id || `${msg.channel || ''}::${msg.date || ''}::${(msg.text || '').slice(0, 40)}`;
      const existingNotif = this.notifications.find(n => n.id === `msg_${key}` || n.sourceId === msg.id);

      if (!existingNotif) {
        const notif = {
          id:         `msg_${key}`,
          type:       'message',
          territory:  '',
          title:      msg.channel || 'Telegram',
          message:    msg.text || '',
          eventTime:  msg.date || null, // Точний час з API
          receivedAt: new Date().toISOString(),
          source:     msg.channel || 'Telegram',
          sourceId:   msg.id || key,
          rawMsg:     msg
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
      this.render();
    } else if (NavigationController.currentTab === 'ai') {
      AIService?.render();
    }
  },

  async analyzeMessageAsync(msg, followedList) {
    const s = StorageManager.getSettings();
    if (s.llmAnalysisEnabled === false) return;
    const key = msg.id || `${msg.channel || ''}::${msg.date || ''}::${(msg.text || '').slice(0, 40)}`;
    if (this.analyzedCache.has(key)) return;

    try {
      const res = await fetch('/api/v1/analyze-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, followedTerritories: followedList })
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.analysis) {
          this.analyzedCache.set(key, data.analysis);
          msg._analysis = data.analysis;

          // Оновлюємо сповіщення аналітикою LLM
          const notif = this.notifications.find(n => n.id === `msg_${key}` || n.sourceId === msg.id);
          if (notif) {
            notif.analysis = {
              ...data.analysis,
              analyzedAt: new Date().toISOString()
            };
            if (data.analysis.territories && data.analysis.territories.length) {
              notif.territory = data.analysis.territories.join(', ');
            }
            this.saveNotifications();
          }

          const s = StorageManager.getSettings();
          if (data.analysis.relevant && s.llmAnalysisEnabled && !isInitialLoad) {
            if (data.analysis.category === 'active_threat' || data.analysis.category === 'possible_threat') {
              SoundService.playInfoChime();
              NotificationManager.send(`🟡 LLM [${data.analysis.territories.join(', ')}]`, data.analysis.summary);
            }
          }

          if (NavigationController.currentTab === 'telegram') {
            this.render();
          } else if (NavigationController.currentTab === 'ai') {
            AIService?.render();
          }
        }
      }
    } catch (e) {}
  },

  updateCounters() {
    const total = this.notifications.length;
    let alertCount = 0, threatCount = 0, msgCount = 0, followedCount = 0;

    for (const n of this.notifications) {
      if (n.type === 'alert') alertCount++;
      else if (n.type === 'threat') threatCount++;
      else if (n.type === 'message') msgCount++;

      if (this.isFollowedNotification(n)) followedCount++;
    }

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    set('tg-count-all', total);
    set('tg-count-alerts', alertCount);
    set('tg-count-threats', threatCount);
    set('tg-count-messages', msgCount);
    set('tg-count-followed', followedCount);

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

  matchesRegion(n) {
    if (!State.selectedRegion || State.selectedRegion === 'all') return true;
    const sel = State.selectedRegion.toLowerCase();
    
    // Прямий збіг у territory
    const t = (n.territory || '').toLowerCase();
    if (t.includes(sel) || sel.includes(t)) return true;

    // Перевірка в заголовку або тексті
    const title = (n.title || '').toLowerCase();
    const msg = (n.message || '').toLowerCase();
    if (title.includes(sel) || msg.includes(sel)) return true;

    // Перевірка районів та міст обраної області через TerritoriesManager
    if (TerritoriesManager && TerritoriesManager.oblastDistrictsMap) {
      const districts = TerritoriesManager.oblastDistrictsMap[State.selectedRegion] || [];
      for (const d of districts) {
        const dl = d.toLowerCase();
        if (t.includes(dl) || msg.includes(dl)) return true;
      }
      const cities = TerritoriesManager.oblastCitiesMap[State.selectedRegion] || [];
      for (const c of cities) {
        const cl = c.toLowerCase();
        if (t.includes(cl) || msg.includes(cl)) return true;
      }
    }

    // Перевірка результатів аналізу LLM
    if (n.analysis && Array.isArray(n.analysis.territories)) {
      for (const at of n.analysis.territories) {
        const atl = at.toLowerCase();
        if (atl.includes(sel) || sel.includes(atl)) return true;
        if (TerritoriesManager && TerritoriesManager.oblastDistrictsMap) {
          const districts = TerritoriesManager.oblastDistrictsMap[State.selectedRegion] || [];
          if (districts.some(d => d.toLowerCase().includes(atl) || atl.includes(d.toLowerCase()))) return true;
        }
      }
    }

    return false;
  },

  isFollowedNotification(n) {
    if (FollowManager.followedSet.size === 0) return true;
    const t = (n.territory || '').toLowerCase();
    const title = (n.title || '').toLowerCase();
    const msg = (n.message || '').toLowerCase();

    for (const f of FollowManager.followedSet) {
      const fl = f.toLowerCase();
      if (t.includes(fl) || title.includes(fl) || msg.includes(fl)) return true;
      if (fl.includes('вінниц') && (t.includes('вінниц') || msg.includes('вінниц') || msg.includes('жмеринк') || msg.includes('хмільник') || msg.includes('гайсин') || msg.includes('тульчин') || msg.includes('могилів') || msg.includes('бар') || msg.includes('козятин'))) return true;
      if (fl.includes('київ') && (t.includes('київ') || msg.includes('київ'))) return true;
      if (fl.includes('крим') && (t.includes('крим') || msg.includes('крим'))) return true;
      if (fl.includes('севастополь') && (t.includes('севастополь') || msg.includes('севастополь'))) return true;
    }
    if (n.analysis && n.analysis.relevant) return true;
    return false;
  },

  render() {
    const container = document.getElementById('tg-messages-list');
    if (!container) return;

    // Синхронізація індикатора обраного регіону
    const regionBadgeText = document.getElementById('tg-region-badge-text');
    const resetBtn = document.getElementById('tg-btn-reset-region');
    if (regionBadgeText) {
      if (State.selectedRegion && State.selectedRegion !== 'all') {
        regionBadgeText.textContent = `Регіон: ${State.selectedRegion}`;
        resetBtn?.classList.remove('hidden');
      } else {
        regionBadgeText.textContent = 'Регіон: Вся Україна';
        resetBtn?.classList.add('hidden');
      }
    }

    let filtered = this.notifications;

    // 1. Строга прив'язка до обраного регіону (Section 53 & Telegram binding)
    if (State.selectedRegion && State.selectedRegion !== 'all') {
      filtered = filtered.filter(n => this.matchesRegion(n));
    }

    // 2. Фільтр за категорією
    if (this.filterMode === 'alerts') {
      filtered = filtered.filter(n => n.type === 'alert');
    } else if (this.filterMode === 'threats') {
      filtered = filtered.filter(n => n.type === 'threat');
    } else if (this.filterMode === 'messages') {
      filtered = filtered.filter(n => n.type === 'message');
    } else if (this.filterMode === 'followed') {
      filtered = filtered.filter(n => this.isFollowedNotification(n));
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
          <div class="w-12 h-12 mx-auto mb-2 text-sky-400/60 flex items-center justify-center rounded-full bg-sky-500/10 border border-sky-500/20 text-xl font-bold">
            🔔
          </div>
          <p class="text-sm font-semibold text-gray-200">Сповіщень не знайдено</p>
          <p class="text-xs text-gray-400 mt-1">${State.selectedRegion && State.selectedRegion !== 'all' ? `Немає сповіщень для території: <b>${escapeHtml(State.selectedRegion)}</b>. Натисніть ✕ поруч із назвою, щоб переглянути всі регіони.` : 'Змініть фільтр або очистіть критерій пошуку'}</p>
        </div>`;
      return;
    }

    container.innerHTML = filtered.map(n => this.renderNotificationCard(n)).join('');
  },

  renderNotificationCard(n) {
    if (n.type === 'alert') {
      const isClear = n.status === 'ВІДБІЙ';
      const c = isClear ? '#22c55e' : getAlertColor(n.level);
      const timeDisplay = isClear
        ? `Відбій: ${formatEventTime(n.receivedAt)}`
        : (n.eventTime ? `Початок: ${formatEventTime(n.eventTime)}` : `Початок: --:--`);

      return `
        <article class="tg-message-card border-red-500/30 hover:border-red-500/60 transition-colors cursor-pointer group" onclick="NavigationController.switchTab('map'); MapService.flyToRegion('${n.territory}'); MapService.selectAndShowDistrict('${n.territory}', true);">
          <div class="flex items-center justify-between pb-1.5 border-b border-white/10 mb-2">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold text-white shadow-sm" style="background-color: ${c}">
                ${isClear ? '🟢 ВІДБІЙ ТРИВОГИ' : `🔴 ОФІЦІЙНА ТРИВОГА [${(n.level || 'RED').toUpperCase()}]`}
              </span>
              <span class="text-[10px] font-mono text-gray-400">NEPTUN API</span>
            </div>
            <div class="flex items-center gap-2 font-mono text-[10px]">
              <span class="text-amber-300 font-bold">${timeDisplay}</span>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <h4 class="text-sm font-bold text-white group-hover:text-sky-300 transition-colors">📍 ${n.title}</h4>
            <span class="text-[10px] text-sky-400 opacity-0 group-hover:opacity-100 transition-opacity">Показати на карті →</span>
          </div>
          <p class="text-xs text-gray-300 mt-1 leading-relaxed">${n.message}</p>
        </article>
      `;
    }

    if (n.type === 'threat') {
      const isClear = n.status === 'ЛІКВІДОВАНО';
      const timeDisplay = n.eventTime ? `Час фіксації: ${formatEventTime(n.eventTime, true)}` : `Час: ${formatEventTime(n.receivedAt, true)}`;

      return `
        <article class="tg-message-card border-amber-500/30 hover:border-amber-500/60 transition-colors cursor-pointer group" onclick="NavigationController.switchTab('map'); MapService.flyToRegion('${n.territory}');">
          <div class="flex items-center justify-between pb-1.5 border-b border-white/10 mb-2">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold ${isClear ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'}">
                ${isClear ? '✅ ЦІЛЬ ЗНИКЛА' : `🟠 ЗАГРОЗА [${(n.subtype || 'ЦІЛЬ').toUpperCase()}]`}
              </span>
              <span class="text-[10px] font-mono text-gray-400">NEPTUN API</span>
            </div>
            <span class="font-mono text-[10px] text-amber-300 font-bold">${timeDisplay}</span>
          </div>
          <div class="flex items-center justify-between">
            <h4 class="text-sm font-bold text-amber-200 group-hover:text-amber-100">⚠️ ${n.title} (${n.territory})</h4>
            <span class="text-[10px] text-sky-400 opacity-0 group-hover:opacity-100 transition-opacity">Показати на карті →</span>
          </div>
          <p class="text-xs text-gray-300 mt-1 leading-relaxed">${n.message}</p>
        </article>
      `;
    }

    // Тип 'message' (Telegram / Інформаційне повідомлення)
    const key = n.sourceId || n.id;
    const analysis = n.analysis || this.analyzedCache.get(key) || (n.rawMsg ? n.rawMsg._analysis : null);
    const msgTimeDisplay = n.eventTime ? `Повідомлення: ${formatEventTime(n.eventTime, true)}` : `Час: ${formatEventTime(n.receivedAt, true)}`;
    const channelName = n.title || 'Telegram';

    let llmHtml = '';
    if (analysis) {
      const catClass = `cat-${analysis.category || 'info'}`;
      let catBadge = '';
      if (analysis.category === 'active_threat') {
        catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-red-500/20 text-red-300 border border-red-500/40">🔴 АКТИВНА ЗАГРОЗА</span>';
      } else if (analysis.category === 'possible_threat') {
        catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-amber-500/20 text-amber-300 border border-amber-500/40">⚠️ МОЖЛИВА ЗАГРОЗА</span>';
      } else if (analysis.category === 'clear') {
        catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">🟢 ВІДБІЙ ЗАГРОЗИ</span>';
      } else {
        catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-sky-500/20 text-sky-300 border border-sky-400/40">ℹ️ ІНФО</span>';
      }

      const territoriesBadges = (analysis.territories || []).map(t =>
        `<span class="px-1.5 py-0.2 rounded text-[10px] font-mono bg-sky-500/15 text-sky-300 border border-sky-400/25">📍 ${t}</span>`
      ).join(' ');

      const timeText = analysis.timeMentioned ? `<span class="text-amber-300 font-mono text-[10px] ml-2">🕒 ${analysis.timeMentioned}</span>` : '';
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

          <p class="text-xs text-gray-100 font-medium leading-relaxed">${analysis.summary}</p>

          ${territoriesBadges ? `<div class="flex flex-wrap gap-1 pt-0.5">${territoriesBadges}</div>` : ''}

          <div class="pt-1 border-t border-white/5 flex items-center justify-between text-[9px] font-mono text-gray-400">
            <span>✓ 100% на основі першоджерела (без домислів)</span>
            <span>${analysis.analyzedAt ? new Date(analysis.analyzedAt).toLocaleTimeString('uk-UA') : ''}</span>
          </div>
        </div>`;
    }

    return `
      <article class="tg-message-card">
        <div class="flex items-center justify-between pb-2 border-b border-white/10 mb-2">
          <div class="flex items-center gap-2">
            <span class="text-xs font-bold text-sky-300 font-mono">${channelName}</span>
            <span class="px-1.5 py-0.2 rounded text-[9px] font-mono bg-blue-500/20 text-blue-300 border border-blue-400/30">🔵 ІНФО (НЕ ТРИВОГА)</span>
          </div>
          <span class="text-[10px] font-mono text-gray-400">${msgTimeDisplay}</span>
        </div>

        <p class="text-xs text-gray-200 leading-relaxed whitespace-pre-line select-text">${n.message || ''}</p>

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
      const data = await fetchUtf8Json('/api/v1/messages');
      const messagesList = Array.isArray(data.messages) ? data.messages : [];

      if (this.isInitialMessagesLoad) {
        for (const m of messagesList) {
          const key = m.id || `${m.date}::${m.channel}::${(m.text || '').slice(0, 30)}`;
          seenMessageKeys.add(key);
        }
        this.isInitialMessagesLoad = false;
        TelegramFeedService.handleIncomingMessages(messagesList);
        return;
      }

      const newMessages = [];
      for (const m of messagesList) {
        const key = m.id || `${m.date}::${m.channel}::${(m.text || '').slice(0, 30)}`;
        if (!seenMessageKeys.has(key)) {
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
    const s = StorageManager.getSettings();

    let matchedTerritory = null;
    for (const followed of FollowManager.followedSet) {
      if (this.matchesTerritoryInText(text, followed)) {
        matchedTerritory = followed;
        break;
      }
    }

    if (matchedTerritory && s.infoMessagesEnabled) {
      SoundService.playInfoChime();
      NotificationManager.send(`🔵 ${channel}: ${matchedTerritory}`, text.slice(0, 120));
      showToast(`🔵 ${channel} щодо ${matchedTerritory}: ${text.slice(0, 60)}...`);
    }
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
    document.getElementById('tab-btn-telegram')?.addEventListener('click', () => this.switchTab('telegram'));
    document.getElementById('tab-btn-ai')?.addEventListener('click', () => this.switchTab('ai'));
    document.getElementById('tab-btn-settings')?.addEventListener('click', () => this.switchTab('settings'));

    document.getElementById('m-tab-map')?.addEventListener('click', () => this.switchTab('map'));
    document.getElementById('m-tab-telegram')?.addEventListener('click', () => this.switchTab('telegram'));
    document.getElementById('m-tab-ai')?.addEventListener('click', () => this.switchTab('ai'));
    document.getElementById('m-tab-settings')?.addEventListener('click', () => this.switchTab('settings'));

    this.applyTabVisibility();
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
    }

    // Mobile buttons
    document.querySelectorAll('.mobile-tab').forEach(b => {
      b.classList.remove('active', 'text-sky-400');
      b.classList.add('text-gray-400');
    });
    const activeMobileBtn = document.getElementById(`m-tab-${tab}`);
    if (activeMobileBtn) {
      activeMobileBtn.classList.add('active', 'text-sky-400');
      activeMobileBtn.classList.remove('text-gray-400');
    }

    const viewTelegram = document.getElementById('view-telegram');
    const viewAi = document.getElementById('view-ai');
    const leftPanel = document.getElementById('left-panel');
    const sidebarFeed = document.getElementById('sidebar-feed');

    if (tab === 'telegram') {
      viewTelegram?.classList.remove('hidden');
      viewAi?.classList.add('hidden');
      leftPanel?.classList.add('hidden');
      sidebarFeed?.classList.add('hidden');
      TelegramFeedService.render();
    } else if (tab === 'ai') {
      viewTelegram?.classList.add('hidden');
      viewAi?.classList.remove('hidden');
      leftPanel?.classList.add('hidden');
      sidebarFeed?.classList.add('hidden');
      AIService?.render();
    } else {
      viewTelegram?.classList.add('hidden');
      viewAi?.classList.add('hidden');
      leftPanel?.classList.remove('hidden');
      sidebarFeed?.classList.remove('hidden');
      MapService.map?.invalidateSize();
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

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
      maxZoom:     16
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

    window.addEventListener('resize', () => {
      this.map?.invalidateSize();
      if (this.currentPopup && this.currentPopup.isOpen()) {
        this.ensurePopupVisible(this.currentPopup);
      }
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
      const data = await fetchUtf8Json('/ukraine_districts.geojson');

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
      const data = await fetchUtf8Json('/ukraine_regions.geojson');
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
    const normRayon  = normalizeName(rayonName);
    const normRegion = normalizeName(regionName);

    if (normRayon === 'київ' || normRegion === 'київ') {
      return State.specialCities.get('київ') || null;
    }

    if (normRayon === 'севастополь' || normRegion === 'севастополь') {
      return State.specialCities.get('севастополь') || null;
    }

    if (State.raions.has(normRayon)) {
      return State.raions.get(normRayon);
    }

    if (normRegion && State.oblasts.has(normRegion)) {
      return State.oblasts.get(normRegion);
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
    const starBtnText = isStarred ? '⭐ Ви стежите' : '☆ Слідкувати';
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
      statusBadge = `<span class="px-2 py-0.5 rounded font-bold text-white text-[10px] shadow" style="background-color: ${color}">🚨 АКТИВНА [${lvlUpper}]</span>`;

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
      statusBadge = `<span class="px-2 py-0.5 rounded font-bold text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 text-[10px]">✓ СПОКІЙНО (Тривога: НІ)</span>`;
    }

    if (threatCount > 0) {
      detailsHtml += `
        <div class="flex justify-between py-1 border-b border-white/10 text-amber-400">
          <span>⚠️ Активних цілей поруч:</span>
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
    const rightFeed = document.getElementById('sidebar-feed');
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
    if (rightFeed && window.getComputedStyle(rightFeed).display !== 'none' && window.innerWidth >= 1024) {
      const rfRect = rightFeed.getBoundingClientRect();
      if (rfRect.left > 0 && rfRect.left < window.innerWidth) {
        safeRight = Math.min(safeRight, rfRect.left - 16);
      }
    }

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
      details.push(`<div class="text-amber-400 font-semibold mb-1">⚠️ Загроза по області (орієнтовний район, не точні координати)</div>`);
    } else {
      if (threat.locality) details.push(`<div><span class="text-gray-400">Населений пункт:</span> <b>${escapeHtml(threat.locality)}</b></div>`);
      if (threat.heading != null) details.push(`<div><span class="text-gray-400">Курс:</span> <b>${formatHeading(threat.heading)}</b></div>`);
      if (threat.speed != null) details.push(`<div><span class="text-gray-400">Швидкість:</span> <b>${threat.speed} км/год</b></div>`);
      if (threat.altitude != null) details.push(`<div><span class="text-gray-400">Висота:</span> <b>${threat.altitude} м</b></div>`);
      details.push(`<div><span class="text-gray-400">Координати:</span> <span class="font-mono text-[10px] text-gray-300">${lat.toFixed(4)}, ${lng.toFixed(4)}</span></div>`);
    }

    if (isStale) {
      details.push(`<div class="text-amber-300 font-mono text-[10px] mt-1 bg-amber-500/10 p-1 rounded border border-amber-500/20">⏳ Останнє оновлення &gt; 45 сек тому</div>`);
    }

    marker.bindPopup(`
      <div class="custom-radar-popup p-1 font-mono text-[11px]">
        <div class="pb-1 mb-1 border-b border-amber-500/30 text-amber-400 font-bold uppercase">
          ${threat.areaOnly ? '📍 ОБЛАСНА ЗАГРОЗА' : '⚠️ АКТИВНА ЦІЛЬ'} (${threat.title || threat.type})
        </div>
        <div><span class="text-gray-400">ID:</span> <b>${threat.id}</b></div>
        <div><span class="text-gray-400">Регіон:</span> ${threat.region}${threat.district ? ` (${threat.district})` : ''}</div>
        ${details.join('')}
        <div><span class="text-gray-400">Час засічки:</span> ${threat.time || 'Н/Д'}</div>
      </div>`, { className: 'custom-radar-popup' });
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
      showToast(`⭐ Припинено стеження за: ${name}`);
    } else {
      this.followedSet.add(name);
      showToast(`⭐ Стеження за: ${name}`);
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
      listEl.innerHTML = `<p class="text-[10px] text-gray-400 text-center py-2 italic">Натисніть ⭐ біля території для швидкого стеження</p>`;
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
            <span class="text-xs">📍</span>
            <span class="text-xs font-semibold text-gray-200 truncate group-hover:text-sky-300">${name}</span>
          </div>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            ${statusBadge}
            <button onclick="event.stopPropagation(); FollowManager.toggleFollowByName('${name}');" class="text-amber-400 hover:text-white p-0.5" title="Видалити">✕</button>
          </div>
        </div>
      `;
    }).join('');
  }
};

/* ============================================================
   11. TERRITORIES MANAGER (ПОШУК ТА ІЄРАРХІЯ)
============================================================ */
const TerritoriesManager = {
  hierarchy: [],
  flat:      [],
  byId:      new Map(),

  async load() {
    try {
      const data = await fetchUtf8Json('/api/v1/territories');
      this.hierarchy = data.hierarchy || [];
      this.flat      = data.flat || [];
      this.byId.clear();
      for (const item of this.flat) this.byId.set(item.id, item);
    } catch (err) {
      console.warn('[TerritoriesManager] Завантаження з локального файлу...');
      const data = await fetchUtf8Json('/territories.json');
      this.hierarchy = data.hierarchy || [];
      this.flat      = data.flat || [];
      this.byId.clear();
      for (const item of this.flat) this.byId.set(item.id, item);
    }
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
   12. FEED SERVICE (ОПЕРАТИВНА ІНФОРМАЦІЯ + РІЗНИЦЯ ТИПІВ)
============================================================ */
const FeedService = {
  feedContainer:      null,
  newEventsPill:      null,
  newEventsCountSpan: null,
  unreadCount:        0,

  init() {
    this.feedContainer      = document.getElementById('feed-container');
    this.newEventsPill      = document.getElementById('new-events-pill');
    this.newEventsCountSpan = document.getElementById('new-events-count');

    document.getElementById('btn-scroll-top-feed')?.addEventListener('click', () => {
      this.feedContainer.scrollTo({ top: 0, behavior: 'smooth' });
      this.unreadCount = 0;
      this.newEventsPill?.classList.add('hidden');
    });

    this.feedContainer?.addEventListener('scroll', () => {
      if (this.feedContainer.scrollTop < 25) {
        this.unreadCount = 0;
        this.newEventsPill?.classList.add('hidden');
      }
    });
  },

  addEvent(item) {
    State.history.unshift(item);
    if (State.history.length > 100) State.history.pop();

    if (this.feedContainer && this.feedContainer.scrollTop > 35) {
      this.unreadCount++;
      if (this.newEventsCountSpan) this.newEventsCountSpan.textContent = `+${this.unreadCount}`;
      this.newEventsPill?.classList.remove('hidden');
    }
    this.render();
  },

  render() {
    const placeholder = document.getElementById('feed-empty-placeholder');
    const totalSpan   = document.getElementById('feed-items-total');
    let items = State.history;

    if (State.activeFilter === 'alerts') items = items.filter(i => i.type === 'alert');
    else if (State.activeFilter === 'threats') items = items.filter(i => i.type !== 'alert' && i.type !== 'clear');
    else if (['drone','missile','ballistic'].includes(State.activeFilter)) items = items.filter(i => i.type === State.activeFilter);

    if (State.selectedRegion !== 'all') {
      const normSel = normalizeName(State.selectedRegion);
      items = items.filter(i => (i.title && normalizeName(i.title).includes(normSel)) || (i.desc && normalizeName(i.desc).includes(normSel)));
    }

    if (totalSpan) totalSpan.textContent = `${items.length} подій`;

    if (items.length === 0) {
      placeholder?.classList.remove('hidden');
      if (this.feedContainer) { this.feedContainer.innerHTML = ''; if (placeholder) this.feedContainer.appendChild(placeholder); }
      return;
    }

    placeholder?.classList.add('hidden');
    if (!this.feedContainer) return;

    this.feedContainer.innerHTML = items.map(item => {
      if (item.type === 'alert') {
        const c = getAlertColor(item.level);
        return `
          <div class="liquid-glass-card rounded-xl p-2.5 border transition-all text-xs font-mono border-red-500/20">
            <div class="flex items-center justify-between mb-1">
              <span class="px-1.5 py-0.5 rounded border text-[10px] font-bold text-white shadow-sm" style="background-color: ${c}">
                🔴 ОФІЦІЙНА ТРИВОГА [${(item.level || 'RED').toUpperCase()}]
              </span>
              <span class="text-[10px] text-gray-400">${item.time}</span>
            </div>
            <p class="font-bold text-gray-100 text-xs">${item.title}</p>
            <p class="text-[11px] text-gray-400 mt-0.5 leading-snug">${item.desc}</p>
          </div>
        `;
      }

      if (item.type === 'info_message') {
        return `
          <div class="liquid-glass-card rounded-xl p-2.5 border transition-all text-xs font-mono border-amber-500/30 bg-amber-950/20">
            <div class="flex items-center justify-between mb-1">
              <span class="px-1.5 py-0.5 rounded border text-[10px] font-bold bg-amber-500/20 text-amber-300 border-amber-400/40">
                📰 ІНФО (НЕ ТРИВОГА)
              </span>
              <span class="text-[10px] text-gray-400">${item.time}</span>
            </div>
            <p class="font-bold text-amber-200 text-xs">${item.title}</p>
            <p class="text-[11px] text-gray-300 mt-0.5 leading-snug">${item.desc}</p>
          </div>
        `;
      }

      const MAP = {
        drone:     ['bg-amber-500/20 text-amber-300 border-amber-400/30',   '🛸'],
        missile:   ['bg-rose-500/20 text-rose-300 border-rose-400/30',      '🚀'],
        ballistic: ['bg-purple-500/20 text-purple-300 border-purple-400/30','⚡'],
        clear:     ['bg-emerald-500/20 text-emerald-300 border-emerald-400/30','✅']
      };
      const [cls, icon] = MAP[item.type] || ['bg-sky-500/20 text-sky-300 border-sky-400/30', 'ℹ️'];

      return `
        <div class="liquid-glass-card rounded-xl p-2.5 border transition-all text-xs font-mono">
          <div class="flex items-center justify-between mb-1">
            <span class="px-1.5 py-0.5 rounded border text-[10px] font-bold ${cls}">
              ${icon} ${(item.type || '').toUpperCase()}
            </span>
            <span class="text-[10px] text-gray-400">${item.time}</span>
          </div>
          <p class="font-bold text-gray-100 text-xs">${item.title}</p>
          <p class="text-[11px] text-gray-400 mt-0.5 leading-snug">${item.desc}</p>
        </div>
      `;
    }).join('');
  }
};

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

    // 2. Старт фонового опитування повідомлень Telegram
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
    if (iconEl)      iconEl.textContent = isCity ? '🏙' : '📍';

    const isStarred = FollowManager.isFollowed(name);
    if (starText) starText.textContent = isStarred ? 'Відстежується ★' : 'Слідкувати ☆';
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
      return `<span class="font-bold text-white px-1.5 py-0.5 rounded text-[10px]" style="background-color: ${c}">🚨 ТРИВОГА [${(a.level || 'RED').toUpperCase()}]</span>`;
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
        let icon = '🏛';
        let typeBadge = '<span class="text-[9px] text-purple-400 font-bold">ОБЛАСТЬ</span>';
        let subtext = 'Адміністративна область';

        if (item.name === 'Київ' || item.name === 'Севастополь') {
          icon = '🏙';
          typeBadge = '<span class="text-[9px] text-emerald-400 font-bold">СПЕЦ. СТАТУС</span>';
          subtext = 'Місто зі спеціальним статусом';
        } else if (item.type === 'city') {
          icon = '🏙';
          typeBadge = '<span class="text-[9px] text-emerald-400 font-bold">МІСТО</span>';
          subtext = `${item.districtName ? item.districtName + ', ' : ''}${item.regionName}`;
        } else if (item.type === 'district') {
          icon = '📍';
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
              <span class="text-sm">${icon}</span>
              <div class="truncate">
                <div class="flex items-center gap-1.5"><span class="font-bold text-xs text-gray-100">${item.name}</span>${typeBadge}</div>
                <div class="text-[10px] text-gray-400 truncate">${subtext}</div>
              </div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              ${statusBadge}
              <button class="star-btn ${isStarred ? 'text-amber-400' : 'text-gray-400 hover:text-amber-300'} text-sm p-1" data-name="${item.name}" title="Слідкувати">${isStarred ? '★' : '☆'}</button>
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
                <span class="font-semibold text-gray-200 group-hover:text-sky-300">📍 ${dist.name}</span>
                <div class="flex items-center gap-2">
                  ${dBadge}
                  <button onclick="event.stopPropagation(); FollowManager.toggleFollowByName('${dist.name}'); UIController.bindTreeModal();" class="text-xs ${isDStarred ? 'text-amber-400' : 'text-gray-500 hover:text-amber-300'}">
                    ${isDStarred ? '★' : '☆'}
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
                <span class="text-sm">🏛</span>
                <span class="font-bold text-sm text-white group-hover:text-sky-300">${reg.name}</span>
              </div>
              <div class="flex items-center gap-2">
                ${regBadge}
                <button onclick="event.stopPropagation(); FollowManager.toggleFollowByName('${reg.name}'); UIController.bindTreeModal();" class="text-sm ${isRegStarred ? 'text-amber-400' : 'text-gray-500 hover:text-amber-300'}">
                  ${isRegStarred ? '★' : '☆'}
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
      MapService.flyToRegion(State.selectedRegion);
      FeedService.render();
      TelegramFeedService.render();
      AIService?.render();
    });

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
      showToast('🗑 Історію очищено');
    });

    document.getElementById('btn-toggle-fullscreen')?.addEventListener('click', () => {
      document.body.classList.toggle('fullscreen-radar');
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      else document.exitFullscreen().catch(() => {});
      setTimeout(() => MapService.map?.invalidateSize(), 200);
    });

    document.getElementById('btn-mobile-toggle-feed')?.addEventListener('click', () => {
      document.getElementById('sidebar-feed')?.classList.toggle('translate-x-[110%]');
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
    const infoCheck      = document.getElementById('setting-info-messages-enabled');
    const soundCheck     = document.getElementById('setting-sound-enabled');
    const quietCheck     = document.getElementById('setting-quiet-hours');
    const opRange        = document.getElementById('setting-zone-opacity');
    const threatsCheck   = document.getElementById('setting-threats-alerts-enabled');
    const llmCheck       = document.getElementById('setting-llm-analysis-enabled');
    const opLabel        = document.getElementById('label-zone-opacity');
    const layerAlerts    = document.getElementById('setting-layer-alerts');
    const layerThreats   = document.getElementById('setting-layer-threats');
    const animCheck      = document.getElementById('setting-enable-animations');
    const aiTabCheck     = document.getElementById('setting-ai-tab-visible');

    const openModal = () => {
      const s = StorageManager.getSettings();
      if (notifCheck)    notifCheck.checked    = s.notificationsEnabled;
      if (officialCheck) officialCheck.checked = s.officialAlertsEnabled;
      if (threatsCheck)  threatsCheck.checked  = s.threatsAlertsEnabled !== false;
      if (infoCheck)     infoCheck.checked     = s.infoMessagesEnabled !== false;
      if (llmCheck)      llmCheck.checked      = s.llmAnalysisEnabled !== false;
      if (aiTabCheck)    aiTabCheck.checked    = s.aiTabVisible !== false;
      if (soundCheck)    soundCheck.checked    = s.soundEnabled;
      if (quietCheck)    quietCheck.checked    = s.quietHours;
      if (opRange)       opRange.value         = s.zoneOpacity || 0.35;
      if (opLabel)       opLabel.textContent   = `${Math.round((s.zoneOpacity || 0.35) * 100)}%`;
      if (layerAlerts)   layerAlerts.checked   = s.layerAlerts;
      if (layerThreats)  layerThreats.checked  = s.layerThreats;
      if (animCheck)     animCheck.checked     = s.enableAnimations;
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
        if (!ok) { notifCheck.checked = false; showToast('⚠️ Дозвіл на сповіщення відхилено.'); }
      }
    });

    const testSoundBtn = document.getElementById('btn-test-sound');
    testSoundBtn?.addEventListener('click', () => {
      if (testSoundBtn.disabled) return;
      testSoundBtn.disabled = true;
      const originalText = testSoundBtn.textContent;
      testSoundBtn.textContent = 'Відтворення...';
      SoundService.playAlertSiren();
      setTimeout(() => SoundService.playInfoChime(), 1200);
      showToast('🔊 Тестовий сигнал (Сирена + Chime)');
      setTimeout(() => {
        testSoundBtn.disabled = false;
        testSoundBtn.textContent = originalText;
      }, 2000);
    });

    btnSave?.addEventListener('click', () => {
      if (btnSave.disabled) return;
      btnSave.disabled = true;
      btnSave.textContent = 'Збереження...';

      const updated = {
        notificationsEnabled:  notifCheck?.checked || false,
        officialAlertsEnabled: officialCheck?.checked !== false,
        threatsAlertsEnabled:  threatsCheck?.checked !== false,
        infoMessagesEnabled:   infoCheck?.checked !== false,
        llmAnalysisEnabled:    llmCheck?.checked !== false,
        aiTabVisible:          aiTabCheck?.checked !== false,
        soundEnabled:          soundCheck?.checked !== false,
        quietHours:            quietCheck?.checked || false,
        zoneOpacity:           parseFloat(opRange?.value || 0.35),
        layerAlerts:           layerAlerts?.checked !== false,
        layerThreats:          layerThreats?.checked !== false,
        enableAnimations:      animCheck?.checked !== false
      };
      StorageManager.saveSettings(updated);
      NavigationController.applyTabVisibility();
      modal?.classList.add('hidden');
      document.body.classList.toggle('disable-animations', !updated.enableAnimations);
      MapService.updateAllDistrictStyles();
      for (const t of State.threats.values()) MapService.updateThreat(t);
      showToast('✅ Налаштування збережено');

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
  chimeAudio: null,

  init() {
    try {
      this.sirenAudio = new Audio('/sounds/siren.ogg');
      this.sirenAudio.preload = 'auto';
      this.chimeAudio = new Audio('/sounds/chime.ogg');
      this.chimeAudio.preload = 'auto';
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

  playAlertSiren() {
    if (isInitialLoad) return;
    const s = StorageManager.getSettings();
    if (!s.soundEnabled || this.isQuietTime()) return;

    if (this.sirenAudio) {
      this.sirenAudio.currentTime = 0;
      this.sirenAudio.play().catch(() => {
        this.synthesizeSiren();
      });
    } else {
      this.synthesizeSiren();
    }
  },

  playInfoChime() {
    if (isInitialLoad) return;
    const s = StorageManager.getSettings();
    if (!s.soundEnabled || this.isQuietTime()) return;

    if (this.chimeAudio) {
      this.chimeAudio.currentTime = 0;
      this.chimeAudio.play().catch(() => {
        this.synthesizeChime();
      });
    } else {
      this.synthesizeChime();
    }
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
  async requestPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    return (await Notification.requestPermission()) === 'granted';
  },

  send(title, body, tag = 'radar-alert') {
    if (isInitialLoad) return;
    const s = StorageManager.getSettings();
    if (!s.notificationsEnabled || SoundService.isQuietTime()) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification(title, {
        body,
        icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🚨</text></svg>',
        tag
      });
    } catch (e) {}
  }
};

const StorageManager = {
  KEYS: {
    SETTINGS: 'radar_settings_v6'
  },

  defaultSettings: {
    notificationsEnabled:  false,
    officialAlertsEnabled: true,
    threatsAlertsEnabled:  true,
    infoMessagesEnabled:   true,
    llmAnalysisEnabled:    true,
    aiTabVisible:          true,
    soundEnabled:          true,
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

    const settingActive = document.getElementById('ai-setting-active');
    if (settingActive) {
      settingActive.addEventListener('change', (e) => {
        const s = StorageManager.getSettings();
        s.llmAnalysisEnabled = e.target.checked;
        StorageManager.saveSettings(s);
        showToast(s.llmAnalysisEnabled ? '🧠 ШІ-аналіз активовано' : 'ШІ-аналіз призупинено');
      });
    }

    const settingFocus = document.getElementById('ai-setting-region-focus');
    if (settingFocus) {
      settingFocus.addEventListener('change', () => {
        this.renderFeed();
      });
    }

    this.fetchEngineStatus();
  },

  async fetchEngineStatus(notify = false) {
    try {
      const res = await fetchUtf8Json('/api/v1/llm-status');
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

        if (notify) showToast('✅ Статус ШІ оновлено');
      }
    } catch (e) {
      if (notify) showToast('⚠️ Помилка перевірки статусу ШІ');
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
    outEl.innerHTML = '<span class="text-purple-300 animate-pulse font-mono text-xs">⏳ Виконується аналіз моделі...</span>';

    try {
      const start = performance.now();
      const res = await fetch('/api/v1/analyze-message', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          message:             { text, date: new Date().toISOString() },
          followedTerritories: Array.from(FollowManager.followedSet)
        })
      });
      const latency = Math.round(performance.now() - start);
      const data    = await res.json();

      const latEl = document.getElementById('ai-latency-val');
      if (latEl) latEl.textContent = `${latency} ms`;

      if (data && data.analysis) {
        const a = data.analysis;
        const isThreat = a.category === 'active_threat';
        const isMvmt   = a.category === 'possible_threat';
        const catBadge = isThreat ? '🔴 ПРЯМА ЗАГРОЗА' : (isMvmt ? '🟠 МОЖЛИВА ЗАГРОЗА' : '🔵 ОБСТАНОВКА');

        outEl.innerHTML = `
          <div class="text-xs text-purple-200 pb-1 border-b border-purple-500/20 flex justify-between">
            <span>Категорія: <b>${catBadge}</b></span>
            <span class="text-gray-400">Затримка: ${latency} ms</span>
          </div>
          <div class="text-[11px] text-gray-300"><b>Території:</b> ${a.territories && a.territories.length ? a.territories.join(', ') : 'Не виявлено'}</div>
          <div class="text-[11px] text-purple-200"><b>Висновки:</b> ${escapeHtml(a.summary || '')}</div>
          <div class="text-[10px] text-gray-400 font-mono">Впевненість: ${Math.round((a.confidence || 0.9) * 100)}% | Рушій: ${a.engine || 'local-nlp'}</div>
        `;
      } else {
        outEl.innerHTML = '<span class="text-red-400">Помилка обробки повідомлення</span>';
      }
    } catch (e) {
      outEl.innerHTML = `<span class="text-red-400">Помилка: ${escapeHtml(e.message)}</span>`;
    }
  },

  render() {
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

    const focusRegion = document.getElementById('ai-setting-region-focus')?.checked;
    if (focusRegion && State.selectedRegion && State.selectedRegion !== 'all') {
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
          <div class="w-12 h-12 mx-auto mb-2 text-purple-400/60 flex items-center justify-center rounded-full bg-purple-500/10 border border-purple-500/20 text-xl font-bold">
            🧠
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
    const badgeText = isThreat ? '🔴 ПРЯМА ЗАГРОЗА' : (isMovement ? '🟠 МОЖЛИВА ЗАГРОЗА' : '🔵 ОБСТАНОВКА');
    const badgeBg = isThreat ? 'bg-red-500/20 text-red-300 border-red-500/30' : (isMovement ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' : 'bg-sky-500/20 text-sky-300 border-sky-500/30');

    const territories = (a.territories || []).map(t => 
      `<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-white/10 text-gray-200 border border-white/15">📍 ${escapeHtml(t)}</span>`
    ).join(' ');

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

        ${territories ? `<div class="flex flex-wrap gap-1.5 mb-2.5">${territories}</div>` : ''}

        <div class="p-2 rounded bg-black/40 border border-white/5 text-[11px] text-gray-400 font-sans italic leading-normal mb-2.5">
          «${escapeHtml(n.message || '')}»
        </div>

        <div class="flex items-center justify-between pt-1 text-[10px] text-gray-400 font-mono">
          <span class="flex items-center gap-1">
            <span>Рушій:</span> <b>${a.engine === 'gemini' ? 'Gemini 1.5 Flash' : 'Локальний NLP'}</b> | Впевненість: <b>${Math.round((a.confidence || 0.9) * 100)}%</b>
          </span>
          ${firstTerritory ? `
            <button class="px-2 py-1 rounded bg-purple-600/30 hover:bg-purple-600/60 text-purple-200 border border-purple-400/40 text-[10px] font-mono font-semibold transition-colors" onclick="NavigationController.switchTab('map'); MapService.flyToRegion('${escapeHtml(firstTerritory)}');">
              🗺️ На карті
            </button>` : ''}
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

function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className   = 'radar-toast font-mono';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.4s ease'; setTimeout(() => toast.remove(), 400); }, 4000);
}

/* ============================================================
   СТАРТ СИСТЕМИ
============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  SoundService.init();
  FollowManager.init();
  NavigationController.init();
  FeedService.init();
  await TelegramFeedService.init();
  AIService.init();
  await TerritoriesManager.load();
  await MapService.init();
  UIController.init();
  console.log('🚀 [РАДАР] Realtime WebSocket (wss://neptun.in.ua/api/v1/stream) + Telegram + LLM модуль активовано!');
});
