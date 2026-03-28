#!/bin/bash

CUDA_VISIBLE_DEVICES=3,4,5,6 \
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
vllm serve weights/Qwen3.5-122B-A10B-FP8 \
  --port 19000 \
  --tensor-parallel-size 4 \
  --max-model-len 65536 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --gpu-memory-utilization 0.8 \
  --disable-custom-all-reduce \
  --trust-remote-code