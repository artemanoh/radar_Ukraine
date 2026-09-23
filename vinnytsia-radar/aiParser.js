/**
 * aiParser.js
 * Загальнонаціональний модуль парсингу оперативних повідомлень про повітряні загрози.
 * Підтримує всі 24 області України + АР Крим, райони та ключові міста.
 */

const { OpenAI } = require('openai');

// База координат обласних центрів та ключових вузлових міст України
const UKRAINE_LOCATIONS = {
  // Обласні центри та головні міста
  'київ': [50.4501, 30.5234],
  'біла церква': [49.7989, 30.1153],
  'бровари': [50.5114, 30.7903],
  'бориспіль': [50.3542, 30.9547],
  'вінниця': [49.2331, 28.4682],
  'жмеринка': [49.0372, 28.1097],
  'хмільник': [49.5569, 27.9572],
  'могилів-подільський': [48.4552, 27.7958],
  'дніпро': [48.4647, 35.0462],
  'кривий ріг': [47.9105, 33.3918],
  'кам\'янське': [48.5167, 34.6167],
  'нікополь': [47.5667, 34.4000],
  'павлоград': [48.5167, 35.8667],
  'одеса': [46.4825, 30.7233],
  'ізмаїл': [45.3500, 28.8333],
  'чорноморськ': [46.3000, 30.6500],
  'харків': [49.9935, 36.2304],
  'ізюм': [49.2000, 37.2833],
  'чугуїв': [49.8356, 36.6842],
  'лозова': [48.8833, 36.3167],
  'куп\'янськ': [49.7000, 37.6167],
  'львів': [49.8397, 24.0297],
  'дрогобич': [49.3500, 23.5000],
  'червоноград': [50.4167, 24.2333],
  'стрий': [49.2500, 23.8500],
  'запоріжжя': [47.8388, 35.1396],
  'мелітополь': [46.8489, 35.3653],
  'бердянськ': [46.7561, 36.7869],
  'миколаїв': [46.9750, 31.9946],
  'вознесенськ': [47.5667, 31.3333],
  'первомайськ': [48.0500, 30.8500],
  'полтава': [49.5883, 34.5514],
  'кременчук': [49.0667, 33.4167],
  'миргород': [49.9667, 33.6000],
  'лубни': [50.0167, 33.0000],
  'черкаси': [49.4444, 32.0598],
  'умань': [48.7500, 30.2167],
  'сміла': [49.2167, 31.8667],
  'золотоноша': [49.6667, 32.0500],
  'житомир': [50.2547, 28.6587],
  'бердичів': [49.9000, 28.5833],
  'коростень': [50.9500, 28.6500],
  'новоград-волинський': [50.5833, 27.6333],
  'звагель': [50.5833, 27.6333],
  'суми': [50.9077, 34.7981],
  'конотоп': [51.2333, 33.2000],
  'шостка': [51.8667, 33.4833],
  'охтирка': [50.3167, 34.9000],
  'чернігів': [51.4982, 31.2893],
  'ніжин': [51.0500, 31.8833],
  'прилуки': [50.5833, 32.3833],
  'хмельницький': [49.4230, 26.9871],
  'кам\'янець-подільський': [48.6833, 26.5833],
  'шепетівка': [50.1833, 27.0667],
  'рівне': [50.6199, 26.2516],
  'дубно': [50.4167, 25.7333],
  'ва Multiple': [51.3500, 25.8500],
  'луцьк': [50.7472, 25.3254],
  'ковель': [51.2167, 24.7167],
  'нововолинськ': [50.7333, 24.1667],
  'івано-франківськ': [48.9226, 24.7111],
  'коломия': [48.5333, 25.0333],
  'калуш': [49.0333, 24.3667],
  'тернопіль': [49.5535, 25.5948],
  'чортків': [49.0167, 25.8000],
  'ужгород': [48.6208, 22.2879],
  'мукачево': [48.4500, 22.7167],
  'хуст': [48.1667, 23.3000],
  'чернівці': [48.2917, 25.9352],
  'кропивницький': [48.5079, 32.2623],
  'олександрія': [48.6667, 33.1167],
  'херсон': [46.6354, 32.6169],
  'нова каховка': [46.7500, 33.3667],
  'донецьк': [48.0159, 37.8028],
  'маріуполь': [47.0951, 37.5413],
  'краматорськ': [48.7392, 37.5839],
  'слов\'янськ': [48.8533, 37.6253],
  'покровськ': [48.2833, 37.1833],
  'ба Sister': [48.6000, 38.0000],
  'луганськ': [48.5740, 39.3078],
  'сіверськодонецьк': [48.9481, 38.4919],
  'севастополь': [44.6166, 33.5254],
  'сімферополь': [44.9521, 34.1024],
};

let openaiClient = null;

function getOpenAIClient() {
  if (!openaiClient && process.env.OPENAI_API_KEY) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openaiClient;
}

/**
 * Локальний евристичний аналізатор
 */
