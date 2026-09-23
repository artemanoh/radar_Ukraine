/**
 * telegramService.js
 * Сервіс підключення та обробки вхідних повідомлень з Telegram каналів.
 * Передає отриманий текст в AI-парсер, зберігає інцидент в SQLite та ініціює Socket.io розсилку.
 */

const TelegramBot = require('node-telegram-bot-api');
const { parseAlertMessage } = require('./aiParser');
const { saveAlert, setAlertClear } = require('./database');

class TelegramService {
  /**
   * @param {Object} io - Екземпляр Socket.io сервера для трансляції подій
   */
  constructor(io) {
    this.io = io;
    this.bot = null;
    this.allowedChannels = (process.env.ALLOWED_CHANNELS || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);
  }

  /**
   * Запуск бота в режимі Polling
   */
  start() {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      console.warn('[Telegram Service] TELEGRAM_BOT_TOKEN не задано. Бот не підключається. Очікування ручних або API подій.');
      return;
    }

    try {
      this.bot = new TelegramBot(token, { polling: true });

      this.bot.on('channel_post', (msg) => this.handleMessage(msg));
      this.bot.on('message', (msg) => this.handleMessage(msg));

      this.bot.on('polling_error', (error) => {
        console.error('[Telegram Polling Error]', error.code, error.message);
      });

      console.log('[Telegram Service] Бот успішно запущений і слухає вхідні повідомлення.');
    } catch (err) {
      console.error('[Telegram Init Error] Помилка запуску бота:', err.message);
    }
  }

  /**
   * Обробка сирого повідомлення з Telegram
   * @param {Object} msg - Повідомлення від Telegram Bot API
   */
  async handleMessage(msg) {
    const chatId = msg.chat?.id?.toString();
    const text = msg.text || msg.caption;

    if (!text) return;

    // Фільтрація по дозволених каналах, якщо список задано в .env
    if (this.allowedChannels.length > 0 && !this.allowedChannels.includes(chatId)) {
      return;
    }

    console.log(`[Telegram Inbound] Отримано повідомлення (${chatId}): "${text.slice(0, 80)}..."`);
    await this.processTextAlert(text, msg.message_id ? `tg_${chatId}_${msg.message_id}` : null);
  }

  /**
   * Обробка тексту: відправка в AI, збереження в БД та відправка по WebSocket
   * @param {string} text - Текст загрози
   * @param {string|null} customId - Унікальний ідентифікатор
   */
  async processTextAlert(text, customId = null) {
    try {
      const parsed = await parseAlertMessage(text);
      if (!parsed) {
        console.log('[Telegram Parser] Повідомлення проігноровано (не містить загроз).');
        return null;
      }

      const now = Date.now();
      const alertId = customId || `alert_${now}_${Math.random().toString(36).substring(2, 7)}`;

      const alertRecord = {
        id: alertId,
        type: parsed.type,
        status: parsed.status,
        location_name: parsed.location_name,
        lat: parsed.lat,
        lng: parsed.lng,
        radius: parsed.radius,
        azimuth: parsed.azimuth,
        raw_text: text,
        timestamp: now,
        updated_at: now,
      };

      // Збереження в SQLite
      saveAlert(alertRecord);

      // Якщо це відбій — транслюємо подію відбою
      if (parsed.status === 'clear') {
        this.io.emit('alert:clear', {
          id: alertRecord.id,
          location_name: alertRecord.location_name,
          timestamp: alertRecord.timestamp,
        });
        console.log(`[Socket Broadcast] Оголошено ВІДБІЙ: ${alertRecord.location_name}`);
      } else {
        // Трансляція нової або оновленої активної загрози всім клієнтам
        this.io.emit('alert:new', alertRecord);
        console.log(`[Socket Broadcast] Нова загроза [${alertRecord.type.toUpperCase()}] біля ${alertRecord.location_name} [${alertRecord.lat}, ${alertRecord.lng}]`);
      }

      return alertRecord;
    } catch (err) {
      console.error('[Telegram Processing Error]', err.message);
      return null;
    }
  }

  /**
   * Зупинка бота
   */
  stop() {
    if (this.bot) {
      this.bot.stopPolling();
      console.log('[Telegram Service] Бот зупинений.');
    }
  }
}

module.exports = TelegramService;
