# AirRadar Zero-Latency

> High-performance air surveillance PWA — Polyglot microservices: C++17 / Go / TypeScript

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Browser / PWA (client/)                         │
│  ┌─────────────┐  ┌──────────┐  ┌─────────────┐ │
│  │  WebGL Map  │  │  Web     │  │  Service    │ │
│  │  (Deck.gl + │◄─┤  Worker  │  │  Worker     │ │
│  │  MapLibre)  │  │  (WASM)  │  │  (Offline)  │ │
│  └──────┬──────┘  └──────────┘  └─────────────┘ │
└─────────┼───────────────────────────────────────┘
          │ WebSocket (ws://localhost:8080/ws)
┌─────────▼───────────────────────────────────────┐
│  Gateway (gateway/) — Go goroutines              │
│  Hub: 10K+ concurrent WebSocket connections      │
│  Mock generator: 30 UAV targets @ 100ms interval │
└─────────────────────────────────────────────────┘

  math_engine/ (C++17 → WASM)
  Used inside Web Worker for cone interpolation
```

## Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| `math_engine/` | C++17 → Emscripten WASM | Ballistic math, Cone of Uncertainty |
| `gateway/` | Go 1.22 + gorilla/websocket | 10K+ WS connections, mock UAV stream |
| `client/` | Vite + React 18 + TypeScript | PWA, WebGL map, Web Worker, Web Audio |

## Quick Start

### Prerequisites
- Docker ≥ 24 + Docker Compose v2
- (Optional for local dev) Go 1.22+, Node.js 22+, Emscripten SDK

### Run with Docker

```bash
docker compose up --build
```

Open **http://localhost:3000**

### Local Development

**Gateway:**
```bash
cd gateway
go mod download
go run .
# WebSocket: ws://localhost:8080/ws
# Health:    http://localhost:8080/health
# Metrics:   http://localhost:8080/metrics
```

**Client:**
```bash
cd client
npm install
npm run dev
# http://localhost:5173
```

**Math Engine (WASM build):**
```bash
# Requires Emscripten SDK installed and activated
cd math_engine
./build_wasm.sh
# Output: dist/math_engine.js + dist/math_engine.wasm
```

**Math Engine (native tests):**
```bash
cd math_engine
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make
./airradar_tests
```

## Features

- **Zero-latency broadcast** — Go hub with goroutine-per-connection, back-pressure protection
- **Cone of Uncertainty** — C++17 geospatial math compiled to WASM, runs in Web Worker
- **60 FPS WebGL rendering** — Deck.gl ScatterplotLayer + PolygonLayer on MapLibre dark theme
- **PWA / Offline First** — Service Worker caches WASM, scripts, map tiles
- **Audio siren** — Web Audio API oscillators with LFO sweep, vibration API for mobile
- **Dark tactical map** — Centered on Vinnytsia region (49.23°N, 28.46°E)

## API

### WebSocket — `ws://localhost:8080/ws`

Messages are JSON:

```json
{
  "type": "targets_update",
  "seq_num": 42,
  "targets": [
    {
      "id": "TGT-001",
      "lat": 49.23,
      "lon": 28.46,
      "alt_m": 500.0,
      "vx_ms": 45.2,
      "vy_ms": -12.8,
      "speed_ms": 46.9,
      "heading_deg": 105.7,
      "timestamp_ms": 1727018232000,
      "threat_level": 2
    }
  ]
}
```

### REST

| Endpoint | Method | Response |
|----------|--------|----------|
| `/health` | GET | `{"status":"ok","connections":42}` |
| `/metrics` | GET | Prometheus text format |

## Project Structure

```
radar/
├── docker-compose.yml
├── math_engine/
│   ├── CMakeLists.txt
│   ├── build_wasm.sh
│   ├── Dockerfile
│   ├── src/
│   │   ├── trajectory.hpp      # Types + TrajectoryEngine API
│   │   ├── trajectory.cpp      # Haversine, ETA, Cone of Uncertainty
│   │   └── wasm_bindings.cpp   # Emscripten embind exports
│   └── tests/
│       └── test_trajectory.cpp
├── gateway/
│   ├── main.go                 # HTTP server + signal handling
│   ├── hub/
│   │   ├── hub.go              # Broadcast hub
│   │   └── client.go           # Per-connection client
│   ├── mock/
│   │   └── generator.go        # Mock UAV target generator
│   ├── go.mod / go.sum
│   └── Dockerfile
└── client/
    ├── src/
    │   ├── App.tsx
    │   ├── main.tsx
    │   ├── types/radar.ts
    │   ├── workers/wasmWorker.ts
    │   ├── audio/AlertAudio.ts
    │   ├── hooks/useWebSocket.ts
    │   └── components/
    │       ├── RadarMap.tsx
    │       └── StatusBar.tsx
    ├── public/
    │   ├── manifest.json
    │   └── sw.js
    ├── index.html
    ├── vite.config.ts
    ├── tsconfig.json
    ├── package.json
    └── Dockerfile
```

## Environment Variables

### Gateway
| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_PORT` | `8080` | HTTP/WS listen port |
| `NUM_TARGETS` | `30` | Number of mock UAV targets |
| `UPDATE_INTERVAL_MS` | `100` | Target update frequency |
| `LOG_LEVEL` | `info` | Zap log level |

## License

MIT — Educational/Research use. Not for production military deployment.
