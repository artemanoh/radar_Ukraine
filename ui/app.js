const config = {
  mapOpacity: 1,
  grid: false,
  gridIntensity: 0.4,
  weather: false,
  rainEffect: false,
  heatmap: false,
  placeNames: true,
  fontSize: 'medium',
  iconStyle: 'minimal',
  uavScale: 1,
  missileScale: 1,
  glow: 0.6,
  tailLength: 40,
  lerpFactor: 0.08,
  labels: true,
  cone: true,
  zoneRadius: 80,
  zoneColor: '#7c3aed',
  zoneOpacity: 0.15,
  zonePulse: true,
  alertDistance: 50,
  ppoZones: false,
  masterVol: 0.7,
  uiVol: 0.5,
  sirenType: 'classic',
  spatialAudio: false,
  ambient: false,
  ambientVol: 0.3,
  panelBlur: 20,
};

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.sirenNodes = null;
    this.ambientNodes = null;
    this.isSirenActive = false;
    this.isAmbientActive = false;
  }
  
  ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = config.masterVol;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }
  
  playClick() {
    this.ensureContext();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(800, this.ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(config.uiVol, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.05);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.05);
  }
  
  startSiren() {
    this.ensureContext();
    this.stopSiren();
    
    this.isSirenActive = true;
    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.5, this.ctx.currentTime + 0.1);
    
    let panner = null;
    if (config.spatialAudio && this.ctx.createStereoPanner) {
      panner = this.ctx.createStereoPanner();
      gainNode.connect(panner);
      panner.connect(this.masterGain);
    } else {
      gainNode.connect(this.masterGain);
    }

    const nodes = [];
    
    if (config.sirenType === 'classic') {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.5;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 200;
      
      osc.frequency.value = 440;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      
      osc.connect(gainNode);
      osc.start();
      lfo.start();
      nodes.push(osc, lfo, lfoGain);
    } else if (config.sirenType === 'pulse') {
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 880;
      
      const pulseGain = this.ctx.createGain();
      pulseGain.gain.value = 1;
      
      const lfo = this.ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 4;
      
      lfo.connect(pulseGain.gain);
      osc.connect(pulseGain);
      pulseGain.connect(gainNode);
      
      osc.start();
      lfo.start();
      nodes.push(osc, lfo, pulseGain);
    } else {
      // lofi
      const osc1 = this.ctx.createOscillator();
      osc1.type = 'triangle';
      osc1.frequency.value = 330;
      const osc2 = this.ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.value = 660;
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1500;
      
      osc1.connect(filter);
      osc2.connect(filter);
      filter.connect(gainNode);
      
      osc1.start();
      osc2.start();
      nodes.push(osc1, osc2, filter);
    }
    
    this.sirenNodes = { gain: gainNode, nodes, panner };
  }
  
  stopSiren() {
    if (!this.isSirenActive || !this.sirenNodes) return;
    const { gain, nodes } = this.sirenNodes;
    gain.gain.linearRampToValueAtTime(0.001, this.ctx.currentTime + 0.3);
    setTimeout(() => {
      nodes.forEach(n => { if(n.stop) n.stop(); n.disconnect(); });
      gain.disconnect();
    }, 350);
    this.isSirenActive = false;
    this.sirenNodes = null;
  }
  
  startAmbient() {
    this.ensureContext();
    this.stopAmbient();
    this.isAmbientActive = true;
    
    const bufferSize = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.15;
    
    noise.connect(filter);
    filter.connect(noiseGain);
    
    const hum = this.ctx.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = 60;
    
    const hum2 = this.ctx.createOscillator();
    hum2.type = 'sine';
    hum2.frequency.value = 120;
    
    const humGain = this.ctx.createGain();
    humGain.gain.value = 0.05;
    
    hum.connect(humGain);
    hum2.connect(humGain);
    
    const masterAmbientGain = this.ctx.createGain();
    masterAmbientGain.gain.value = config.ambientVol * config.masterVol;
    
    noiseGain.connect(masterAmbientGain);
    humGain.connect(masterAmbientGain);
    masterAmbientGain.connect(this.masterGain);
    
    noise.start();
    hum.start();
    hum2.start();
    
    this.ambientNodes = { gain: masterAmbientGain, nodes: [noise, filter, noiseGain, hum, hum2, humGain] };
  }
  
  stopAmbient() {
    if (!this.isAmbientActive || !this.ambientNodes) return;
    const { gain, nodes } = this.ambientNodes;
    gain.gain.linearRampToValueAtTime(0.001, this.ctx.currentTime + 0.3);
    setTimeout(() => {
      nodes.forEach(n => { if(n.stop) n.stop(); n.disconnect(); });
      gain.disconnect();
    }, 350);
    this.isAmbientActive = false;
    this.ambientNodes = null;
  }
  
  updateMasterVol(v) {
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
    }
  }
  
  panTarget(lon, centerLon) {
    if (config.spatialAudio && this.isSirenActive && this.sirenNodes && this.sirenNodes.panner) {
      const pan = Math.max(-1, Math.min(1, (lon - centerLon) / 2));
      this.sirenNodes.panner.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.1);
    }
  }
}

