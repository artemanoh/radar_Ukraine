const UKRAINE_CENTER = [49.0139, 31.2858];
const DEFAULT_ZOOM = 6;

// Oblast bounding boxes (used to draw rectangles as fallback GeoJSON)
const OBLAST_BOUNDS = {
  vinnytsia: { name: 'Вінницька', bounds: [[48.2, 27.0], [50.2, 29.8]], center: [49.23, 28.47] },
  volyn: { name: 'Волинська', bounds: [[50.0, 23.5], [52.0, 27.0]], center: [50.76, 25.32] },
  dnipropetrovsk: { name: 'Дніпропетровська', bounds: [[47.3, 33.0], [49.3, 36.8]], center: [48.45, 35.09] },
  donetsk: { name: 'Донецька', bounds: [[47.0, 36.0], [49.5, 39.5]], center: [48.02, 37.80] },
  zhytomyr: { name: 'Житомирська', bounds: [[49.5, 26.5], [51.5, 30.5]], center: [50.27, 28.67] },
  zakarpattia: { name: 'Закарпатська', bounds: [[47.8, 22.0], [49.2, 24.8]], center: [48.40, 23.30] },
  zaporizhzhia: { name: 'Запорізька', bounds: [[46.5, 33.5], [48.5, 36.7]], center: [47.84, 35.17] },
  ivano_frankivsk: { name: 'Івано-Франківська', bounds: [[47.8, 23.3], [49.5, 25.5]], center: [48.92, 24.71] },
  kyiv_oblast: { name: 'Київська', bounds: [[49.2, 28.8], [51.8, 32.5]], center: [50.05, 30.10] },
  kirovohrad: { name: 'Кіровоградська', bounds: [[47.8, 30.2], [49.7, 33.7]], center: [48.51, 32.27] },
  luhansk: { name: 'Луганська', bounds: [[47.8, 37.5], [50.2, 40.2]], center: [48.57, 39.31] },
  lviv: { name: 'Львівська', bounds: [[49.0, 22.5], [50.9, 25.0]], center: [49.84, 24.03] },
  mykolaiv: { name: 'Миколаївська', bounds: [[46.0, 30.0], [48.0, 32.8]], center: [46.97, 31.99] },
  odessa: { name: 'Одеська', bounds: [[45.2, 28.2], [47.8, 32.0]], center: [46.49, 30.73] },
  poltava: { name: 'Полтавська', bounds: [[48.7, 32.5], [50.7, 35.8]], center: [49.59, 34.56] },
  rivne: { name: 'Рівненська', bounds: [[50.0, 25.0], [51.8, 27.5]], center: [50.62, 26.25] },
  sumy: { name: 'Сумська', bounds: [[50.0, 32.8], [52.0, 35.8]], center: [50.92, 34.80] },
  ternopil: { name: 'Тернопільська', bounds: [[49.0, 24.5], [50.3, 26.5]], center: [49.55, 25.59] },
  kharkiv: { name: 'Харківська', bounds: [[49.0, 34.8], [51.5, 38.0]], center: [49.99, 36.25] },
  kherson: { name: 'Херсонська', bounds: [[45.5, 31.5], [47.5, 35.0]], center: [46.63, 32.62] },
  khmelnytskyi: { name: 'Хмельницька', bounds: [[48.5, 25.5], [50.2, 28.3]], center: [49.42, 26.98] },
  cherkasy: { name: 'Черкаська', bounds: [[48.5, 29.8], [50.3, 32.5]], center: [49.45, 31.99] },
  chernivtsi: { name: 'Чернівецька', bounds: [[47.8, 24.5], [48.8, 26.5]], center: [48.29, 25.93] },
  chernihiv: { name: 'Чернігівська', bounds: [[50.5, 30.5], [52.5, 34.5]], center: [51.50, 31.29] },
  kyiv_city: { name: 'м. Київ', bounds: [[50.2, 30.2], [50.6, 30.9]], center: [50.45, 30.52] },
};

