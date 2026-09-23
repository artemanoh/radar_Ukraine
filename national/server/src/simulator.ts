import { Target, TargetType, AlarmZone, AlarmType } from './types.js';
import { v4 as uuidv4 } from 'uuid';

// Ukraine's 25 oblasts with centers and approximate borders
const OBLASTS: Record<string, { name_ua: string; center: [number, number]; bounds: [number, number, number, number] }> = {
  'vinnytsia': { name_ua: 'Вінницька', center: [49.23, 28.47], bounds: [27.0, 48.2, 29.8, 50.2] },
  'volyn': { name_ua: 'Волинська', center: [50.76, 25.32], bounds: [23.5, 50.0, 27.0, 52.0] },
  'dnipropetrovsk': { name_ua: 'Дніпропетровська', center: [48.45, 35.09], bounds: [33.0, 47.3, 36.8, 49.3] },
  'donetsk': { name_ua: 'Донецька', center: [48.02, 37.80], bounds: [36.0, 47.0, 39.5, 49.5] },
  'zhytomyr': { name_ua: 'Житомирська', center: [50.27, 28.67], bounds: [26.5, 49.5, 30.5, 51.5] },
  'zakarpattia': { name_ua: 'Закарпатська', center: [48.40, 23.30], bounds: [22.0, 47.8, 24.8, 49.2] },
  'zaporizhzhia': { name_ua: 'Запорізька', center: [47.84, 35.17], bounds: [33.5, 46.5, 36.7, 48.5] },
  'ivano_frankivsk': { name_ua: 'Івано-Франківська', center: [48.92, 24.71], bounds: [23.3, 47.8, 25.5, 49.5] },
  'kyiv_oblast': { name_ua: 'Київська', center: [50.05, 30.10], bounds: [28.8, 49.2, 32.5, 51.8] },
  'kyiv_city': { name_ua: 'м. Київ', center: [50.45, 30.52], bounds: [30.2, 50.2, 30.9, 50.6] },
  'kirovohrad': { name_ua: 'Кіровоградська', center: [48.51, 32.27], bounds: [30.2, 47.8, 33.7, 49.7] },
  'luhansk': { name_ua: 'Луганська', center: [48.57, 39.31], bounds: [37.5, 47.8, 40.2, 50.2] },
  'lviv': { name_ua: 'Львівська', center: [49.84, 24.03], bounds: [22.5, 49.0, 25.0, 50.9] },
  'mykolaiv': { name_ua: 'Миколаївська', center: [46.97, 31.99], bounds: [30.0, 46.0, 32.8, 48.0] },
  'odessa': { name_ua: 'Одеська', center: [46.49, 30.73], bounds: [28.2, 45.2, 32.0, 47.8] },
  'poltava': { name_ua: 'Полтавська', center: [49.59, 34.56], bounds: [32.5, 48.7, 35.8, 50.7] },
  'rivne': { name_ua: 'Рівненська', center: [50.62, 26.25], bounds: [25.0, 50.0, 27.5, 51.8] },
  'sumy': { name_ua: 'Сумська', center: [50.92, 34.80], bounds: [32.8, 50.0, 35.8, 52.0] },
  'ternopil': { name_ua: 'Тернопільська', center: [49.55, 25.59], bounds: [24.5, 49.0, 26.5, 50.3] },
  'kharkiv': { name_ua: 'Харківська', center: [49.99, 36.25], bounds: [34.8, 49.0, 38.0, 51.5] },
  'kherson': { name_ua: 'Херсонська', center: [46.63, 32.62], bounds: [31.5, 45.5, 35.0, 47.5] },
  'khmelnytskyi': { name_ua: 'Хмельницька', center: [49.42, 26.98], bounds: [25.5, 48.5, 28.3, 50.2] },
  'cherkasy': { name_ua: 'Черкаська', center: [49.45, 31.99], bounds: [29.8, 48.5, 32.5, 50.3] },
  'chernivtsi': { name_ua: 'Чернівецька', center: [48.29, 25.93], bounds: [24.5, 47.8, 26.5, 48.8] },
  'chernihiv': { name_ua: 'Чернігівська', center: [51.50, 31.29], bounds: [30.5, 50.5, 34.5, 52.5] },
};

// Check which oblast a lat/lon point belongs to (simple bounding box check)
function getOblastId(lat: number, lon: number): string | null {
  for (const [id, oblast] of Object.entries(OBLASTS)) {
    const [minLon, minLat, maxLon, maxLat] = oblast.bounds;
    if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) {
      return id;
    }
  }
  return null;
}

function headingToVector(azimuth_deg: number, speed_kmh: number): { vx_ms: number; vy_ms: number } {
  const speed_ms = speed_kmh / 3.6;
  const rad = azimuth_deg * Math.PI / 180;
  return {
    vx_ms: Math.sin(rad) * speed_ms,
    vy_ms: Math.cos(rad) * speed_ms,
  };
}

