/**
 * server.js
 * Головний серверний файл системи «РАДАР — Національний моніторинг повітряного простору».
 * Інтегрує Express, Socket.io, SQLite (better-sqlite3), Telegram Bot API та OpenAI аналітику.
 * Відправляє події: initial_state, new_alert, alert_cleared.
 */

require('dotenv').config();
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const TelegramBot = require('node-telegram-bot-api');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'radar.db');

// Перевірка існування директорії бази даних
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

/* ============================================================
   1. БАЗА ДАНИХ SQLITE (better-sqlite3)
============================================================ */
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Створення таблиці інцидентів
db.exec(`
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    threat_type TEXT NOT NULL,         -- 'bpla', 'missile', 'avia', 'clear'
    region TEXT NOT NULL,              -- Назва області (наприклад: 'Вінницька область')
    location_name TEXT NOT NULL,       -- Населений пункт або район
    lat REAL NOT NULL,                 -- Широта
    lng REAL NOT NULL,                 -- Довгота
    radius_km REAL NOT NULL,           -- Зона небезпеки (км)
    azimuth REAL,                      -- Напрямок руху (0-360)
    raw_text TEXT,                     -- Оригінальний текст сповіщення
    status TEXT NOT NULL DEFAULT 'active', -- 'active', 'archived'
    timestamp INTEGER NOT NULL,        -- Час появи (мс)
    updated_at INTEGER NOT NULL        -- Час оновлення (мс)
  );

  CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
  CREATE INDEX IF NOT EXISTS idx_incidents_region ON incidents(region);
  CREATE INDEX IF NOT EXISTS idx_incidents_timestamp ON incidents(timestamp);
`);

console.log('[Database] Таблиця incidents готова до роботи.');

// Підготовлені SQL-запити
const insertIncidentStmt = db.prepare(`
  INSERT INTO incidents (id, threat_type, region, location_name, lat, lng, radius_km, azimuth, raw_text, status, timestamp, updated_at)
  VALUES (@id, @threat_type, @region, @location_name, @lat, @lng, @radius_km, @azimuth, @raw_text, @status, @timestamp, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    threat_type = excluded.threat_type,
    region = excluded.region,
    location_name = excluded.location_name,
    lat = excluded.lat,
    lng = excluded.lng,
    radius_km = excluded.radius_km,
    azimuth = excluded.azimuth,
    raw_text = excluded.raw_text,
    status = excluded.status,
    updated_at = excluded.updated_at
`);

const getActiveIncidentsStmt = db.prepare(`
  SELECT * FROM incidents
  WHERE status = 'active'
  ORDER BY timestamp DESC
`);

const setIncidentArchivedStmt = db.prepare(`
  UPDATE incidents
  SET status = 'archived', updated_at = ?
  WHERE id = ?
`);

/* ============================================================
   2. ДОВІДНИК ОБЛАСТЕЙ ТА КООРДИНАТ ЦЕНТРІВ УКРАЇНИ
============================================================ */
const UKRAINE_REGIONS = {
  'Вінницька область': [49.2331, 28.4682],
  'Київська область': [50.4501, 30.5234],
  'м. Київ': [50.4501, 30.5234],
  'Харківська область': [49.9935, 36.2304],
  'Дніпропетровська область': [48.4647, 35.0462],
  'Одеська область': [46.4825, 30.7233],
  'Львівська область': [49.8397, 24.0297],
  'Запорізька область': [47.8388, 35.1396],
  'Миколаївська область': [46.9750, 31.9946],
  'Полтавська область': [49.5883, 34.5514],
  'Черкаська область': [49.4444, 32.0598],
  'Житомирська область': [50.2547, 28.6587],
  'Сумська область': [50.9077, 34.7981],
  'Чернігівська область': [51.4982, 31.2893],
  'Хмельницька область': [49.4230, 26.9871],
  'Рівненська область': [50.6199, 26.2516],
  'Волинська область': [50.7472, 25.3254],
  'Івано-Франківська область': [48.9226, 24.7111],
  'Тернопільська область': [49.5535, 25.5948],
  'Закарпатська область': [48.6208, 22.2879],
  'Чернівецька область': [48.2917, 25.9352],
  'Кіровоградська область': [48.5079, 32.2623],
  'Херсонська область': [46.6354, 32.6169],
  'Донецька область': [48.0159, 37.8028],
  'Луганська область': [48.5740, 39.3078],
  'Автономна Республіка Крим': [44.9521, 34.1024]
};

function findRegionCoords(regionName) {
  if (!regionName) return [48.3794, 31.1656];
  for (const [name, coords] of Object.entries(UKRAINE_REGIONS)) {
    if (regionName.toLowerCase().includes(name.split(' ')[0].toLowerCase())) {
      return coords;
    }
  }
  return [48.3794, 31.1656];
}