class Target {
  constructor(data) {
    this.id = data.id;
    this.lat = data.lat;
    this.lon = data.lon;
    this.displayLat = data.lat;
    this.displayLon = data.lon;
    this.vxMs = data.vx_ms;
    this.vyMs = data.vy_ms;
    this.speedMs = data.speed_ms;
    this.headingDeg = data.heading_deg;
    this.altM = data.alt_m;
    this.threatLevel = data.threat_level;
    this.type = Math.random() < 0.7 ? 'uav' : 'missile';
    this.trail = [];
    this.marker = null;
    this.conePolygon = null;
    this.tailPolyline = null;
  }
  
  getSVG() {
    const scale = this.type === 'uav' ? config.uavScale : config.missileScale;
    let svg = '';
    if (this.type === 'uav' && config.iconStyle === 'minimal') {
      svg = `<svg width="${20*scale}" height="${20*scale}" viewBox="-10 -10 20 20" style="filter: drop-shadow(0 0 ${config.glow*10}px rgba(0,212,255,1))">
               <polygon points="0,-9 -6,7 0,3 6,7" fill="rgba(0,212,255,0.7)" stroke="#00d4ff" stroke-width="1.5"/>
             </svg>`;
    } else if (this.type === 'uav' && config.iconStyle === 'detailed') {
      svg = `<svg width="${28*scale}" height="${28*scale}" viewBox="-14 -14 28 28" style="filter: drop-shadow(0 0 ${config.glow*10}px rgba(0,212,255,1))">
               <polygon points="0,-12 -4,-2 -8,8 0,4 8,8 4,-2" fill="rgba(0,212,255,0.5)" stroke="#00d4ff" stroke-width="1.5"/>
               <line x1="-10" y1="0" x2="10" y2="0" stroke="rgba(0,212,255,0.4)" stroke-width="1"/>
               <circle cx="0" cy="0" r="2" fill="#00d4ff"/>
             </svg>`;
    } else {
      svg = `<svg width="${16*scale}" height="${28*scale}" viewBox="-8 -14 16 28" style="filter: drop-shadow(0 0 ${config.glow*10}px rgba(239,68,68,1))">
               <polygon points="0,-14 -4,-4 -4,8 4,8 4,-4" fill="rgba(239,68,68,0.7)" stroke="#ef4444" stroke-width="1.5"/>
               <polygon points="-8,8 -4,2 4,2 8,8" fill="rgba(239,68,68,0.5)"/>
             </svg>`;
    }
    return svg;
  }

