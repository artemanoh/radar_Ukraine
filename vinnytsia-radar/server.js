/**
 * server.js
 * Головний серверний файл: Express + Socket.io + SQLite + TelegramService.
 * Забезпечує REST API, роздачу статичного фронтенду та real-time зв'язок.
 */

require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const { getActiveAlerts, archiveOldAlerts, saveAlert, setAlertClear } = require('./database');
const TelegramService = require('./telegramService');

const app = express();
const server = http.createServer(app);

// Налаштування CORS та парсерів тіла запитів
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Роздача статичних файлів клієнта (public/)
app.use(express.static(path.join(__dirname, 'public')));

// Налаштування Socket.io з безпечними параметрами підключення
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 30000,
  pingInterval: 15000,
});

// Ініціалізація сервісу Telegram
const telegramService = new TelegramService(io);
telegramService.start();

/* ============================================================
   REST API ЕНДПОІНТИ
============================================================ */

/**
 * Перевірка працездатності сервера
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    active_connections: io.engine.clientsCount,
    timestamp: Date.now(),
  });
});

/**
 * Отримання всіх активних загроз для початкового рендеру карти клієнтом
 */
app.get('/api/alerts/active', (req, res) => {
  try {
    const alerts = getActiveAlerts();
    res.json({
      success: true,
      count: alerts.length,
      data: alerts,
    });
  } catch (err) {
    console.error('[API /api/alerts/active Error]', err);
    res.status(500).json({ success: false, error: 'Помилка отримання даних з бази.' });
  }
});

/**
 * Ендпоінт для ручного додавання або тестування тривог (симуляція повідомлення з каналу)
 */
app.post('/api/alerts/simulate', async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ success: false, error: 'Поле text є обов’язковим' });
  }

  try {
    const result = await telegramService.processTextAlert(text);
    if (!result) {
      return res.json({ success: true, message: 'Повідомлення оброблено, але загроз не виявлено.' });
    }
    return res.json({ success: true, alert: result });
  } catch (err) {
    console.error('[API /api/alerts/simulate Error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Ендпоінт для примусового оголошення відбою по ID або локації
 */
app.post('/api/alerts/clear', (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, error: 'Поле id є обов’язковим' });
  }

  try {
    setAlertClear(id);
    io.emit('alert:clear', { id, timestamp: Date.now() });
    res.json({ success: true, message: `Загрозу ${id} переведено у статус відбою.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   SOCKET.IO ПОДІЇ
============================================================ */

io.on('connection', (socket) => {
  console.log(`[Socket] Нове підключення клієнта: ${socket.id} (Всього: ${io.engine.clientsCount})`);

  // Відправляємо новому клієнту повний актуальний зріз активних загроз
  try {
    const currentAlerts = getActiveAlerts();
    socket.emit('initial:state', currentAlerts);
  } catch (err) {
    console.error('[Socket Initial State Error]', err.message);
  }

  socket.on('disconnect', (reason) => {
    console.log(`[Socket] Клієнт відключився: ${socket.id} (${reason})`);
  });

  socket.on('error', (err) => {
    console.error(`[Socket Error] Клієнт ${socket.id}:`, err);
  });
});

/* ============================================================
   ПЕРІОДИЧНЕ ОЧИЩЕННЯ ТА ЗБЕРЕЖЕННЯ
============================================================ */

// Кожні 5 хвилин перевіряємо наявність загроз, старіших за 2 години
setInterval(() => {
  try {
    const archivedIds = archiveOldAlerts(2 * 60 * 60 * 1000);
    if (archivedIds && archivedIds.length > 0) {
      archivedIds.forEach((id) => {
        io.emit('alert:archived', { id });
      });
    }
  } catch (err) {
    console.error('[Cleanup Interval Error]', err.message);
  }
}, 5 * 60 * 1000);

/* ============================================================
   ЗАПУСК СЕРВЕРА
============================================================ */

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('==================================================');
  console.log(`🚀 [Вінниця Радар] Сервер успішно запущено на порті :${PORT}`);
  console.log(`📡 Веб-інтерфейс доступний за адресою: http://localhost:${PORT}`);
  console.log(`⚡ WebSocket працює в режимі реального часу`);
  console.log('==================================================');
});

// Безпечне завершення роботи сервісу (Graceful Shutdown)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] Отримано сигнал ${signal}. Завершення роботи...`);
  telegramService.stop();
  io.close(() => {
    server.close(() => {
      console.log('[Shutdown] HTTP & Socket.io сервери зупинено.');
      process.exit(0);
    });
  });
}
