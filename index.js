/**
 * index.js
 * Серверна частина системи «РАДАР — Національний моніторинг повітряного простору».
 *
 * Джерело істини: Офіційний NEPTUN API (https://neptun.in.ua)
 * Сервер автоматично синхронізує актуальні дані про тривоги та цілі
 * з реальними endpoints https://neptun.in.ua/api/v1/alerts та /threats,
 * кешує їх у пам'яті та роздає клієнту з субсекундною затримкою та UTF-8 кодуванням.
 */

require('dotenv').config();
const http    = require('http');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');

const PORT = parseInt(process.env.PORT || '3000', 10);
const NEPTUN_API_BASE = process.env.NEPTUN_API_URL || 'https://neptun.in.ua';

const app    = express();
const server = http.createServer(app);

/* ============================================================
   MIDDLEWARE ТА БЕЗПЕКА
============================================================ */
app.use(helmet({
  contentSecurityPolicy:      false,
  crossOriginEmbedderPolicy:  false,
  crossOriginResourcePolicy:  false,
}));
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  res.charset = 'utf-8';
  next();
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Забагато запитів. Зачекайте кілька хвилин.' },
});
app.use('/api/', apiLimiter);

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   АКТУАЛЬНИЙ СТАН NEPTUN API (СИНХРОНІЗАЦІЯ З UPSTREAM)
============================================================ */
const nationalRaions   = new Map();
const nationalOblasts  = new Map();
const nationalThreats  = new Map();
let nationalMessages   = [];

let stateVersion = Math.floor(Date.now() / 1000);
let stateUpdatedAt = new Date().toISOString();
let lastUpstreamSync = null;
let lastMessagesSync = null;

// Функція запиту до upstream NEPTUN API
function fetchNeptunUpstream(endpoint) {
  return new Promise((resolve, reject) => {
    const targetUrl = `${NEPTUN_API_BASE}${endpoint}`;
    const req = https.get(targetUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Radar-Airspace-Monitor/2.0'
      },
      timeout: 8000
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Upstream HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          resolve(JSON.parse(buf.toString('utf-8')));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Upstream timeout'));
    });
  });
}

// Фонова синхронізація з NEPTUN API кожні 5 секунд
async function syncFromNeptun() {
  try {
    const [alertsData, threatsData, messagesData] = await Promise.all([
      fetchNeptunUpstream('/api/v1/alerts').catch(err => {
        console.warn('[NEPTUN-SYNC] Помилка отримання alerts:', err.message);
        return null;
      }),
      fetchNeptunUpstream('/api/v1/threats').catch(err => {
        console.warn('[NEPTUN-SYNC] Помилка отримання threats:', err.message);
        return null;
      }),
      fetchNeptunUpstream('/api/v1/messages').catch(err => {
        console.warn('[NEPTUN-SYNC] Помилка отримання messages:', err.message);
        return null;
      })
    ]);

    if (alertsData) {
      stateVersion = alertsData.version || Math.floor(Date.now() / 1000);
      stateUpdatedAt = alertsData.updatedAt || new Date().toISOString();

      nationalRaions.clear();
      nationalOblasts.clear();

      if (Array.isArray(alertsData.raions)) {
        for (const r of alertsData.raions) {
          const key = r.key || `${r.name}::${r.oblast}`;
          nationalRaions.set(key, r);
        }
      }

      if (Array.isArray(alertsData.oblasts)) {
        for (const o of alertsData.oblasts) {
          const key = o.key || o.name;
          nationalOblasts.set(key, o);
        }
      }
    }

    if (threatsData) {
      nationalThreats.clear();
      const list = Array.isArray(threatsData.threats)
        ? threatsData.threats
        : (Array.isArray(threatsData) ? threatsData : (Array.isArray(threatsData.data) ? threatsData.data : []));

      for (const t of list) {
        if (t && t.id) {
          nationalThreats.set(t.id, t);
        }
      }
    }

    if (messagesData && Array.isArray(messagesData.messages)) {
      nationalMessages = messagesData.messages;
      lastMessagesSync = messagesData.updatedAt || new Date().toISOString();
    }

    lastUpstreamSync = new Date().toISOString();
  } catch (err) {
    console.warn('[NEPTUN-SYNC] Загальна помилка синхронізації:', err.message);
  }
}

