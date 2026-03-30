#!/usr/bin/env bash
# LoCoMo Benchmark for Replica
# Usage: bash benchmarks/locomo/run_benchmark.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

# Activate venv
source .venv/bin/activate

REPLICA_URL="${REPLICA_URL:-http://localhost:8790/v1}"
DATA_FILE="benchmarks/locomo/data/locomo10.json"
USER_MAPPING="benchmarks/locomo/data/user_mapping.json"
OUTPUT_DIR="benchmarks/locomo/data"

echo "============================================"
echo "  LoCoMo Benchmark for Replica"
echo "============================================"
echo "Replica URL: ${REPLICA_URL}"
echo ""

# Step 1: Ingest data
if [ ! -f "$USER_MAPPING" ]; then
    echo "[Step 1/2] Ingesting LoCoMo conversations into Replica..."
    python benchmarks/locomo/ingest.py \
        --data-file "$DATA_FILE" \
        --base-url "$REPLICA_URL" \
        --output "$USER_MAPPING"
    echo ""
else
    echo "[Step 1/2] User mapping already exists, skipping ingest."
    echo "  Delete $USER_MAPPING to re-ingest."
    echo ""
fi

# Step 2: Evaluate with different top_k values
echo "[Step 2/2] Running QA evaluation..."
for TOP_K in 5 10 25; do
    echo ""
    echo "--- top_k=${TOP_K} ---"
    python benchmarks/locomo/evaluate.py \
        --data-file "$DATA_FILE" \
        --user-mapping "$USER_MAPPING" \
        --base-url "$REPLICA_URL" \
        --top-k "$TOP_K" \
        --output "${OUTPUT_DIR}/results_top${TOP_K}.json"
done

# Evaluate per entry_type with top_k=10
for ENTRY_TYPE in episode event foresight; do
    echo ""
    echo "--- entry_type=${ENTRY_TYPE}, top_k=10 ---"
    python benchmarks/locomo/evaluate.py \
        --data-file "$DATA_FILE" \
        --user-mapping "$USER_MAPPING" \
        --base-url "$REPLICA_URL" \
        --top-k 10 \
        --entry-type "$ENTRY_TYPE" \
        --output "${OUTPUT_DIR}/results_${ENTRY_TYPE}_top10.json"
done

echo ""
echo "============================================"
echo "  Benchmark Complete!"
echo "  Results saved to: ${OUTPUT_DIR}/results_*.json"
echo "============================================"