  createMarker(map) {
    const html = `<div style="transform: rotate(${this.headingDeg}deg); transform-origin: center center; display: inline-block;">${this.getSVG()}</div>
                  <div class="target-label" id="lbl-${this.id}" style="display: ${config.labels ? 'block' : 'none'}; position: absolute; left: 15px; top: -5px;">${Math.round(this.speedMs*3.6)}km/h<br/>${Math.round(this.altM)}m</div>`;
    const icon = L.divIcon({
      html,
      className: 'target-marker',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    this.marker = L.marker([this.displayLat, this.displayLon], { icon, zIndexOffset: 1000 }).addTo(map);
    
    this.tailPolyline = L.polyline([], {
      color: this.type === 'uav' ? '#00d4ff' : '#ef4444',
      weight: 2,
      opacity: 0.5,
      dashArray: '2, 4'
    }).addTo(map);
  }

  updateIcon() {
    if (this.marker) {
      const el = this.marker.getElement();
      if (el) {
        const iconDiv = el.firstElementChild;
        if (iconDiv) {
          iconDiv.innerHTML = this.getSVG();
        }
      }
    }
  }
  
  updateData(data) {
    this.lat = data.lat;
    this.lon = data.lon;
    this.vxMs = data.vx_ms;
    this.vyMs = data.vy_ms;
    this.speedMs = data.speed_ms;
    this.headingDeg = data.heading_deg;
    this.altM = data.alt_m;
    this.threatLevel = data.threat_level;
  }
  
  computeCone() {
    const steps = 8;
    const dur = 240;
    const pts = [];
    const R = 6378137;
    for(let i=1; i<=steps; i++) {
      const t = (dur / steps) * i;
      const radiusM = 500 + 15 * t;
      const dist = this.speedMs * t;
      
      const ang = this.headingDeg * Math.PI / 180;
      const dLat = (dist * Math.cos(ang)) / R * (180/Math.PI);
      const dLon = (dist * Math.sin(ang)) / (R * Math.cos(this.lat * Math.PI/180)) * (180/Math.PI);
      
      const cLat = this.lat + dLat;
      const cLon = this.lon + dLon;
      
      const rDeg = radiusM / R * (180/Math.PI);
      
      const leftLat = cLat + rDeg * Math.cos(ang - Math.PI/2);
      const leftLon = cLon + rDeg * Math.sin(ang - Math.PI/2) / Math.cos(cLat * Math.PI/180);
      
      const rightLat = cLat + rDeg * Math.cos(ang + Math.PI/2);
      const rightLon = cLon + rDeg * Math.sin(ang + Math.PI/2) / Math.cos(cLat * Math.PI/180);
      
      pts.push({ l: [leftLat, leftLon], r: [rightLat, rightLon] });
    }
    
    const poly = [[this.lat, this.lon]];
    for(let i=0; i<pts.length; i++) poly.push(pts[i].l);
    for(let i=pts.length-1; i>=0; i--) poly.push(pts[i].r);
    
    return poly;
  }

  lerpStep() {
    this.displayLat += (this.lat - this.displayLat) * config.lerpFactor;
    this.displayLon += (this.lon - this.displayLon) * config.lerpFactor;
    
    if (this.marker) {
      this.marker.setLatLng([this.displayLat, this.displayLon]);
      const el = this.marker.getElement();
      if (el) {
        const iconDiv = el.firstElementChild;
        if (iconDiv) {
          iconDiv.style.transform = `rotate(${this.headingDeg}deg)`;
        }
        const lbl = el.querySelector('.target-label');
        if (lbl) {
          lbl.style.display = config.labels ? 'block' : 'none';
          lbl.innerHTML = `${Math.round(this.speedMs*3.6)}km/h<br/>${Math.round(this.altM)}m`;
        }
      }
    }
    
    const last = this.trail.length > 0 ? this.trail[this.trail.length - 1] : null;
    if (!last || Math.abs(last[0]-this.displayLat)>0.0001 || Math.abs(last[1]-this.displayLon)>0.0001) {
      this.trail.push([this.displayLat, this.displayLon]);
      const maxLen = Math.floor(config.tailLength / 2);
      if (this.trail.length > maxLen) this.trail.shift();
      if (this.tailPolyline && config.tailLength > 0) {
        this.tailPolyline.setLatLngs(this.trail);
      } else if (this.tailPolyline) {
        this.tailPolyline.setLatLngs([]);
      }
    }
    
    if (config.cone) {
      const pts = this.computeCone();
      if (!this.conePolygon) {
        this.conePolygon = L.polygon(pts, {
          color: this.type === 'uav' ? '#00d4ff' : '#ef4444',
          fillColor: this.type === 'uav' ? '#00d4ff' : '#ef4444',
          fillOpacity: 0.1,
          weight: 1,
          dashArray: '2, 4'
        }).addTo(map);
      } else {
        this.conePolygon.setLatLngs(pts);
      }
    } else if (this.conePolygon) {
      map.removeLayer(this.conePolygon);
      this.conePolygon = null;
    }
  }
  
  remove(map) {
    if (this.marker) map.removeLayer(this.marker);
    if (this.tailPolyline) map.removeLayer(this.tailPolyline);
    if (this.conePolygon) map.removeLayer(this.conePolygon);
  }
}

const VINNYTSIA = [49.2322, 28.4687];

const map = L.map('map', {
  center: VINNYTSIA,
  zoom: 9,
  zoomControl: true,
  attributionControl: true
});

const tileLayer = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  { attribution: '© CartoDB', subdomains: 'abcd', maxZoom: 19, opacity: 1 }
).addTo(map);

const safetyZone = L.circle(VINNYTSIA, {
  radius: config.zoneRadius * 1000,
  color: config.zoneColor,
  fillColor: config.zoneColor,
  fillOpacity: config.zoneOpacity,
  weight: 2,
  dashArray: '8, 6'
}).addTo(map);

const ppoZones = [
  L.circle([49.4, 28.2], { radius: 25000, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.06, weight: 1, dashArray: '4,4' }),
  L.circle([49.1, 28.7], { radius: 20000, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.06, weight: 1, dashArray: '4,4' }),
  L.circle([49.3, 28.1], { radius: 30000, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.06, weight: 1, dashArray: '4,4' }),
];

const gridCanvas = document.getElementById('grid-canvas');
const gridCtx = gridCanvas.getContext('2d');

function drawGrid() {
  if (!config.grid) {
    gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
    return;
  }
  const size = map.getSize();
  gridCanvas.width = size.x;
  gridCanvas.height = size.y;
  gridCtx.clearRect(0, 0, size.x, size.y);
  
  const bounds = map.getBounds();
  const step = 0.5;
  const startLat = Math.floor(bounds.getSouth() / step) * step;
  const endLat = Math.ceil(bounds.getNorth() / step) * step;
  const startLon = Math.floor(bounds.getWest() / step) * step;
  const endLon = Math.ceil(bounds.getEast() / step) * step;
  
  gridCtx.strokeStyle = `rgba(0, 212, 255, ${config.gridIntensity * 0.3})`;
  gridCtx.lineWidth = 1;
  gridCtx.fillStyle = `rgba(0, 212, 255, ${config.gridIntensity * 0.5})`;
  gridCtx.font = '10px Courier New';
  
  gridCtx.beginPath();
  for (let lat = startLat; lat <= endLat; lat += step) {
    const pt1 = map.latLngToContainerPoint([lat, startLon]);
    const pt2 = map.latLngToContainerPoint([lat, endLon]);
    gridCtx.moveTo(pt1.x, pt1.y);
    gridCtx.lineTo(pt2.x, pt2.y);
    gridCtx.fillText(lat.toFixed(1) + '°N', 10, pt1.y - 2);
  }
  for (let lon = startLon; lon <= endLon; lon += step) {
    const pt1 = map.latLngToContainerPoint([startLat, lon]);
    const pt2 = map.latLngToContainerPoint([endLat, lon]);
    gridCtx.moveTo(pt1.x, pt1.y);
    gridCtx.lineTo(pt2.x, pt2.y);
    gridCtx.fillText(lon.toFixed(1) + '°E', pt1.x + 2, size.y - 10);
  }
  gridCtx.stroke();
}
map.on('move zoom resize', drawGrid);

class RainEffect {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.drops = [];
    this.animId = null;
    this.active = false;
    this.init();
  }
  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.init();
  }
  init() {
    this.drops = [];
    for(let i=0; i<150; i++) {
      this.drops.push({
        x: Math.random() * this.canvas.width,
        y: Math.random() * this.canvas.height,
        speed: 3 + Math.random() * 5,
        length: 10 + Math.random() * 15,
        opacity: 0.3 + Math.random() * 0.5
      });
    }
  }
  start() {
    if (this.active) return;
    this.active = true;
    this.canvas.classList.add('active');
    this.resize();
    this.loop();
  }
  stop() {
    this.active = false;
    this.canvas.classList.remove('active');
    cancelAnimationFrame(this.animId);
  }
  loop() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.lineWidth = 1;
    for(let d of this.drops) {
      this.ctx.strokeStyle = `rgba(180, 220, 255, ${d.opacity})`;
      this.ctx.beginPath();
      this.ctx.moveTo(d.x, d.y);
      this.ctx.lineTo(d.x - d.length*0.3, d.y + d.length);
      this.ctx.stroke();
      
      d.y += d.speed;
      d.x -= d.speed * 0.3;
      if (d.y > this.canvas.height || d.x < 0) {
        d.y = -20;
        d.x = Math.random() * this.canvas.width + 50;
      }
    }
    if (this.active) this.animId = requestAnimationFrame(() => this.loop());
  }
}