// Запуск початкової синхронізації
syncFromNeptun();
setInterval(syncFromNeptun, 5000);

/* ============================================================
   SSE МЕНЕДЖЕР (SERVER-SENT EVENTS)
============================================================ */
const sseClients = new Set();

function broadcastSSE(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload, 'utf-8');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(':ping\n\n', 'utf-8');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 20000);

/* ============================================================
   REST API ЕНДПОІНТИ
============================================================ */

// 1. Статус системи
app.get('/api/health', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json({
    status:              'ok',
    service:             'RADAR',
    source:              'NEPTUN API',
    upstreamUrl:         NEPTUN_API_BASE,
    lastUpstreamSync,
    clientsConnected:    sseClients.size,
    activeRaionsCount:   nationalRaions.size,
    activeOblastsCount:  nationalOblasts.size,
    activeThreatsCount:  nationalThreats.size,
    version:             stateVersion,
    updatedAt:           stateUpdatedAt,
    timestamp:           new Date().toISOString()
  });
});

// 2. Конфігурація системи
app.get('/api/config', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json({
    source:          'NEPTUN API',
    upstreamUrl:     NEPTUN_API_BASE,
    attribution:     'Дані: Офіційний моніторинг NEPTUN',
    neptunSourceUrl: 'https://neptun.in.ua',
    pollIntervalMs:  5000
  });
});

// 3. Ієрархія територій
app.get('/api/v1/territories', (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'public', 'territories.json'), 'utf8');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(raw);
  } catch (err) {
    res.status(500).json({ error: 'Не вдалося завантажити структуру територій' });
  }
});

// 4. Повітряні тривоги — ОФІЦІЙНА СТРУКТУРА NEPTUN API
app.get('/api/v1/alerts', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  const raionsList = Array.from(nationalRaions.values());
  const oblastsList = Array.from(nationalOblasts.values());

  res.json({
    version:   stateVersion,
    updatedAt: stateUpdatedAt,
    raions:    raionsList,
    oblasts:   oblastsList,
    data:      [...oblastsList, ...raionsList],
    count:     raionsList.length + oblastsList.length,
    success:   true
  });
});

// 5. Активні цілі (загрози)
app.get('/api/v1/threats', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  const threatsList = Array.from(nationalThreats.values());

  res.json({
    version:   stateVersion,
    updatedAt: stateUpdatedAt,
    threats:   threatsList,
    data:      threatsList,
    count:     threatsList.length,
    success:   true
  });
});

// 6. Оперативні повідомлення NEPTUN (Telegram моніторинг)
app.get('/api/v1/messages', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  res.json({
    updatedAt: lastMessagesSync || new Date().toISOString(),
    count:     nationalMessages.length,
    messages:  nationalMessages,
    success:   true
  });
});

/* ============================================================
   7. LLM ТА NLP АНАЛІЗАТОР TELEGRAM ПОВІДОМЛЕНЬ
============================================================ */
const llmAnalysisCache = new Map();
const MAX_LLM_CACHE = 1000;

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
  { name: 'Рівненська область', patterns: [/рівнен/i, /рівн[ое]/i, /ваpackage/i, /дубн/i, /сарн/i] },
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
    engine: 'local-nlp',
    analyzedAt: new Date().toISOString()
  };
}

let geminiCooldownUntil = 0;
let geminiLastError = null;
let geminiLastSuccessTime = null;
let lastGeminiRequestTime = 0;
const GEMINI_MODEL = process.env.GEMINI_MODEL ? process.env.GEMINI_MODEL.trim() : 'gemini-1.5-flash';
const GEMINI_MIN_INTERVAL_MS = 3000; // Безпечний інтервал для безкоштовного Gemini Free Tier (15 RPM)

