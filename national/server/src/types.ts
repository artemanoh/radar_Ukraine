export type TargetType = 'uav' | 'cruise_missile' | 'ballistic' | 'aircraft';
export type AlarmType = 'air_raid' | 'artillery' | 'clear';

export interface Target {
  id: string;
  callsign: string;
  type: TargetType;
  lat: number;
  lon: number;
  alt_m: number;
  speed_kmh: number;
  azimuth_deg: number; // 0=North, 90=East, 180=South, 270=West
  vx_ms: number; // east velocity m/s
  vy_ms: number; // north velocity m/s
  timestamp_ms: number;
  oblast_id: string | null; // current oblast being entered
}

export interface AlarmZone {
  oblast_id: string;
  name_ua: string;
  alarm_type: AlarmType;
  started_at: number; // unix ms
}

export interface RadarUpdateMessage {
  type: 'RADAR_UPDATE';
  targets: Target[];
  seq: number;
  server_time_ms: number;
}

export interface AlarmUpdateMessage {
  type: 'ALARM_UPDATE';
  zones: AlarmZone[];
  server_time_ms: number;
}

export interface ClientSubscription {
  oblast_ids: string[];
}

export type ServerMessage = RadarUpdateMessage | AlarmUpdateMessage;