function localFallbackParser(text) {
  const lower = text.toLowerCase();
  
  if (lower.includes('відбій') || lower.includes('чисто') || lower.includes('загроз немає')) {
    return {
      type: 'clear',
      status: 'clear',
      location_name: 'Україна',
      lat: 49.0139,
      lng: 31.2858,
      radius: 40,
      azimuth: null,
      confidence: 0.9,
    };
  }

  let type = 'recon';
  if (lower.includes('шахед') || lower.includes('бпла') || lower.includes('дрон') || lower.includes('shahed') || lower.includes('мопед') || lower.includes('герань')) {
    type = 'shahed';
  } else if (lower.includes('ракета') || lower.includes('калібр') || lower.includes('х-101') || lower.includes('кинджал') || lower.includes('іскандер') || lower.includes('балістик')) {
    type = 'missile';
  } else if (lower.includes('авіація') || lower.includes('ту-22') || lower.includes('ту-95') || lower.includes('міг-31') || lower.includes('су-34')) {
    type = 'avia';
  }

  let matchedLocation = 'Центр України';
  let coords = [49.0139, 31.2858];

  for (const [place, placeCoords] of Object.entries(UKRAINE_LOCATIONS)) {
    if (lower.includes(place)) {
      matchedLocation = place.charAt(0).toUpperCase() + place.slice(1);
      coords = placeCoords;
      break;
    }
  }

  let azimuth = null;
  if (lower.includes('на північ') || lower.includes('північн')) azimuth = 0;
  else if (lower.includes('на схід') || lower.includes('східн')) azimuth = 90;
  else if (lower.includes('на південь') || lower.includes('південн')) azimuth = 180;
  else if (lower.includes('на захід') || lower.includes('західн')) azimuth = 270;
  else if (lower.includes('північно-схід') || lower.includes('пн-сх')) azimuth = 45;
  else if (lower.includes('південно-схід') || lower.includes('пд-сх')) azimuth = 135;
  else if (lower.includes('південно-захід') || lower.includes('пд-зх')) azimuth = 225;
  else if (lower.includes('північно-захід') || lower.includes('пн-зх')) azimuth = 315;

  return {
    type,
    status: 'active',
    location_name: matchedLocation,
    lat: coords[0],
    lng: coords[1],
    radius: type === 'missile' ? 25 : 15,
    azimuth,
    confidence: 0.75,
  };
}

/**
 * Парсер через OpenAI API
 */
async function parseAlertMessage(rawText) {
  if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
    return null;
  }

  const client = getOpenAIClient();

  if (!client) {
    return localFallbackParser(rawText);
  }

  const systemPrompt = `
Ти — високоточний аналітичний парсер для загальнонаціональної системи моніторингу повітряного простору "Радар" (Україна).
Твоє завдання — проаналізувати текст оперативного повідомлення з моніторингового каналу та витягти суворо структуровані JSON дані по будь-якій області, району чи місту України.

Центр України: [49.0139, 31.2858].

Формат виходу (JSON):
{
  "is_threat_related": boolean,   // Чи стосується повідомлення повітряної обстановки (БПЛА, ракети, тривоги, відбої)
  "type": "shahed" | "missile" | "avia" | "recon" | "clear",
  "status": "active" | "clear",
  "location_name": string,        // Назва населеного пункту/району/області (наприклад: "Умань", "Кременчук", "Харків", "Житомирський район")
  "lat": number,                  // Широта центру згаданої локації в Україні
  "lng": number,                  // Довгота центру згаданої локації в Україні
  "radius": number,               // Радіус зони небезпеки у км (15 для БпЛА, 25-30 для ракет, 50 для авіації)
  "azimuth": number | null,       // Напрямок руху в градусах: 0 - Північ, 90 - Схід, 180 - Південь, 270 - Захід. Або null
  "confidence": number            // Рівень впевненості моделі від 0.0 до 1.0
}

Правила:
1. Якщо повідомлення про відбій ("відбій", "чисто", "загроз немає") -> status: "clear", type: "clear".
2. Знайди найбільш точні географічні координати згаданого населеного пункту/району в Україні.
3. Повертай ТІЛЬКИ чистий валідний JSON.
`;

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: rawText },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const parsedContent = JSON.parse(response.choices[0].message.content);

    if (parsedContent.is_threat_related === false) {
      return null;
    }

    return {
      type: ['shahed', 'missile', 'avia', 'recon', 'clear'].includes(parsedContent.type) 
        ? parsedContent.type 
        : 'recon',
      status: parsedContent.status === 'clear' ? 'clear' : 'active',
      location_name: parsedContent.location_name || 'Україна',
      lat: typeof parsedContent.lat === 'number' ? parsedContent.lat : 49.0139,
      lng: typeof parsedContent.lng === 'number' ? parsedContent.lng : 31.2858,
      radius: typeof parsedContent.radius === 'number' ? parsedContent.radius : 15,
      azimuth: typeof parsedContent.azimuth === 'number' ? parsedContent.azimuth : null,
      confidence: typeof parsedContent.confidence === 'number' ? parsedContent.confidence : 0.85,
    };
  } catch (error) {
    console.error('[AI Parser Error]', error.message);
    return localFallbackParser(rawText);
  }
}

module.exports = {
  parseAlertMessage,
  UKRAINE_LOCATIONS,
};
