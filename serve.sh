#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_PATH="${SCRIPT_DIR}/weights/Qwen3.5-122B-A10B-FP8"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-19000}"

export CUDA_VISIBLE_DEVICES=3,4,5,6
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

exec uv run vllm serve "${MODEL_PATH}" \
  --host "${HOST}" \
  --port "${PORT}" \
  --served-model-name Qwen3.5-122B-A10B-FP8 \
  --tensor-parallel-size 4 \
  --max-model-len 200000 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --gpu-memory-utilization 0.65 \
  --disable-custom-all-reduce \
  --trust-remote-code
