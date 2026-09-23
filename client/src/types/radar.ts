export interface GeoPoint { lat: number; lon: number; }
export interface Velocity { vx_ms: number; vy_ms: number; }
export interface TargetState {
  id: string; lat: number; lon: number; alt_m: number;
  vx_ms: number; vy_ms: number; speed_ms: number;
  heading_deg: number; timestamp_ms: number; threat_level: 1 | 2 | 3;
}
export interface ThreatZone {
  target_id: string; cone_polygon: GeoPoint[];
  eta_seconds: number; certainty_probability: number;
}
export interface BroadcastMessage {
  type: 'targets_update'; targets: TargetState[]; seq_num: number;
}
// Worker message types
export type WorkerInMessage =
  | { type: 'INIT_WASM'; wasmUrl: string }
  | { type: 'COMPUTE_CONES'; targets: TargetState[]; forecastSeconds: number };
export type WorkerOutMessage =
  | { type: 'WASM_READY' }
  | { type: 'WASM_ERROR'; error: string }
  | { type: 'CONES_RESULT'; zones: ThreatZone[] };
