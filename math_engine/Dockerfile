# Stage 1: Build WASM using Emscripten
FROM emscripten/emsdk:3.1.50 AS builder
WORKDIR /app
COPY src/ ./src/
COPY build_wasm.sh ./
RUN chmod +x build_wasm.sh && ./build_wasm.sh

# Stage 2: Build and run native tests (optional CI gate)
FROM gcc:13 AS native-test
WORKDIR /app
COPY src/ ./src/
COPY tests/ ./tests/
COPY CMakeLists.txt ./
RUN apt-get update && apt-get install -y cmake
RUN mkdir build && cd build && cmake .. && make && ./airradar_tests

# Stage 3: wasm-export — lightweight image containing only compiled WASM artifacts.
# docker-compose uses `target: wasm-export` to stop here and mount /dist via volume.
FROM busybox:1.36 AS wasm-export
COPY --from=builder /app/dist/ /dist/
