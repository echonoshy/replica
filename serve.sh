#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_PATH="${SCRIPT_DIR}/weights/Qwen3-Embedding-4B"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-19001}"

export CUDA_VISIBLE_DEVICES=7

exec uv run vllm serve "${MODEL_PATH}" \
    --host "${HOST}" \
    --port "${PORT}" \
    --tensor-parallel-size 1 \
    --max-model-len 19001 \
    --dtype auto \
    --gpu-memory-utilization 0.4 \
    --trust-remote-code
