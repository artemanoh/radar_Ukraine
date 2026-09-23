/// <reference lib="webworker" />
import { GeoPoint, TargetState, ThreatZone, WorkerInMessage, WorkerOutMessage } from '../types/radar';

const ctx: Worker = self as any;

/**
 * Calculates distance between two geo points.
 */
function haversineDistance(a: GeoPoint, b: GeoPoint): number {
  const R = 6371e3; // metres
  const phi1 = a.lat * Math.PI/180;
  const phi2 = b.lat * Math.PI/180;
  const deltaPhi = (b.lat-a.lat) * Math.PI/180;
  const deltaLambda = (b.lon-a.lon) * Math.PI/180;

  const a_val = Math.sin(deltaPhi/2) * Math.sin(deltaPhi/2) +
          Math.cos(phi1) * Math.cos(phi2) *
          Math.sin(deltaLambda/2) * Math.sin(deltaLambda/2);
  const c = 2 * Math.atan2(Math.sqrt(a_val), Math.sqrt(1-a_val));

  return R * c;
}

/**
 * Projects origin by velocity vector and time.
 */
function projectPosition(origin: GeoPoint, vx: number, vy: number, dt: number): GeoPoint {
  const dx = vx * dt;
  const dy = vy * dt;
  
  const lat_deg = dy / 111319.9;
  const lon_deg = dx / (111319.9 * Math.cos(origin.lat * Math.PI / 180));
  
  return {
    lat: origin.lat + lat_deg,
    lon: origin.lon + lon_deg
  };
}

/**
 * Computes threat cone for a target.
 */
function computeCone(lat: number, lon: number, vx: number, vy: number, forecastSeconds: number, steps: number): GeoPoint[] {
  const dt = forecastSeconds / steps;
  const origin: GeoPoint = { lat, lon };
  const heading = Math.atan2(vx, vy); // radians
  
  const leftSide: GeoPoint[] = [];
  const rightSide: GeoPoint[] = [];
  
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    const center = projectPosition(origin, vx, vy, t);
    const radius = 500 + 15 * t;
    
    const dxLeft = Math.cos(heading + Math.PI / 2) * radius;
    const dyLeft = Math.sin(heading + Math.PI / 2) * radius;
    
    const dxRight = Math.cos(heading - Math.PI / 2) * radius;
    const dyRight = Math.sin(heading - Math.PI / 2) * radius;
    
    const latLeftOffset = dyLeft / 111319.9;
    const lonLeftOffset = dxLeft / (111319.9 * Math.cos(center.lat * Math.PI / 180));
    
    const latRightOffset = dyRight / 111319.9;
    const lonRightOffset = dxRight / (111319.9 * Math.cos(center.lat * Math.PI / 180));
    
    leftSide.push({ lat: center.lat + latLeftOffset, lon: center.lon + lonLeftOffset });
    rightSide.unshift({ lat: center.lat + latRightOffset, lon: center.lon + lonRightOffset });
  }
  
  const polygon = [...leftSide, ...rightSide];
  polygon.push(polygon[0]);
  return polygon;
}

ctx.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'INIT_WASM':
      ctx.postMessage({ type: 'WASM_READY' } as WorkerOutMessage);
      break;
    case 'COMPUTE_CONES':
      const zones: ThreatZone[] = msg.targets.map(t => {
        const polygon = computeCone(t.lat, t.lon, t.vx_ms, t.vy_ms, msg.forecastSeconds, 10);
        return {
          target_id: t.id,
          cone_polygon: polygon,
          eta_seconds: msg.forecastSeconds,
          certainty_probability: 0.85
        };
      });
      ctx.postMessage({ type: 'CONES_RESULT', zones } as WorkerOutMessage);
      break;
  }
};