// Generate initial targets
function createInitialTargets(): Target[] {
  const now = Date.now();
  
  const specs: Array<{ callsign: string; type: TargetType; lat: number; lon: number; azimuth_deg: number; speed_kmh: number; alt_m: number }> = [
    // UAVs from east heading west
    { callsign: 'TGT-001', type: 'uav', lat: 49.5, lon: 39.8, azimuth_deg: 268, speed_kmh: 180, alt_m: 120 },
    { callsign: 'TGT-002', type: 'uav', lat: 48.2, lon: 38.5, azimuth_deg: 255, speed_kmh: 160, alt_m: 80 },
    { callsign: 'TGT-003', type: 'uav', lat: 50.1, lon: 37.2, azimuth_deg: 280, speed_kmh: 200, alt_m: 150 },
    // Cruise missiles from northeast heading southwest
    { callsign: 'CRS-001', type: 'cruise_missile', lat: 51.5, lon: 35.0, azimuth_deg: 235, speed_kmh: 850, alt_m: 50 },
    { callsign: 'CRS-002', type: 'cruise_missile', lat: 50.8, lon: 38.0, azimuth_deg: 220, speed_kmh: 900, alt_m: 60 },
    // Ballistic from north
    { callsign: 'BAL-001', type: 'ballistic', lat: 52.5, lon: 33.5, azimuth_deg: 195, speed_kmh: 3500, alt_m: 45000 },
    // Aircraft
    { callsign: 'AC-001', type: 'aircraft', lat: 49.0, lon: 38.5, azimuth_deg: 270, speed_kmh: 750, alt_m: 8000 },
    { callsign: 'AC-002', type: 'aircraft', lat: 47.5, lon: 36.0, azimuth_deg: 260, speed_kmh: 700, alt_m: 9500 },
  ];

  return specs.map(s => {
    const { vx_ms, vy_ms } = headingToVector(s.azimuth_deg, s.speed_kmh);
    return {
      id: uuidv4(),
      callsign: s.callsign,
      type: s.type,
      lat: s.lat,
      lon: s.lon,
      alt_m: s.alt_m,
      speed_kmh: s.speed_kmh,
      azimuth_deg: s.azimuth_deg,
      vx_ms,
      vy_ms,
      timestamp_ms: now,
      oblast_id: getOblastId(s.lat, s.lon),
    };
  });
}

const LAT_DEG_PER_METER = 1 / 111319.9;

function lonDegPerMeter(lat: number): number {
  return 1 / (111319.9 * Math.cos(lat * Math.PI / 180));
}

const DT_MS = 2000; // update interval

export class Simulator {
  private targets: Target[];
  private activeAlarms: Map<string, AlarmZone>;
  private intervalHandle: ReturnType<typeof setInterval> | null;
  private onUpdate: (targets: Target[]) => void;
  private onAlarm: (zones: AlarmZone[]) => void;

  constructor(
    onUpdate: (targets: Target[]) => void,
    onAlarm: (zones: AlarmZone[]) => void,
  ) {
    this.targets = createInitialTargets();
    this.activeAlarms = new Map();
    this.intervalHandle = null;
    this.onUpdate = onUpdate;
    this.onAlarm = onAlarm;
  }

  start(): void {
    this.intervalHandle = setInterval(() => this.tick(), DT_MS);
    console.log('[Simulator] Started with', this.targets.length, 'targets');
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  private tick(): void {
    const dt_s = DT_MS / 1000;
    const now = Date.now();
    const alarmsChanged = false;

    this.targets = this.targets.map(t => {
      // Slight random heading jitter (±0.5 deg/tick)
      const newAzimuth = (t.azimuth_deg + (Math.random() - 0.5)) % 360;
      const { vx_ms, vy_ms } = headingToVector(newAzimuth, t.speed_kmh);

      const newLat = t.lat + vy_ms * dt_s * LAT_DEG_PER_METER;
      const newLon = t.lon + vx_ms * dt_s * lonDegPerMeter(t.lat);

      // Respawn if target exits Ukraine bounding box [44.0, 22.0, 52.5, 40.5]
      let finalLat = newLat, finalLon = newLon;
      if (newLat < 44.0 || newLat > 53.0 || newLon < 22.0 || newLon > 41.0) {
        // Respawn from east border
        finalLat = 47.0 + Math.random() * 5.0;
        finalLon = 39.5 + Math.random() * 1.0;
      }

      const newOblastId = getOblastId(finalLat, finalLon);

      // Trigger alarm if entered a new oblast
      if (newOblastId && newOblastId !== t.oblast_id) {
        this.triggerAlarm(newOblastId, t.type);
      }

      return { ...t, lat: finalLat, lon: finalLon, azimuth_deg: newAzimuth, vx_ms, vy_ms, timestamp_ms: now, oblast_id: newOblastId };
    });

    this.onUpdate(this.targets);
  }

  private triggerAlarm(oblastId: string, targetType: TargetType): void {
    const alarmType: AlarmType = 'air_raid';
    const oblast = OBLASTS[oblastId];
    if (!oblast) return;

    const zone: AlarmZone = {
      oblast_id: oblastId,
      name_ua: oblast.name_ua,
      alarm_type: alarmType,
      started_at: Date.now(),
    };

    this.activeAlarms.set(oblastId, zone);
    this.onAlarm(Array.from(this.activeAlarms.values()));

    // Auto-clear alarm after 120 seconds
    setTimeout(() => {
      this.activeAlarms.delete(oblastId);
      this.onAlarm(Array.from(this.activeAlarms.values()));
    }, 120000);
  }

  getTargets(): Target[] { return this.targets; }
  getAlarms(): AlarmZone[] { return Array.from(this.activeAlarms.values()); }
  getOblasts() { return OBLASTS; }
}
