#!/usr/bin/env bash
set -euo pipefail

echo "Building AirRadar Math Engine WASM module..."

mkdir -p dist

emcc src/trajectory.cpp src/wasm_bindings.cpp \
    -O3 \
    -std=c++17 \
    --bind \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -o dist/math_engine.js

echo "Build successful! Outputs in dist/"