const heatmapCanvas = document.getElementById('heatmap-canvas');
const heatmapCtx = heatmapCanvas.getContext('2d');
function drawHeatmap(tList) {
  const size = map.getSize();
  heatmapCanvas.width = size.x;
  heatmapCanvas.height = size.y;
  heatmapCtx.clearRect(0, 0, size.x, size.y);
  
  heatmapCtx.globalCompositeOperation = 'screen';
  for (let t of tList) {
    const pt = map.latLngToContainerPoint([t.displayLat, t.displayLon]);
    const r = 60 * t.threatLevel;
    const grad = heatmapCtx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, r);
    grad.addColorStop(0, `rgba(255,40,40,${(0.6*t.threatLevel/3).toFixed(2)})`);
    grad.addColorStop(1, 'transparent');
    heatmapCtx.fillStyle = grad;
    heatmapCtx.beginPath();
    heatmapCtx.arc(pt.x, pt.y, r, 0, Math.PI*2);
    heatmapCtx.fill();
  }
}

let targets = {};
let frameCount = 0;

function animationLoop() {
  const tList = Object.values(targets);
  tList.forEach(t => t.lerpStep());
  
  if (config.heatmap) drawHeatmap(tList);
  
  checkAlertDistance();
  
  frameCount++;
  if (frameCount % 60 === 0) updateConfigPreview();
  
  requestAnimationFrame(animationLoop);
}