const RING_CENTERS = {
  ukraine: [49.0139, 31.2858],
  kyiv: [50.45, 30.52],
  kharkiv: [49.99, 36.25],
  odessa: [46.49, 30.73],
  dnipro: [48.45, 35.09],
  vinnytsia: [49.23, 28.47],
};

// App state
const state = {
  ws: null,
  targets: new Map(),     // id -> target data
  markers: new Map(),     // id -> { marker, displayLat, displayLon, trail }
  alarms: new Map(),      // oblast_id -> alarm
  oblastLayers: new Map(),// oblast_id -> Leaflet rectangle layer
  monitoredOblast: null,  // currently selected oblast_id
  ringLayers: [],
  gridVisible: false,
  filters: { uav: true, cruise_missile: true, ballistic: true, aircraft: true },
  audioEnabled: false,
  audioVolume: 0.7,
  alertTriggerKm: 100,
  frameCount: 0,
  lastSeq: 0,
  wsConnectTime: null,
  selectedTargetId: null,
  audioCtx: null,
};

const map = L.map('map', {
  center: UKRAINE_CENTER,
  zoom: DEFAULT_ZOOM,
  zoomControl: true,
  attributionControl: true,
  preferCanvas: true, // Use Canvas renderer for better performance with many markers
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '© CartoDB, © OSM',
  subdomains: 'abcd',
  maxZoom: 19,
}).addTo(map);

function buildOblastGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: Object.entries(OBLAST_BOUNDS).map(([id, data]) => ({
      type: 'Feature',
      properties: { id, name: data.name },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [data.bounds[0][1], data.bounds[0][0]], // [lon, lat]
          [data.bounds[1][1], data.bounds[0][0]],
          [data.bounds[1][1], data.bounds[1][0]],
          [data.bounds[0][1], data.bounds[1][0]],
          [data.bounds[0][1], data.bounds[0][0]], // close
        ]]
      }
    }))
  };
}

async function tryLoadRealGeoJSON() {
  const urls = [
    'https://raw.githubusercontent.com/brown-birds/geojson-ukraine/main/ukraine.geojson',
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        return data;
      }
    } catch { /* try next */ }
  }
  return null; // fallback to bounding boxes
}

let oblastGeoJSONLayer = null;

async function initOblastLayer() {
  // Try real GeoJSON first, then fall back to bounding boxes
  let geojson = await tryLoadRealGeoJSON();
  if (!geojson) {
    geojson = buildOblastGeoJSON();
    console.log('[Map] Using fallback bounding box GeoJSON for oblasts');
  }

  oblastGeoJSONLayer = L.geoJSON(geojson, {
    style: (feature) => getOblastStyle(feature.properties.id || feature.properties.name),
    onEachFeature: (feature, layer) => {
      const oblastId = feature.properties.id;
      const name = feature.properties.name || feature.properties.NAME_1 || 'Unknown';
      
      layer.on('click', () => selectOblast(oblastId, name, layer));
      layer.bindTooltip(name, { 
        permanent: false, 
        direction: 'center',
        className: 'oblast-tooltip',
        offset: [0, 0],
      });
      
      // Store in our layer map
      if (oblastId) state.oblastLayers.set(oblastId, layer);
    }
  }).addTo(map);
}

function getOblastStyle(oblastId) {
  const alarm = state.alarms.get(oblastId);
  const isMonitored = state.monitoredOblast === oblastId;
  
  if (alarm) {
    if (alarm.alarm_type === 'air_raid') {
      return { color: '#f85149', weight: 2, fillColor: '#f85149', fillOpacity: 0.3 };
    } else {
      return { color: '#d29922', weight: 2, fillColor: '#d29922', fillOpacity: 0.25 };
    }
  }
  if (isMonitored) {
    return { color: '#388bfd', weight: 2, fillColor: '#388bfd', fillOpacity: 0.1 };
  }
  return { color: '#30363d', weight: 1, fillColor: 'transparent', fillOpacity: 0 };
}