async function analyzeWithGemini(text, followedTerritories = [], apiKey) {
  // Перевірка активного кулдауну при 429/помилках для захисту від блокувань
  if (Date.now() < geminiCooldownUntil) {
    throw new Error(`Gemini Free Tier кулдаун: ${geminiLastError}`);
  }

  // Rate Limiting черга для Free Tier (не частіше ніж 1 запит на 3 секунди)
  const now = Date.now();
  const waitMs = Math.max(0, GEMINI_MIN_INTERVAL_MS - (now - lastGeminiRequestTime));
  if (waitMs > 0) {
    await new Promise(r => setTimeout(r, waitMs));
  }
  lastGeminiRequestTime = Date.now();

  const prompt = `Ти — аналітичний модуль цивільного моніторингу повітряного простору України.
Проаналізуй наведене повідомлення з Telegram-каналу.
Правила безпеки:
- Тільки факти з тексту. ЗАБОРОНЕНО вигадувати загрози, координати, час або прогнозувати удари чи місця влучання.
- Якщо час не вказано явно в тексті — вкажи timeMentioned: null.
- Поверни ТІЛЬКИ валідний JSON у такому форматі:
{
  "relevant": true/false (чи стосується воно хоча б однієї з територій: ${JSON.stringify(followedTerritories)}),
  "territories": ["назви знайдених областей чи міст України"],
  "category": "possible_threat" | "active_threat" | "clear" | "info",
  "timeMentioned": "HH:MM" або null,
  "summary": "Короткий стислий факт українською мовою без домислів (1-2 речення)",
  "confidence": число від 0.5 до 1.0,
  "sourceBased": true
}

Текст повідомлення:
"""${text.replace(/"/g, "'")}"""`;

  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  });

  return new Promise((resolve, reject) => {
    const postReq = https.request(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 4500
    }, (res) => {
      const statusCode = res.statusCode;

      if (statusCode === 429) {
        // Перевищено Free Tier квоту — активуємо 60с кулдаун і перемикаємо на локальний NLP
        geminiCooldownUntil = Date.now() + 60000;
        geminiLastError = 'Перевищено ліміт запитів Gemini Free Tier (429 Rate Limit)';
        return reject(new Error(geminiLastError));
      }

      if (statusCode === 402) {
        geminiCooldownUntil = Date.now() + 300000;
        geminiLastError = 'Потрібен чистий Free Tier ключ (у вашому проєкті Google Cloud увімкнено платний білінг без кредитів)';
        return reject(new Error(geminiLastError));
      }

      if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
        // Недійсний ключ або помилка конфігурації
        geminiCooldownUntil = Date.now() + 300000; // 5 хв
        geminiLastError = `Помилка авторизації Gemini (HTTP ${statusCode})`;
        return reject(new Error(geminiLastError));
      }

      if (statusCode !== 200) {
        geminiCooldownUntil = Date.now() + 30000;
        geminiLastError = `Помилка Gemini API HTTP ${statusCode}`;
        return reject(new Error(geminiLastError));
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const candidateText = body?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!candidateText) return reject(new Error('Порожня відповідь Gemini'));
          const parsed = JSON.parse(candidateText.trim());
          parsed.engine = `Gemini Free Tier (${GEMINI_MODEL})`;
          parsed.analyzedAt = new Date().toISOString();
          parsed.sourceBased = true;
          geminiLastError = null;
          geminiLastSuccessTime = new Date().toISOString();
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });

    postReq.on('error', (err) => {
      geminiCooldownUntil = Date.now() + 30000;
      geminiLastError = `Мережева помилка Gemini: ${err.message}`;
      reject(err);
    });

    postReq.on('timeout', () => {
      postReq.destroy();
      geminiCooldownUntil = Date.now() + 30000;
      geminiLastError = 'Таймаут відповіді Gemini (>4.5с)';
      reject(new Error(geminiLastError));
    });

    postReq.write(payload);
    postReq.end();
  });
}

