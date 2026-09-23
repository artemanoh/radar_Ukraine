/**
 * index.js
 * Головний серверний файл системи «РАДАР — Національний моніторинг повітряного простору».
 * Стек: Express + Socket.io + SQLite (better-sqlite3) + Telegram Bot API.
 * Підтримує реальні повідомлення та вбудовані тестові команди (/test_bpla, /test_ballistic, /test_recon).
 */

require('dotenv').config();
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const TelegramBot = require('node-telegram-bot-api');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'radar.db');

// Створення директорії для бази даних за потреби
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

/* ============================================================
   1. БАЗА ДАНИХ SQLITE (better-sqlite3)
============================================================ */
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS targets (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,                  -- 'bpla', 'cruise_missile', 'ballistic', 'avia', 'recon', 'clear'
    region TEXT NOT NULL,                -- Назва області (наприклад: 'Вінницька область')
    district TEXT NOT NULL,              -- Район або населений пункт
    lat REAL NOT NULL,                   -- Широта
    lng REAL NOT NULL,                   -- Довгота
    radius_km REAL NOT NULL,             -- Зона тривоги
    alertLevel_color TEXT NOT NULL,      -- Колір (#f85149 червоний, #f59e0b помаранчевий тощо)
    time TEXT NOT NULL,                  -- Форматований час події (HH:mm:ss)
    timestamp INTEGER NOT NULL,          -- UNIX час (мс)
    status TEXT NOT NULL DEFAULT 'active'-- 'active', 'archived'
  );

  CREATE INDEX IF NOT EXISTS idx_targets_status ON targets(status);
  CREATE INDEX IF NOT EXISTS idx_targets_region ON targets(region);
  CREATE INDEX IF NOT EXISTS idx_targets_timestamp ON targets(timestamp);
`);

console.log('[Database] Таблиця targets успішно ініціалізована.');

const insertTargetStmt = db.prepare(`
  INSERT INTO targets (id, type, region, district, lat, lng, radius_km, alertLevel_color, time, timestamp, status)
  VALUES (@id, @type, @region, @district, @lat, @lng, @radius_km, @alertLevel_color, @time, @timestamp, @status)
  ON CONFLICT(id) DO UPDATE SET
    type = excluded.type,
    region = excluded.region,
    district = excluded.district,
    lat = excluded.lat,
    lng = excluded.lng,
    radius_km = excluded.radius_km,
    alertLevel_color = excluded.alertLevel_color,
    time = excluded.time,
    timestamp = excluded.timestamp,
    status = excluded.status
`);

const getActiveTargetsStmt = db.prepare(`
  SELECT * FROM targets
  WHERE status = 'active'
  ORDER BY timestamp DESC
`);

const setTargetArchivedStmt = db.prepare(`
  UPDATE targets
  SET status = 'archived'
  WHERE id = ?
`);

/* ============================================================
   2. ГЕОГРАФІЧНІ КООРДИНАТИ РЕГІОНІВ ТА МІСТ УКРАЇНИ
============================================================ */
const REGION_CENTERS = {
  'Вінницька область': [49.2331, 28.4682],
  'Київська область': [50.4501, 30.5234],
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

/* ============================================================
   3. EXPRESS ТА SOCKET.IO СЕРВЕР
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
 * Створення та розсилка загрози по Socket.io
 * Формат події: { id, type, region, district, lat, lng, alertLevel_color, time, radius_km, timestamp }
 */
function broadcastTarget(data) {
  const now = Date.now();
  const timeStr = new Date(now).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const targetPayload = {
    id: data.id || `tgt_${now}_${Math.random().toString(36).substring(2, 6)}`,
    type: data.type || 'bpla',
    region: data.region || 'Вінницька область',
    district: data.district || data.region || 'Центр',
    lat: data.lat,
    lng: data.lng,
    radius_km: data.radius_km || (data.type === 'ballistic' ? 35 : data.type === 'cruise_missile' ? 30 : 15),
    alertLevel_color: data.alertLevel_color || (data.type === 'ballistic' || data.type === 'cruise_missile' ? '#f85149' : '#f59e0b'),
    time: timeStr,
    timestamp: now,
    status: 'active',
  };

  insertTargetStmt.run(targetPayload);

  // Відправляємо подію new_target усім підключеним клієнтам
  io.emit('new_target', targetPayload);
  console.log(`[Socket Broadcast: new_target] [${targetPayload.type.toUpperCase()}] ${targetPayload.district} (${targetPayload.region})`);

  return targetPayload;
}

// REST API
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), clients: io.engine.clientsCount });
});

app.get('/api/targets/active', (req, res) => {
  try {
    const targets = getActiveTargetsStmt.all();
    res.json({ success: true, count: targets.length, data: targets });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Емуляція через HTTP POST
app.post('/api/targets/simulate', (req, res) => {
  const { type, region, district, lat, lng } = req.body;
  const coords = (lat && lng) ? [lat, lng] : (REGION_CENTERS[region] || [48.3794, 31.1656]);

  const target = broadcastTarget({
    type: type || 'bpla',
    region: region || 'Вінницька область',
    district: district || 'Жмеринський район',
    lat: coords[0],
    lng: coords[1],
  });

  res.json({ success: true, target });
});

// Socket.io обробка клієнтів
io.on('connection', (socket) => {
  console.log(`[Socket] Новий клієнт підключився: ${socket.id} (Всього: ${io.engine.clientsCount})`);

  try {
    // При першому підключенні віддаємо всі поточні активні цілі
    const activeTargets = getActiveTargetsStmt.all();
    socket.emit('initial_targets', activeTargets);
  } catch (err) {
    console.error('[Socket Initial Error]', err.message);
  }

  socket.on('disconnect', () => {
    console.log(`[Socket] Клієнт відключився: ${socket.id}`);
  });
});

/* ============================================================
   4. TELEGRAM BOT СЛУХАЧ ТА СИМУЛЯЦІЙНІ КОМАНДИ
============================================================ */
const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;

if (botToken) {
  try {
    bot = new TelegramBot(botToken, { polling: true });
    console.log('[Telegram Bot] Бот успішно запущений у режимі Polling.');

    // Тестова команда 1: /test_bpla
    bot.onText(/\/test_bpla/, (msg) => {
      const coords = REGION_CENTERS['Вінницька область'];
      const target = broadcastTarget({
        type: 'bpla',
        region: 'Вінницька область',
        district: 'Жмеринський район',
        lat: coords[0] + (Math.random() - 0.5) * 0.1,
        lng: coords[1] + (Math.random() - 0.5) * 0.1,
        alertLevel_color: '#f59e0b',
        radius_km: 15,
      });
      bot.sendMessage(msg.chat.id, `✅ Змодельовано Ударний БПЛА: ${target.district} (${target.region})`);
    });

    // Тестова команда 2: /test_ballistic
    bot.onText(/\/test_ballistic/, (msg) => {
      const coords = REGION_CENTERS['Київська область'];
      const target = broadcastTarget({
        type: 'ballistic',
        region: 'Київська область',
        district: 'Броварський район',
        lat: coords[0] + (Math.random() - 0.5) * 0.08,
        lng: coords[1] + (Math.random() - 0.5) * 0.08,
        alertLevel_color: '#f85149',
        radius_km: 35,
      });
      bot.sendMessage(msg.chat.id, `🚨 Змодельовано Балістичну загрозу: ${target.district} (${target.region})`);
    });

    // Тестова команда 3: /test_recon
    bot.onText(/\/test_recon/, (msg) => {
      const coords = REGION_CENTERS['Одеська область'];
      const target = broadcastTarget({
        type: 'recon',
        region: 'Одеська область',
        district: 'Білгород-Дністровський район',
        lat: coords[0] + (Math.random() - 0.5) * 0.12,
        lng: coords[1] + (Math.random() - 0.5) * 0.12,
        alertLevel_color: '#a855f7',
        radius_km: 12,
      });
      bot.sendMessage(msg.chat.id, `🛰️ Змодельовано Розвідувальний БПЛА: ${target.district} (${target.region})`);
    });

    // Обробка звичайних текстових повідомлень від моніторингових каналів
    bot.on('message', (msg) => {
      const text = msg.text || msg.caption;
      if (!text || text.startsWith('/')) return;

      const lower = text.toLowerCase();
      let type = 'bpla';
      let color = '#f59e0b';
      let radius = 15;

      if (lower.includes('балістик') || lower.includes('іскандер-м') || lower.includes('кинджал')) {
        type = 'ballistic';
        color = '#f85149';
        radius = 35;
      } else if (lower.includes('ракета') || lower.includes('калібр') || lower.includes('х-101')) {
        type = 'cruise_missile';
        color = '#ef4444';
        radius = 30;
      } else if (lower.includes('розвід') || lower.includes('supercam') || lower.includes('zala') || lower.includes('орлан')) {
        type = 'recon';
        color = '#a855f7';
        radius = 12;
      } else if (lower.includes('авіація') || lower.includes('ту-') || lower.includes('су-')) {
        type = 'avia';
        color = '#38bdf8';
        radius = 45;
      }

      // Пошук згаданої області
      let matchedRegion = 'Вінницька область';
      for (const reg of Object.keys(REGION_CENTERS)) {
        const root = reg.split(' ')[0].toLowerCase().slice(0, 5);
        if (lower.includes(root)) {
          matchedRegion = reg;
          break;
        }
      }

      const center = REGION_CENTERS[matchedRegion] || [48.3794, 31.1656];
      broadcastTarget({
        type,
        region: matchedRegion,
        district: matchedRegion,
        lat: center[0] + (Math.random() - 0.5) * 0.1,
        lng: center[1] + (Math.random() - 0.5) * 0.1,
        alertLevel_color: color,
        radius_km: radius,
      });
    });

    bot.on('polling_error', (err) => console.error('[Telegram Polling Error]', err.code));
  } catch (err) {
    console.error('[Telegram Init Error]', err.message);
  }
} else {
  console.log('[Telegram Bot] TELEGRAM_BOT_TOKEN не задано. Доступна емуляція через REST API або UI.');
}

/* ============================================================
   5. АВТОМАТИЧНА АРХІВАЦІЯ (СМІТТЄЗБИРАЧ)
============================================================ */
setInterval(() => {
  try {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const expired = db.prepare('SELECT id, region FROM targets WHERE status = "active" AND timestamp < ?').all(cutoff);

    if (expired.length > 0) {
      expired.forEach((row) => {
        setTargetArchivedStmt.run(row.id);
        io.emit('target_cleared', { id: row.id, region: row.region });
      });
      console.log(`[Garbage Collector] Архівовано ${expired.length} застарілих цілей.`);
    }
  } catch (err) {
    console.error('[Cleanup Interval Error]', err.message);
  }
}, 5 * 60 * 1000);

/* ============================================================
   6. СТАРТ СЕРВЕРА
============================================================ */
server.listen(PORT, () => {
  console.log('==================================================');
  console.log(`🛰️ [РАДАР УКРАЇНА] Сервер запущено на порті :${PORT}`);
  console.log(`🌐 Веб-інтерфейс (Liquid Glass): http://localhost:${PORT}`);
  console.log(`⚡ WebSocket подія нової загрози: new_target`);
  console.log('==================================================');
});