/* ============================================================
   3. МОДУЛЬ ШІ-АНАЛІЗУ (OPENAI + РЕЗЕРВНИЙ ПАРСЕР)
============================================================ */
let openaiClient = null;
if (process.env.OPENAI_API_KEY) {
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function parseLocally(text) {
  const lower = text.toLowerCase();

  // Визначення відбою
  if (lower.includes('відбій') || lower.includes('чисто') || lower.includes('загроз немає')) {
    return {
      threat_type: 'clear',
      region: 'Вся Україна',
      location_name: 'Повітряний простір чистий',
      coordinates: [48.3794, 31.1656],
      radius_km: 30,
      azimuth: null,
      status: 'archived',
    };
  }

  let threat_type = 'bpla';
  let radius_km = 15;

  if (lower.includes('ракета') || lower.includes('калібр') || lower.includes('х-101') || lower.includes('кинджал') || lower.includes('балістик') || lower.includes('іскандер')) {
    threat_type = 'missile';
    radius_km = 30;
  } else if (lower.includes('авіація') || lower.includes('ту-22') || lower.includes('ту-95') || lower.includes('міг-31') || lower.includes('су-34')) {
    threat_type = 'avia';
    radius_km = 50;
  }

  let matchedRegion = 'Вінницька область';
  for (const regionName of Object.keys(UKRAINE_REGIONS)) {
    const root = regionName.split(' ')[0].toLowerCase().slice(0, 5);
    if (lower.includes(root)) {
      matchedRegion = regionName;
      break;
    }
  }

  let azimuth = null;
  if (lower.includes('на північ') || lower.includes('пн')) azimuth = 0;
  else if (lower.includes('на схід') || lower.includes('сх')) azimuth = 90;
  else if (lower.includes('на південь') || lower.includes('пд')) azimuth = 180;
  else if (lower.includes('на захід') || lower.includes('зх')) azimuth = 270;
  else if (lower.includes('пн-сх') || lower.includes('північно-схід')) azimuth = 45;
  else if (lower.includes('пд-сх') || lower.includes('південно-схід')) azimuth = 135;
  else if (lower.includes('пд-зх') || lower.includes('південно-захід')) azimuth = 225;
  else if (lower.includes('пн-зх') || lower.includes('північно-захід')) azimuth = 315;

  const coords = findRegionCoords(matchedRegion);

  return {
    threat_type,
    region: matchedRegion,
    location_name: matchedRegion,
    coordinates: coords,
    radius_km,
    azimuth,
    status: 'active',
  };
}

async function analyzeTextWithAI(rawText) {
  if (!rawText || !rawText.trim()) return null;

  if (!openaiClient) {
    return parseLocally(rawText);
  }

  const prompt = `
Ти — високоточний аналізатор повітряної обстановки в Україні.
Проаналізуй оперативне повідомлення та поверни СУВОРИЙ JSON:
{
  "is_relevant": boolean,
  "threat_type": "bpla" | "missile" | "avia" | "clear",
  "region": string, // Точна офіційна назва області (наприклад: "Вінницька область", "Київська область", "Одеська область" тощо)
  "location_name": string, // Конкретне місто, селище або район
  "coordinates": [lat, lng], // Координати місця події. Якщо точно невідомо — координати центру вказаної області
  "radius_km": number, // За замовчуванням 15 для bpla, 30 для missile, 50 для avia
  "azimuth": number | null, // Напрямок польоту у градусах (0 - Північ, 90 - Схід, 180 - Південь, 270 - Захід)
  "status": "active" | "archived"
}
Правила:
- Якщо повідомлення про відбій чи чисте небо: threat_type: "clear", status: "archived".
- Відповідай ТІЛЬКИ валідним JSON без зайвого тексту.
`;

  try {
    const response = await openaiClient.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: rawText },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    if (parsed.is_relevant === false) return null;

    let coords = parsed.coordinates;
    if (!Array.isArray(coords) || coords.length !== 2 || typeof coords[0] !== 'number') {
      coords = findRegionCoords(parsed.region);
    }

    return {
      threat_type: ['bpla', 'missile', 'avia', 'clear'].includes(parsed.threat_type) ? parsed.threat_type : 'bpla',
      region: parsed.region || 'Вінницька область',
      location_name: parsed.location_name || parsed.region || 'Україна',
      coordinates: coords,
      radius_km: typeof parsed.radius_km === 'number' ? parsed.radius_km : (parsed.threat_type === 'missile' ? 30 : 15),
      azimuth: typeof parsed.azimuth === 'number' ? parsed.azimuth : null,
      status: parsed.status === 'archived' ? 'archived' : 'active',
    };
  } catch (err) {
    console.warn('[OpenAI Fallback]', err.message);
    return parseLocally(rawText);
  }
}

/* ============================================================
   4. СЕРВЕР EXPRESS ТА REAL-TIME SOCKET.IO
============================================================ */
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 15000,
});

/**
 * Обробка та трансляція подій клієнтам:
 * - new_alert (нова загроза)
 * - alert_cleared (відбій або закриття загрози)
 */
