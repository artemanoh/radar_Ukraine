import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Simulator } from './simulator.js';
import type { ServerMessage, Target, AlarmZone } from './types.js';

const PORT = 8091;
const CLIENT_DIR = path.join(process.cwd(), '..', 'client');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// HTTP server: serves frontend static files + /api endpoints
const httpServer = http.createServer((req, res) => {
  // CORS headers for development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // API: server health
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connections: wss.clients.size, targets: sim.getTargets().length }));
    return;
  }

  // API: oblasts metadata (bounding boxes)
  if (pathname === '/api/oblasts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sim.getOblasts()));
    return;
  }

  // Static files
  let filePath = path.join(CLIENT_DIR, pathname === '/' ? '/index.html' : pathname);
  const ext = path.extname(filePath);
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'text/plain' });
    res.end(data);
  });
});

// WebSocket server
const wss = new WebSocketServer({ server: httpServer });

let seqNum = 0;

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

const sim = new Simulator(
  (targets: Target[]) => {
    seqNum++;
    broadcast({
      type: 'RADAR_UPDATE',
      targets,
      seq: seqNum,
      server_time_ms: Date.now(),
    });
  },
  (zones: AlarmZone[]) => {
    broadcast({
      type: 'ALARM_UPDATE',
      zones,
      server_time_ms: Date.now(),
    });
  }
);

wss.on('connection', (ws) => {
  console.log(`[WS] Client connected. Total: ${wss.clients.size}`);

  // Send current state immediately on connection
  const initRadar: ServerMessage = {
    type: 'RADAR_UPDATE',
    targets: sim.getTargets(),
    seq: seqNum,
    server_time_ms: Date.now(),
  };
  ws.send(JSON.stringify(initRadar));

  const initAlarm: ServerMessage = {
    type: 'ALARM_UPDATE',
    zones: sim.getAlarms(),
    server_time_ms: Date.now(),
  };
  ws.send(JSON.stringify(initAlarm));

  ws.on('close', () => {
    console.log(`[WS] Client disconnected. Total: ${wss.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
});

sim.start();

httpServer.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   AirRadar National Server v1.0      ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  HTTP: http://localhost:${PORT}        ║`);
  console.log(`║  WS:   ws://localhost:${PORT}          ║`);
  console.log(`║  API:  http://localhost:${PORT}/api    ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  sim.stop();
  wss.close();
  process.exit(0);
});