let ws = null;
let wsReconnectTimer = null;
let wsBackoff = 1000;

function connectWS(url) {
  if (ws) { ws.close(); }
  updateConnectionUI('connecting');
  try {
    ws = new WebSocket(url);
    ws.onopen = () => { updateConnectionUI('connected'); wsBackoff = 1000; };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'targets_update') {
        const ids = new Set(msg.targets.map(t => t.id));
        Object.keys(targets).forEach(id => {
          if (!ids.has(id)) { targets[id].remove(map); delete targets[id]; }
        });
        msg.targets.forEach(data => {
          if (targets[data.id]) {
            targets[data.id].updateData(data);
          } else {
            const t = new Target(data);
            t.createMarker(map);
            targets[data.id] = t;
          }
        });
        document.getElementById('target-count').textContent = msg.targets.length;
      }
    };
    ws.onclose = () => {
      updateConnectionUI('disconnected');
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(() => connectWS(url), wsBackoff);
      wsBackoff = Math.min(wsBackoff * 2, 30000);
    };
    ws.onerror = () => ws.close();
  } catch (err) {
    updateConnectionUI('disconnected');
  }
}

function updateConnectionUI(state) {
  const dot = document.getElementById('ws-dot');
  const text = document.getElementById('ws-status');
  dot.className = 'status-dot ' + state;
  text.textContent = { connecting: 'ПІДКЛЮЧЕННЯ...', connected: 'ОН-ЛАЙН', disconnected: 'ВІДКЛЮЧЕНО' }[state];
}

function startSwarm() {
  audio.playClick();
  for (let i = 0; i < 10; i++) {
    const id = 'swarm-' + i;
    const angle = (i / 10) * Math.PI * 2;
    const dist = 0.3 + Math.random() * 0.5;
    const data = {
      id,
      lat: VINNYTSIA[0] + Math.cos(angle) * dist,
      lon: VINNYTSIA[1] + Math.sin(angle) * dist,
      alt_m: 100 + Math.random() * 500,
      vx_ms: -Math.sin(angle) * 60,
      vy_ms: -Math.cos(angle) * 60,
      speed_ms: 60,
      heading_deg: (angle * 180 / Math.PI + 180) % 360,
      threat_level: Math.ceil(Math.random() * 3)
    };
    if (targets[id]) { targets[id].remove(map); }
    const t = new Target(data);
    t.createMarker(map);
    targets[id] = t;
    
    const interval = setInterval(() => {
      if (!targets[id]) { clearInterval(interval); return; }
      targets[id].lat += targets[id].vyMs * 0.0001 / 111319 * 1000;
      targets[id].lon += targets[id].vxMs * 0.0001 / (111319 * Math.cos(targets[id].lat * Math.PI/180)) * 1000;
    }, 200);
    setTimeout(() => {
      clearInterval(interval);
      if (targets[id]) { targets[id].remove(map); delete targets[id]; }
      document.getElementById('target-count').textContent = Object.keys(targets).length;
    }, 30000);
  }
  document.getElementById('target-count').textContent = Object.keys(targets).length;
}