function refreshOblastStyles() {
  if (!oblastGeoJSONLayer) return;
  oblastGeoJSONLayer.setStyle((feature) => getOblastStyle(feature.properties.id));
}

function selectOblast(id, name, layer) {
  state.monitoredOblast = id;
  refreshOblastStyles();
  // Update sidebar zone info
  document.getElementById('monitored-zone-info').innerHTML = 
    `<strong>${name}</strong><br><span class="text-dim" style="font-size:0.65rem">Моніторинг активний</span>`;
  document.getElementById('btn-clear-zone').style.display = 'block';
  // Zoom to oblast
  if (layer.getBounds) map.fitBounds(layer.getBounds(), { padding: [30, 30] });
}

const TARGET_COLORS = {
  uav: '#ff6b35',
  cruise_missile: '#f85149',
  ballistic: '#d2a8ff',
  aircraft: '#79c0ff',
};

const TARGET_LABELS = {
  uav: 'БпЛА',
  cruise_missile: 'КР',
  ballistic: 'БАЛ',
  aircraft: 'АВ',
};

function createTargetSVG(type, azimuth, scale = 1) {
  const color = TARGET_COLORS[type] || '#ffffff';
  const size = 24 * scale;
  const half = size / 2;
  
  let shape = '';
  
  if (type === 'uav') {
    // Triangle drone shape
    shape = `<polygon points="0,${-half*0.85} ${-half*0.65},${half*0.65} 0,${half*0.3} ${half*0.65},${half*0.65}" fill="${color}" fill-opacity="0.85" stroke="${color}" stroke-width="1"/>
    <line x1="${-half*0.9}" y1="0" x2="${half*0.9}" y2="0" stroke="${color}" stroke-width="1" stroke-opacity="0.6"/>`;
  } else if (type === 'cruise_missile') {
    // Elongated arrow
    shape = `<polygon points="0,${-half*0.9} ${-half*0.3},${half*0.3} 0,0 ${half*0.3},${half*0.3}" fill="${color}" fill-opacity="0.9" stroke="${color}" stroke-width="1"/>
    <rect x="${-half*0.1}" y="${half*0.3}" width="${half*0.2}" height="${half*0.5}" fill="${color}" fill-opacity="0.7"/>`;
  } else if (type === 'ballistic') {
    // Teardrop/ballistic shape
    shape = `<ellipse cx="0" cy="0" rx="${half*0.35}" ry="${half*0.75}" fill="${color}" fill-opacity="0.8" stroke="${color}" stroke-width="1.5"/>
    <polygon points="0,${-half} ${-half*0.2},${-half*0.5} ${half*0.2},${-half*0.5}" fill="${color}"/>`;
  } else { // aircraft
    // Simplified aircraft silhouette
    shape = `<polygon points="0,${-half*0.8} ${-half*0.2},${half*0.2} 0,0 ${half*0.2},${half*0.2}" fill="${color}" fill-opacity="0.85" stroke="${color}" stroke-width="1"/>
    <line x1="${-half*0.8}" y1="${-half*0.1}" x2="${half*0.8}" y2="${-half*0.1}" stroke="${color}" stroke-width="1.5"/>`;
  }
  
  // Pulsing glow ring for high-threat types
  const ring = (type === 'ballistic' || type === 'cruise_missile') 
    ? `<circle cx="0" cy="0" r="${half*0.9}" fill="none" stroke="${color}" stroke-width="1" stroke-opacity="0.4" stroke-dasharray="3 3"/>` 
    : '';
  
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-half} ${-half} ${size} ${size}">
    <g transform="rotate(${azimuth})">
      ${ring}
      ${shape}
    </g>
  </svg>`;
  
  return svg;
}

function createLeafletIcon(type, azimuth) {
  const svg = createTargetSVG(type, azimuth);
  const size = 24;
  return L.divIcon({
    className: '',
    html: svg,
    iconSize: [size, size],
    iconAnchor: [size/2, size/2],
    popupAnchor: [0, -size/2],
  });
}

const TRACK_HISTORY_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const LERP_FACTOR = 0.06; // per frame at 60fps

function updateTargets(newTargets) {
  const receivedIds = new Set();
  
  newTargets.forEach(t => {
    receivedIds.add(t.id);
    
    if (state.markers.has(t.id)) {
      // Update existing target (lerp will smooth movement)
      const existing = state.markers.get(t.id);
      existing.targetLat = t.lat;
      existing.targetLon = t.lon;
      existing.data = t; // update telemetry data
      
      // Add to track history
      existing.track.push({ lat: t.lat, lon: t.lon, ts: t.timestamp_ms });
      // Prune old track history
      const cutoff = Date.now() - TRACK_HISTORY_DURATION_MS;
      while (existing.track.length > 0 && existing.track[0].ts < cutoff) {
        existing.track.shift();
      }
    } else {
      // Create new target
      if (!state.filters[t.type]) return; // filtered out
      
      const marker = L.marker([t.lat, t.lon], {
        icon: createLeafletIcon(t.type, t.azimuth_deg),
        zIndexOffset: getZIndex(t.type),
      }).addTo(map);
      
      marker.on('click', () => showTelemetry(t.id));
      
      // Track polyline
      const trackLine = L.polyline([], {
        color: TARGET_COLORS[t.type],
        weight: 1,
        opacity: 0.5,
        dashArray: '3 4',
      }).addTo(map);
      
      state.markers.set(t.id, {
        marker,
        trackLine,
        displayLat: t.lat,
        displayLon: t.lon,
        targetLat: t.lat,
        targetLon: t.lon,
        track: [{ lat: t.lat, lon: t.lon, ts: t.timestamp_ms }],
        data: t,
      });
    }
  });
  
  // Remove disappeared targets
  for (const [id, entry] of state.markers) {
    if (!receivedIds.has(id)) {
      map.removeLayer(entry.marker);
      map.removeLayer(entry.trackLine);
      state.markers.delete(id);
    }
  }
  
  // Update counts
  document.getElementById('target-count').textContent = state.markers.size;
}

function getZIndex(type) {
  const priorities = { ballistic: 1000, cruise_missile: 800, uav: 600, aircraft: 400 };
  return priorities[type] || 200;
}

// Main animation loop - runs at 60 FPS
function animationLoop() {
  state.frameCount++;
  
  for (const [id, entry] of state.markers) {
    // Lerp: smoothly interpolate display position toward target position
    const dLat = entry.targetLat - entry.displayLat;
    const dLon = entry.targetLon - entry.displayLon;
    
    if (Math.abs(dLat) > 1e-8 || Math.abs(dLon) > 1e-8) {
      entry.displayLat += dLat * LERP_FACTOR;
      entry.displayLon += dLon * LERP_FACTOR;
      entry.marker.setLatLng([entry.displayLat, entry.displayLon]);
    }
    
    // Update icon rotation
    entry.marker.setIcon(createLeafletIcon(entry.data.type, entry.data.azimuth_deg));
    
    // Update track polyline
    if (state.gridVisible || document.getElementById('layer-tracks').checked) {
      const trackPoints = entry.track.map(p => [p.lat, p.lon]);
      entry.trackLine.setLatLngs(trackPoints);
    } else {
      entry.trackLine.setLatLngs([]);
    }
    
    // Update telemetry panel if this target is selected
    if (state.selectedTargetId === id) {
      updateTelemetryDisplay(entry.data, entry.displayLat, entry.displayLon);
    }
    
    // Check alert distance
    if (state.audioEnabled && state.monitoredOblast) {
      checkAlertDistance(entry);
    }
  }
  
  // Update grid if visible
  if (document.getElementById('layer-grid').checked) {
    drawGrid();
  }
  
  requestAnimationFrame(animationLoop);
}

const TYPE_NAMES = {
  uav: 'Безпілотний літальний апарат',
  cruise_missile: 'Крилата ракета',
  ballistic: 'Балістична ракета',
  aircraft: 'Авіація (літак)',
};

function showTelemetry(id) {
  state.selectedTargetId = id;
  const entry = state.markers.get(id);
  if (!entry) return;
  updateTelemetryDisplay(entry.data, entry.displayLat, entry.displayLon);
  document.getElementById('telemetry-panel').classList.remove('hidden');
}

function updateTelemetryDisplay(data, lat, lon) {
  document.getElementById('telem-callsign').textContent = data.callsign;
  document.getElementById('telem-type').textContent = TARGET_LABELS[data.type];
  document.getElementById('telem-type').style.color = TARGET_COLORS[data.type];
  document.getElementById('telem-type-full').textContent = TYPE_NAMES[data.type] || data.type;
  document.getElementById('telem-speed').textContent = `${Math.round(data.speed_kmh)} КМ/Г`;
  document.getElementById('telem-alt').textContent = `${Math.round(data.alt_m).toLocaleString()} М`;
  document.getElementById('telem-azimuth').textContent = `${Math.round(data.azimuth_deg)}°`;
  document.getElementById('telem-coords').textContent = `${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E`;
  document.getElementById('telem-oblast').textContent = data.oblast_id 
    ? (OBLAST_BOUNDS[data.oblast_id]?.name || data.oblast_id)
    : 'За межами';
}

document.getElementById('telem-close').addEventListener('click', () => {
  state.selectedTargetId = null;
  document.getElementById('telemetry-panel').classList.add('hidden');
});

function updateAlarms(zones) {
  state.alarms.clear();
  zones.forEach(z => state.alarms.set(z.oblast_id, z));
  
  // Update count in header
  document.getElementById('alarm-count').textContent = zones.length;
  document.getElementById('alarm-count').style.color = zones.length > 0 ? 'var(--alert-red)' : 'var(--accent-green)';
  
  // Update alarm list in sidebar
  const list = document.getElementById('alarms-list');
  if (zones.length === 0) {
    list.innerHTML = '<div class="no-data-msg">Тривог немає</div>';
  } else {
    list.innerHTML = zones.map(z => `
      <div class="alarm-item ${z.alarm_type === 'artillery' ? 'artillery' : ''}">
        <div class="alarm-item-name">${z.name_ua}</div>
        <div class="alarm-item-type">${z.alarm_type === 'air_raid' ? '✈ ПОВІТРЯНА ТРИВОГА' : '💥 АРТОБСТРІЛ'}</div>
      </div>
    `).join('');
  }
  
  // Update badge
  document.getElementById('alarm-badge').innerHTML = zones.length > 0 
    ? `<span class="alarm-badge">${zones.length}</span>` 
    : '';
  
  // Update oblast fill colors
  refreshOblastStyles();
  
  // Play audio alert
  if (state.audioEnabled && zones.length > 0) {
    playAlertSound();
  }
}

let wsReconnectTimer = null;
let wsBackoff = 1000;

function connectWS(url) {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }
  clearTimeout(wsReconnectTimer);
  
  setConnStatus('connecting');
  
  const ws = new WebSocket(url);
  state.ws = ws;
  state.wsConnectTime = Date.now();
  
  ws.onopen = () => {
    setConnStatus('connected');
    wsBackoff = 1000;
    console.log('[WS] Connected to', url);
  };
  
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const latency = Date.now() - (msg.server_time_ms || Date.now());
    document.getElementById('latency-display').textContent = Math.max(0, latency);
    
    if (msg.type === 'RADAR_UPDATE') {
      document.getElementById('seq-display').textContent = msg.seq;
      updateTargets(msg.targets);
    } else if (msg.type === 'ALARM_UPDATE') {
      updateAlarms(msg.zones);
    }
  };
  
  ws.onclose = () => {
    setConnStatus('disconnected');
    wsReconnectTimer = setTimeout(() => connectWS(url), wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 30000);
  };
  
  ws.onerror = () => ws.close();
}

function setConnStatus(state_) {
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  dot.className = 'status-dot ' + state_;
  label.textContent = { connecting: 'ПІДКЛЮЧЕННЯ...', connected: 'ОН-ЛАЙН', disconnected: 'ВІДКЛЮЧЕНО' }[state_];
}

const gridCanvas = document.getElementById('grid-canvas');
const gridCtx = gridCanvas.getContext('2d');

function resizeGridCanvas() {
  const wrapper = document.getElementById('map-wrapper');
  gridCanvas.width = wrapper.offsetWidth;
  gridCanvas.height = wrapper.offsetHeight;
}
window.addEventListener('resize', resizeGridCanvas);
resizeGridCanvas();

function drawGrid() {
  gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
  
  const bounds = map.getBounds();
  const step = 1; // 1 degree grid
  
  gridCtx.strokeStyle = 'rgba(48, 54, 61, 0.7)';
  gridCtx.lineWidth = 0.5;
  gridCtx.font = '9px Courier New';
  gridCtx.fillStyle = 'rgba(139, 148, 158, 0.7)';
  
  // Draw latitude lines
  const minLat = Math.floor(bounds.getSouth());
  const maxLat = Math.ceil(bounds.getNorth());
  for (let lat = minLat; lat <= maxLat; lat += step) {
    const pt = map.latLngToContainerPoint([lat, bounds.getWest()]);
    const pt2 = map.latLngToContainerPoint([lat, bounds.getEast()]);
    gridCtx.beginPath();
    gridCtx.moveTo(pt.x, pt.y);
    gridCtx.lineTo(pt2.x, pt2.y);
    gridCtx.stroke();
    gridCtx.fillText(`${lat}°N`, 4, pt.y - 2);
  }
  
  // Draw longitude lines
  const minLon = Math.floor(bounds.getWest());
  const maxLon = Math.ceil(bounds.getEast());
  for (let lon = minLon; lon <= maxLon; lon += step) {
    const pt = map.latLngToContainerPoint([bounds.getNorth(), lon]);
    const pt2 = map.latLngToContainerPoint([bounds.getSouth(), lon]);
    gridCtx.beginPath();
    gridCtx.moveTo(pt.x, pt.y);
    gridCtx.lineTo(pt2.x, pt2.y);
    gridCtx.stroke();
    gridCtx.fillText(`${lon}°E`, pt.x + 2, 12);
  }
}

const ringLayers = {};

function updateRings() {
  const center = RING_CENTERS[document.getElementById('ring-center').value] || UKRAINE_CENTER;
  const configs = [
    { key: 'ring-20', radius: 20000 },
    { key: 'ring-50', radius: 50000 },
    { key: 'ring-100', radius: 100000 },
  ];
  configs.forEach(({ key, radius }) => {
    if (ringLayers[key]) { map.removeLayer(ringLayers[key]); delete ringLayers[key]; }
    if (document.getElementById(key).checked) {
      ringLayers[key] = L.circle(center, {
        radius,
        color: '#388bfd',
        weight: 1,
        fill: false,
        dashArray: '6 4',
        opacity: 0.5,
      }).addTo(map);
      ringLayers[key].bindTooltip(`${radius/1000} км`, { permanent: false, direction: 'top', className: 'ring-tooltip' });
    }
  });
}

function ensureAudioCtx() {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
  return state.audioCtx;
}

function playAlertSound() {
  const ctx = ensureAudioCtx();
  const gain = ctx.createGain();
  gain.gain.value = state.audioVolume;
  gain.connect(ctx.destination);
  
  // Two-tone alert: 880Hz then 660Hz
  [880, 660].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(ctx.currentTime + i * 0.25);
    osc.stop(ctx.currentTime + i * 0.25 + 0.2);
  });
}

function checkAlertDistance(entry) {
  if (!state.monitoredOblast) return;
  const oblast = OBLAST_BOUNDS[state.monitoredOblast];
  if (!oblast) return;
  const center = L.latLng(oblast.center);
  const targetPos = L.latLng(entry.displayLat, entry.displayLon);
  const dist = center.distanceTo(targetPos) / 1000; // km
  if (dist < state.alertTriggerKm) {
    // Could throttle this to not fire every frame
    // Use a simple debounce per target
    if (!entry._lastAlertTs || Date.now() - entry._lastAlertTs > 30000) {
      entry._lastAlertTs = Date.now();
      playAlertSound();
    }
  }
}

function bindControls() {
  // Filters
  ['uav', 'cruise', 'ballistic', 'aircraft'].forEach(type => {
    const realType = type === 'cruise' ? 'cruise_missile' : type;
    document.getElementById(`filter-${type}`).addEventListener('change', e => {
      state.filters[realType] = e.target.checked;
      // Hide/show existing markers
      for (const [id, entry] of state.markers) {
        if (entry.data.type === realType) {
          if (e.target.checked) { entry.marker.addTo(map); entry.trackLine.addTo(map); }
          else { map.removeLayer(entry.marker); map.removeLayer(entry.trackLine); }
        }
      }
    });
  });
  
  // Oblast layer toggle
  document.getElementById('layer-oblasts').addEventListener('change', e => {
    if (oblastGeoJSONLayer) {
      if (e.target.checked) oblastGeoJSONLayer.addTo(map);
      else map.removeLayer(oblastGeoJSONLayer);
    }
  });
  
  // Tracks toggle
  document.getElementById('layer-tracks').addEventListener('change', e => {
    for (const [, entry] of state.markers) {
      if (!e.target.checked) entry.trackLine.setLatLngs([]);
    }
  });
  
  // Grid toggle
  document.getElementById('layer-grid').addEventListener('change', e => {
    if (!e.target.checked) gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
  });
  
  // Range rings
  ['ring-20', 'ring-50', 'ring-100'].forEach(id => {
    document.getElementById(id).addEventListener('change', updateRings);
  });
  document.getElementById('ring-center').addEventListener('change', updateRings);
  
  // Audio
  document.getElementById('audio-enabled').addEventListener('change', e => {
    state.audioEnabled = e.target.checked;
    if (e.target.checked) ensureAudioCtx();
  });
  document.getElementById('audio-volume').addEventListener('input', e => {
    state.audioVolume = parseFloat(e.target.value);
    document.getElementById('audio-vol-display').textContent = Math.round(state.audioVolume * 100) + '%';
  });
  document.getElementById('alert-trigger-km').addEventListener('input', e => {
    state.alertTriggerKm = parseInt(e.target.value);
    document.getElementById('alert-km-display').textContent = state.alertTriggerKm + ' км';
  });
  
  // Clear monitored zone
  document.getElementById('btn-clear-zone').addEventListener('click', () => {
    state.monitoredOblast = null;
    document.getElementById('monitored-zone-info').innerHTML = '<span class="text-dim">Клікніть на область на карті</span>';
    document.getElementById('btn-clear-zone').style.display = 'none';
    refreshOblastStyles();
  });
  
  // Reconnect button
  document.getElementById('btn-reconnect').addEventListener('click', () => {
    const url = document.getElementById('ws-url-input').value.trim();
    wsBackoff = 1000;
    connectWS(url);
  });
  
  // Map movement: redraw grid
  map.on('move zoom', () => {
    if (document.getElementById('layer-grid').checked) drawGrid();
    resizeGridCanvas();
  });
  map.on('resize', resizeGridCanvas);
}

function startClock() {
  setInterval(() => {
    document.getElementById('system-clock').textContent = 
      new Date().toLocaleTimeString('uk-UA', { hour12: false });
  }, 1000);
}

initOblastLayer();
bindControls();
startClock();
connectWS('ws://localhost:8091');
requestAnimationFrame(animationLoop);

console.log('%c[AirRadar NSS] System initialized', 'color: #39d353; font-family: monospace; font-size: 13px;');
