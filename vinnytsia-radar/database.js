/**
 * database.js
 * Модуль роботи з базою даних SQLite через better-sqlite3.
 * Забезпечує зберігання інцидентів, швидке читання та механізм архівації застарілих записів.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'radar.db');

// Перевіряємо існування директорії для бази даних
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Ініціалізація підключення до SQLite (з увімкненим WAL-режимом для максимальної швидкодії)
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Створення таблиць при старті застосунку
function initDatabase() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,               -- 'shahed', 'missile', 'avia', 'recon', 'clear'
      status TEXT NOT NULL DEFAULT 'active', -- 'active', 'clear', 'archived'
      location_name TEXT,              -- Назва населеного пункту/району
      lat REAL NOT NULL,               -- Широта
      lng REAL NOT NULL,               -- Довгота
      radius REAL DEFAULT 15,          -- Радіус загрози в кілометрах
      azimuth REAL,                    -- Напрямок руху у градусах (0-360) або null
      raw_text TEXT,                   -- Оригінальний текст повідомлення з Telegram
      timestamp INTEGER NOT NULL,      -- Час створення (UNIX timestamp в мс)
      updated_at INTEGER NOT NULL      -- Час останнього оновлення
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
    CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp);
  `;

  db.exec(createTableQuery);
  console.log('[Database] Таблиця alerts успішно ініціалізована.');
}

/**
 * Вставка або оновлення загрози в базі даних
 * @param {Object} alert - Об'єкт загрози
 */
function saveAlert(alert) {
  const stmt = db.prepare(`
    INSERT INTO alerts (id, type, status, location_name, lat, lng, radius, azimuth, raw_text, timestamp, updated_at)
    VALUES (@id, @type, @status, @location_name, @lat, @lng, @radius, @azimuth, @raw_text, @timestamp, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      status = excluded.status,
      location_name = excluded.location_name,
      lat = excluded.lat,
      lng = excluded.lng,
      radius = excluded.radius,
      azimuth = excluded.azimuth,
      raw_text = excluded.raw_text,
      updated_at = excluded.updated_at
  `);

  return stmt.run(alert);
}

/**
 * Отримання всіх активних загроз для початкового завантаження клієнтами
 * @returns {Array} Список активних інцидентів
 */
function getActiveAlerts() {
  const stmt = db.prepare(`
    SELECT * FROM alerts 
    WHERE status = 'active'
    ORDER BY timestamp DESC
  `);
  return stmt.all();
}

/**
 * Переведення загрози у статус 'clear' (відбій)
 * @param {string} id - Ідентифікатор запису
 */
function setAlertClear(id) {
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE alerts 
    SET status = 'clear', updated_at = ? 
    WHERE id = ?
  `);
  return stmt.run(now, id);
}

/**
 * Механізм очищення: архівування застарілих загроз (старших за 2 години без оновлень)
 * Повертає список ID загроз, які було архівовано
 */
function archiveOldAlerts(maxAgeMs = 2 * 60 * 60 * 1000) {
  const cutoffTime = Date.now() - maxAgeMs;

  const selectStmt = db.prepare(`
    SELECT id FROM alerts
    WHERE status = 'active' AND updated_at < ?
  `);
  const expired = selectStmt.all(cutoffTime);

  if (expired.length > 0) {
    const updateStmt = db.prepare(`
      UPDATE alerts
      SET status = 'archived', updated_at = ?
      WHERE status = 'active' AND updated_at < ?
    `);
    updateStmt.run(Date.now(), cutoffTime);
    console.log(`[Database Cleanup] Архівовано ${expired.length} застарілих загроз.`);
  }

  return expired.map(row => row.id);
}

// Запуск початкової ініціалізації
initDatabase();

module.exports = {
  db,
  saveAlert,
  getActiveAlerts,
  setAlertClear,
  archiveOldAlerts,
};