function checkAlertDistance() {
  if (!config.zonePulse) {
    safetyZone.getElement()?.classList.remove('zone-pulse');
    return;
  }
  const center = L.latLng(VINNYTSIA);
  let closestDist = Infinity;
  Object.values(targets).forEach(t => {
    const dist = center.distanceTo(L.latLng(t.displayLat, t.displayLon)) / 1000;
    if (dist < closestDist) closestDist = dist;
  });
  const threshold = config.zoneRadius + config.alertDistance;
  if (closestDist < threshold) {
    safetyZone.getElement()?.classList.add('zone-pulse');
  } else {
    safetyZone.getElement()?.classList.remove('zone-pulse');
  }
}

function bindControls() {
  function bindSlider(id, configKey, transform, onUpdate) {
    const el = document.getElementById(id);
    if(!el) return;
    const valueEl = el.parentElement.querySelector('.ctrl-value');
    function update() {
      const raw = parseFloat(el.value);
      const val = transform ? transform(raw) : raw;
      config[configKey] = val;
      if (valueEl) valueEl.textContent = el.dataset.unit ? raw + el.dataset.unit : raw;
      updateSliderBackground(el);
      audio.playClick();
      if (onUpdate) onUpdate(val);
    }
    el.addEventListener('input', update);
    updateSliderBackground(el);
  }
  
  function updateSliderBackground(el) {
    const min = parseFloat(el.min), max = parseFloat(el.max), val = parseFloat(el.value);
    const pct = ((val - min) / (max - min)) * 100;
    el.style.setProperty('--val', pct + '%');
  }
  
  function bindToggle(id, configKey, onUpdate) {
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener('change', () => {
      config[configKey] = el.checked;
      audio.playClick();
      if (onUpdate) onUpdate(el.checked);
    });
  }
  
  bindSlider('ctrl-map-opacity', 'mapOpacity', null, v => tileLayer.setOpacity(v));
  bindToggle('ctrl-grid', 'grid', v => {
    document.getElementById('grid-canvas').style.display = v ? 'block' : 'none';
    if (v) drawGrid();
  });
  bindSlider('ctrl-grid-intensity', 'gridIntensity', null, () => { if (config.grid) drawGrid(); });
  bindToggle('ctrl-weather', 'weather', v => {}); 
  bindToggle('ctrl-rain-effect', 'rainEffect', v => v ? rain.start() : rain.stop());
  bindToggle('ctrl-heatmap', 'heatmap', v => {
    document.getElementById('heatmap-canvas').classList.toggle('active', v);
    if(!v) {
      heatmapCtx.clearRect(0,0,heatmapCanvas.width,heatmapCanvas.height);
    }
  });
  bindToggle('ctrl-place-names', 'placeNames', v => {
    tileLayer.setUrl(v 
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png'
    );
  });
  document.getElementById('ctrl-font-size').addEventListener('change', e => {
    config.fontSize = e.target.value;
    audio.playClick();
    const sizes = { small: '10px', medium: '12px', large: '14px' };
    document.querySelector('.leaflet-container').style.fontSize = sizes[e.target.value];
  });
  
  document.querySelectorAll('input[name="icon-style"]').forEach(el => {
    el.addEventListener('change', () => {
      config.iconStyle = el.value;
      audio.playClick();
      Object.values(targets).forEach(t => t.updateIcon());
    });
  });
  bindSlider('ctrl-uav-scale', 'uavScale', null, () => {
    Object.values(targets).filter(t => t.type === 'uav').forEach(t => t.updateIcon());
  });
  bindSlider('ctrl-missile-scale', 'missileScale', null, () => {
    Object.values(targets).filter(t => t.type === 'missile').forEach(t => t.updateIcon());
  });
  bindSlider('ctrl-glow', 'glow', null, () => {
    Object.values(targets).forEach(t => t.updateIcon());
  });
  bindSlider('ctrl-tail-length', 'tailLength', null);
  bindSlider('ctrl-lerp', 'lerpFactor', null);
  bindToggle('ctrl-labels', 'labels', v => {
    Object.values(targets).forEach(t => {
      if(t.marker) {
        const lbl = t.marker.getElement()?.querySelector('.target-label');
        if(lbl) lbl.style.display = v ? 'block' : 'none';
      }
    });
  });
  bindToggle('ctrl-cone', 'cone', v => {
    Object.values(targets).forEach(t => {
      if (!v && t.conePolygon) { map.removeLayer(t.conePolygon); t.conePolygon = null; }
    });
  });
  
  bindSlider('ctrl-zone-radius', 'zoneRadius', null, v => safetyZone.setRadius(v * 1000));
  document.querySelectorAll('.color-swatch').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
      config.zoneColor = el.dataset.color;
      safetyZone.setStyle({ color: config.zoneColor, fillColor: config.zoneColor });
      audio.playClick();
    });
  });
  bindSlider('ctrl-zone-opacity', 'zoneOpacity', null, v => safetyZone.setStyle({ fillOpacity: v }));
  bindToggle('ctrl-zone-pulse', 'zonePulse');
  bindSlider('ctrl-alert-distance', 'alertDistance', null);
  bindToggle('ctrl-ppo-zones', 'ppoZones', v => {
    ppoZones.forEach(z => v ? z.addTo(map) : map.removeLayer(z));
  });
  
  bindSlider('ctrl-master-vol', 'masterVol', null, v => audio.updateMasterVol(v));
  bindSlider('ctrl-ui-vol', 'uiVol', null);
  document.getElementById('ctrl-siren-type').addEventListener('change', e => {
    config.sirenType = e.target.value;
    audio.playClick();
    if (audio.isSirenActive) { audio.stopSiren(); audio.startSiren(); }
  });
  bindToggle('ctrl-spatial-audio', 'spatialAudio');
  bindToggle('ctrl-ambient', 'ambient', v => v ? audio.startAmbient() : audio.stopAmbient());
  bindSlider('ctrl-ambient-vol', 'ambientVol', null, v => {
    if (audio.ambientNodes) audio.ambientNodes.gain.gain.setTargetAtTime(v * config.masterVol, audio.ctx.currentTime, 0.1);
  });
  
  document.getElementById('btn-swarm').addEventListener('click', startSwarm);
  bindSlider('ctrl-panel-blur', 'panelBlur', null, v => {
    document.getElementById('sidebar').style.backdropFilter = `blur(${v}px)`;
    document.getElementById('app-header').style.backdropFilter = `blur(${v}px)`;
  });
  document.getElementById('btn-reset').addEventListener('click', () => {
    if (confirm('Скинути всі налаштування до значень за замовчуванням?')) {
      location.reload();
    }
  });
  
  document.getElementById('btn-connect').addEventListener('click', () => {
    const url = document.getElementById('ws-url').value;
    connectWS(url);
    audio.playClick();
  });
  
  document.getElementById('btn-alert').addEventListener('click', () => {
    audio.ensureContext();
    const btn = document.getElementById('btn-alert');
    if (audio.isSirenActive) {
      audio.stopSiren();
      btn.classList.remove('active');
      btn.textContent = '🔔 ТРИВОГА';
    } else {
      audio.startSiren();
      btn.classList.add('active');
      btn.textContent = '🔕 ВІДБІЙ';
    }
  });
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      audio.playClick();
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
}

function startClock() {
  const el = document.getElementById('system-time');
  setInterval(() => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('uk-UA', { hour12: false }) + ' UTC+3';
  }, 1000);
}

document.getElementById('sidebar-toggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
  document.getElementById('sidebar-toggle').classList.toggle('collapsed');
  audio.playClick();
  setTimeout(() => map.invalidateSize(), 300);
});

function updateConfigPreview() {
  document.getElementById('config-preview').textContent = JSON.stringify(config, null, 2);
}

const audio = new AudioEngine();
const rain = new RainEffect(document.getElementById('rain-canvas'));

window.addEventListener('resize', () => rain.resize());

initTabs();
bindControls();
startClock();
connectWS('ws://localhost:8080/ws');
updateConfigPreview();

document.querySelectorAll('input[type="range"]').forEach(el => {
  const min = parseFloat(el.min), max = parseFloat(el.max), val = parseFloat(el.value);
  el.style.setProperty('--val', ((val-min)/(max-min)*100) + '%');
});

document.querySelector('.color-swatch').classList.add('active');

requestAnimationFrame(animationLoop);

console.log('%c🛡 AirRadar Zero-Latency UI Initialized', 'color: #00d4ff; font-size: 14px; font-weight: bold;');