/* ============================================================
   ПРОКСІ-СЕРВІС ДЛЯ ALERTS.IN.UA (ОФІЦІЙНІ ТРИВОГИ)
   Токен зберігається ТІЛЬКИ на сервері в process.env.ALERTS_IN_UA_TOKEN!
   Клієнтський бандл ніколи не отримує секретний токен.
============================================================ */
let cachedAlertsInUa = null;
let lastAlertsInUaFetch = 0;
const ALERTS_IN_UA_CACHE_MS = 10000; // 10 секунд кеш для дотримання rate-limits

function fetchAlertsInUaUpstream(token) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.alerts.in.ua/v1/alerts/active.json', {
      headers: {
        'Authorization': `Bearer ${token.trim()}`,
        'Accept': 'application/json',
        'User-Agent': 'Radar-Airspace-Monitor/2.0'
      },
      timeout: 8000
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`alerts.in.ua HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          resolve(JSON.parse(buf.toString('utf-8')));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('alerts.in.ua timeout'));
    });
  });
}

app.get('/api/v1/alerts-in-ua', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const token = process.env.ALERTS_IN_UA_TOKEN;
  if (!token || !token.trim()) {
    return res.json({
      status: 'no_token',
      hasToken: false,
      message: 'ALERTS_IN_UA_TOKEN не встановлено у .env. Використовуються дані NEPTUN.',
      alerts: []
    });
  }

  const now = Date.now();
  if (cachedAlertsInUa && (now - lastAlertsInUaFetch < ALERTS_IN_UA_CACHE_MS)) {
    return res.json({ ...cachedAlertsInUa, cached: true });
  }

  try {
    const data = await fetchAlertsInUaUpstream(token);
    cachedAlertsInUa = {
      status: 'ok',
      hasToken: true,
      source: 'alerts.in.ua',
      updatedAt: data.meta?.last_updated_at || new Date().toISOString(),
      disclaimer: data.disclaimer || null,
      alerts: Array.isArray(data.alerts) ? data.alerts : []
    };
    lastAlertsInUaFetch = now;
    res.json(cachedAlertsInUa);
  } catch (err) {
    console.warn('[ALERTS.IN.UA] Помилка запиту:', err.message);
    if (cachedAlertsInUa) {
      return res.json({ ...cachedAlertsInUa, stale: true, error: err.message });
    }
    res.status(502).json({
      status: 'error',
      hasToken: true,
      message: `Помилка зв'язку з alerts.in.ua: ${err.message}`,
      alerts: []
    });
  }
});

/* ============================================================
   КОНФІГУРАЦІЯ КАРТОГРАФІЧНОГО ПРОВАЙДЕРА (CARTO API)
============================================================ */
app.get('/api/v1/map-config', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const cartoKey = (
    process.env.CARTO_API_KEY ||
    process.env.MAP_API_KEY ||
    process.env.VITE_CARTO_API_KEY ||
    process.env.VITE_MAP_API_KEY ||
    ''
  ).trim();
  res.json({
    status: 'ok',
    provider: 'carto',
    hasKey: Boolean(cartoKey),
    apiKey: cartoKey
  });
});