async function processAndBroadcastAlert(text, customId = null) {
  const parsed = await analyzeTextWithAI(text);
  if (!parsed) return null;

  const now = Date.now();
  const alertId = customId || `alt_${now}_${Math.random().toString(36).substring(2, 6)}`;

  const incident = {
    id: alertId,
    threat_type: parsed.threat_type,
    region: parsed.region,
    location_name: parsed.location_name,
    lat: parsed.coordinates[0],
    lng: parsed.coordinates[1],
    radius_km: parsed.radius_km,
    azimuth: parsed.azimuth,
    raw_text: text,
    status: parsed.status,
    timestamp: now,
    updated_at: now,
  };

  insertIncidentStmt.run(incident);

  if (incident.status === 'archived' || incident.threat_type === 'clear') {
    io.emit('alert_cleared', { id: incident.id, region: incident.region });
    console.log(`[Socket Broadcast: alert_cleared] ${incident.location_name} (${incident.region})`);
  } else {
    io.emit('new_alert', incident);
    console.log(`[Socket Broadcast: new_alert] [${incident.threat_type.toUpperCase()}] ${incident.location_name} (${incident.region})`);
  }

  return incident;
}

// REST API ендпоінти
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    clients: io.engine.clientsCount,
    timestamp: Date.now(),
  });
});

app.get('/api/alerts/active', (req, res) => {
  try {
    const alerts = getActiveIncidentsStmt.all();
    res.json({ success: true, count: alerts.length, data: alerts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/alerts/simulate', async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ success: false, error: 'Поле text є обов’язковим' });
  }
  try {
    const alert = await processAndBroadcastAlert(text);
    res.json({ success: true, alert });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Socket.io події (initial_state, new_alert, alert_cleared)
io.on('connection', (socket) => {
  console.log(`[Socket] Новий клієнт підключився: ${socket.id} (Всього: ${io.engine.clientsCount})`);

  try {
    const activeAlerts = getActiveIncidentsStmt.all();
    // Відправляємо подію initial_state новому клієнту
    socket.emit('initial_state', activeAlerts);
  } catch (err) {
    console.error('[Socket Initial Error]', err.message);
  }

  socket.on('disconnect', () => {
    console.log(`[Socket] Клієнт відключився: ${socket.id}`);
  });
});

/* ============================================================
   5. СМІТТЄЗБИРАЧ (GARBAGE COLLECTOR ЗАСТАРІЛИХ ЗАГРОЗ)
============================================================ */
// Застарілі загрози (понад 2 години без оновлень) автоматично стають archived, клієнтам летить alert_cleared
setInterval(() => {
  try {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const expired = db.prepare('SELECT id, region FROM incidents WHERE status = "active" AND updated_at < ?').all(cutoff);

    if (expired.length > 0) {
      const now = Date.now();
      expired.forEach((row) => {
        setIncidentArchivedStmt.run(now, row.id);
        io.emit('alert_cleared', { id: row.id, region: row.region });
      });
      console.log(`[Garbage Collector] Автоматично архівовано ${expired.length} застарілих цілей (alert_cleared).`);
    }
  } catch (err) {
    console.error('[Garbage Collector Error]', err.message);
  }
}, 5 * 60 * 1000);

/* ============================================================
   6. TELEGRAM BOT СЛУХАЧ
============================================================ */
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (botToken) {
  try {
    const bot = new TelegramBot(botToken, { polling: true });
    const allowed = (process.env.ALLOWED_CHANNELS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const onMessage = async (msg) => {
      const chatId = msg.chat?.id?.toString();
      const text = msg.text || msg.caption;
      if (!text) return;
      if (allowed.length > 0 && !allowed.includes(chatId)) return;

      console.log(`[Telegram Inbound] ${chatId}: "${text.slice(0, 60)}..."`);
      await processAndBroadcastAlert(text, msg.message_id ? `tg_${chatId}_${msg.message_id}` : null);
    };

    bot.on('channel_post', onMessage);
    bot.on('message', onMessage);
    bot.on('polling_error', (err) => console.error('[Telegram Polling Error]', err.code));

    console.log('[Telegram Service] Бот успішно запущений і слухає моніторингові канали.');
  } catch (err) {
    console.error('[Telegram Init Error]', err.message);
  }
} else {
  console.log('[Telegram Service] TELEGRAM_BOT_TOKEN не задано. Сервер працює у режимі емуляції/API.');
}

/* ============================================================
   7. СТАРТ СЕРВЕРА
============================================================ */
server.listen(PORT, () => {
  console.log('==================================================');
  console.log(`🛰️ [РАДАР УКРАЇНА] Сервер запущено на порті :${PORT}`);
  console.log(`🌐 Веб-інтерфейс: http://localhost:${PORT}`);
  console.log(`⚡ Події: initial_state, new_alert, alert_cleared`);
  console.log('==================================================');
});