// Серверний проксі для тайлів карти (на випадок якщо ключ не повинен бути у браузері)
app.get('/api/v1/map-tiles/:layer/:z/:x/:y.png', (req, res) => {
  const { layer, z, x, y } = req.params;
  const sanitizedLayer = layer === 'dark_only_labels' ? 'dark_only_labels' : 'dark_nolabels';
  const cartoKey = (
    process.env.CARTO_API_KEY ||
    process.env.MAP_API_KEY ||
    process.env.VITE_CARTO_API_KEY ||
    process.env.VITE_MAP_API_KEY ||
    ''
  ).trim();
  const subdomains = ['a', 'b', 'c', 'd'];
  const s = subdomains[Math.floor(Math.random() * subdomains.length)];
  const keyParam = cartoKey ? `?key=${encodeURIComponent(cartoKey)}` : '';
  const targetUrl = `https://${s}.basemaps.cartocdn.com/rastertiles/${sanitizedLayer}/${z}/${x}/${y}.png${keyParam}`;

  https.get(targetUrl, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode, {
      'Content-Type': upstreamRes.headers['content-type'] || 'image/png',
      'Cache-Control': upstreamRes.headers['cache-control'] || 'public, max-age=86400'
    });
    upstreamRes.pipe(res);
  }).on('error', () => {
    res.status(502).end();
  });
});

// Статус аналітичного сервісу ШІ
app.get('/api/v1/llm-status', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const hasKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
  const isCooldown = Date.now() < geminiCooldownUntil;
  const cooldownSec = isCooldown ? Math.ceil((geminiCooldownUntil - Date.now()) / 1000) : 0;

  res.json({
    status: 'ok',
    engine: hasKey && !isCooldown ? `Gemini Free Tier (${GEMINI_MODEL})` : 'local-nlp',
    model: hasKey ? GEMINI_MODEL : 'local-nlp-heuristics',
    tier: 'Free Tier',
    hasApiKey: hasKey,
    isFallback: isCooldown || !hasKey,
    fallbackReason: isCooldown ? geminiLastError : (!hasKey ? 'Відсутній GEMINI_API_KEY у .env' : null),
    cooldownRemainingSec: cooldownSec,
    lastSuccess: geminiLastSuccessTime,
    cacheEntries: llmAnalysisCache.size
  });
});

// Аналіз повідомлення через Gemini Free Tier або локальний NLP
app.post('/api/v1/analyze-message', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const { message, followedTerritories } = req.body || {};
    if (!message || !message.text) {
      return res.status(400).json({ error: 'Потрібно надати обєкт message з полем text' });
    }

    const text = String(message.text || '').trim();
    if (text.length < 3) {
      return res.json({ success: true, analysis: null });
    }

    // Дедуплікація за ID або нормалізованим початком тексту
    const normSnippet = text.slice(0, 70).toLowerCase().replace(/\s+/g, ' ');
    const cacheKey = message.id || `${message.channel || ''}::${normSnippet}`;

    if (llmAnalysisCache.has(cacheKey)) {
      return res.json({ success: true, cached: true, analysis: llmAnalysisCache.get(cacheKey) });
    }

    let analysis = null;
    const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;

    if (apiKey && Date.now() >= geminiCooldownUntil) {
      try {
        analysis = await analyzeWithGemini(text, followedTerritories, apiKey);
      } catch (err) {
        console.warn('[LLM-SERVICE] Fallback на локальний NLP:', err.message);
      }
    }

    // Автоматичний fallback на надійний евристичний локальний NLP
    if (!analysis) {
      analysis = analyzeWithLocalNlp(text, followedTerritories);
      if (apiKey && geminiLastError) {
        analysis.fallbackNotice = geminiLastError;
      }
    }

    if (llmAnalysisCache.size >= MAX_LLM_CACHE) {
      const firstKey = llmAnalysisCache.keys().next().value;
      llmAnalysisCache.delete(firstKey);
    }
    llmAnalysisCache.set(cacheKey, analysis);

    return res.json({
      success: true,
      cached: false,
      analysis
    });
  } catch (err) {
    console.error('[LLM-SERVICE] Критична помилка обробки:', err);
    res.status(500).json({ error: 'Помилка аналізу повідомлення', details: err.message });
  }
});

// 8. SSE стрім
app.get('/api/v1/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);

  const syncPayload = {
    version:   stateVersion,
    updatedAt: stateUpdatedAt,
    raions:    Array.from(nationalRaions.values()),
    oblasts:   Array.from(nationalOblasts.values()),
    threats:   Array.from(nationalThreats.values())
  };
  res.write(`event: sync\ndata: ${JSON.stringify(syncPayload)}\n\n`, 'utf-8');

  req.on('close', () => {
    sseClients.delete(res);
  });
});

/* ============================================================
   ОПЕРАТОРСЬКІ ЕНДПОІНТИ
============================================================ */
app.post('/api/v1/alerts', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const b = req.body;
  if (!b) return res.status(400).json({ error: 'Порожнє тіло запиту' });

  stateVersion = Math.floor(Date.now() / 1000);
  stateUpdatedAt = new Date().toISOString();

  if (b.isRaion || b.district || (b.name && b.name.toLowerCase().includes('район'))) {
    const name = b.name || b.district;
    const oblast = b.oblast || b.region || '';
    const key = b.key || `${name.toLowerCase()}::${oblast.toLowerCase()}`;
    const level = (b.level || b.alertLevel || 'red').toLowerCase();
    const reasons = Array.isArray(b.reasons) ? b.reasons : (b.reason ? [b.reason] : []);

    const raionObj = {
      key,
      name,
      oblast,
      since: b.since || b.started_at || stateUpdatedAt,
      level,
      reasons
    };

    nationalRaions.set(key, raionObj);
    broadcastSSE('raion_update', raionObj);
    return res.status(201).json({ success: true, type: 'raion', data: raionObj });
  }

  const name = b.name || b.region;
  if (!name) return res.status(400).json({ error: 'Потрібно вказати назву території' });

  const key = b.key || name.toLowerCase();
  const oblast = b.oblast || (name.toLowerCase() === 'севастополь' ? 'Автономна Республіка Крим' : name);
  const level = (b.level || b.alertLevel || 'red').toLowerCase();

  const oblastObj = {
    key,
    name,
    oblast,
    since: b.since || b.started_at || stateUpdatedAt,
    level
  };

  nationalOblasts.set(key, oblastObj);
  broadcastSSE('oblast_update', oblastObj);
  return res.status(201).json({ success: true, type: 'oblast', data: oblastObj });
});

app.delete('/api/v1/alerts/:key', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const { key } = req.params;
  const decodedKey = decodeURIComponent(key).toLowerCase();

  stateVersion = Math.floor(Date.now() / 1000);
  stateUpdatedAt = new Date().toISOString();

  if (nationalRaions.has(decodedKey)) {
    const item = nationalRaions.get(decodedKey);
    nationalRaions.delete(decodedKey);
    broadcastSSE('raion_clear', item);
    return res.json({ success: true, key: decodedKey });
  }

  if (nationalOblasts.has(decodedKey)) {
    const item = nationalOblasts.get(decodedKey);
    nationalOblasts.delete(decodedKey);
    broadcastSSE('oblast_clear', item);
    return res.json({ success: true, key: decodedKey });
  }

  res.status(404).json({ error: 'Тривогу не знайдено' });
});

/* ============================================================
   ЗАПУСК СЕРВЕРА ТА GRACEFUL SHUTDOWN
============================================================ */
server.listen(PORT, () => {
  console.log('===============================================================');
  console.log('🇺🇦 [РАДАР — Національний моніторинг повітряного простору]');
  console.log(`🌐 Сервер запущено: http://localhost:${PORT}`);
  console.log(`📡 Upstream: ${NEPTUN_API_BASE} (Автоматична синхронізація)`);
  console.log('🔄 Клієнт опитує API кожні 5 секунд');
  console.log('===============================================================');
});

const gracefulShutdown = () => {
  console.log('\n[РАДАР] Завершення роботи сервера...');
  server.close(() => {
    console.log('[РАДАР] Сервер успішно зупинено.');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT',  gracefulShutdown);
