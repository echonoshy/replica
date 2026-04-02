#!/usr/bin/env bash
# LoCoMo Benchmark for Replica (multi-version support)
#
# Usage:
#   bash benchmarks/locomo/run_benchmark.sh --version v2
#   bash benchmarks/locomo/run_benchmark.sh --version v2 --description "改进了 episode 提取逻辑"
#   bash benchmarks/locomo/run_benchmark.sh --version v2 --skip-ingest
#   bash benchmarks/locomo/run_benchmark.sh --version v2 --top-k 50
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

source .venv/bin/activate

# --- Parse arguments ---
VERSION=""
DESCRIPTION=""
SKIP_INGEST=false
TOP_K=50
REPLICA_URL="${REPLICA_URL:-http://localhost:8790/v1}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)    VERSION="$2"; shift 2 ;;
        --description) DESCRIPTION="$2"; shift 2 ;;
        --skip-ingest) SKIP_INGEST=true; shift ;;
        --url)        REPLICA_URL="$2"; shift 2 ;;
        --top-k)      TOP_K="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if [ -z "$VERSION" ]; then
    echo "Error: --version is required"
    echo "Usage: bash benchmarks/locomo/run_benchmark.sh --version v2 [--description \"...\"] [--skip-ingest] [--top-k 50]"
    exit 1
fi

DATA_FILE="benchmarks/locomo/data/locomo10.json"
RESULTS_DIR="benchmarks/locomo/results/${VERSION}"
USER_MAPPING="${RESULTS_DIR}/user_mapping.json"

mkdir -p "$RESULTS_DIR"

echo "============================================"
echo "  LoCoMo Benchmark for Replica"
echo "  Version:     ${VERSION}"
echo "  Description: ${DESCRIPTION:-<none>}"
echo "  Top-K:       ${TOP_K}"
echo "  Results dir: ${RESULTS_DIR}"
echo "  Replica URL: ${REPLICA_URL}"
echo "  Git commit:  $(git rev-parse --short HEAD 2>/dev/null || echo 'N/A')"
echo "============================================"
echo ""

# Save metadata
python -c "
import json, subprocess, sys
from datetime import datetime, timezone
info = {
    'version': '${VERSION}',
    'description': '''${DESCRIPTION}''',
    'timestamp': datetime.now(tz=timezone.utc).isoformat(),
    'replica_url': '${REPLICA_URL}',
}
try:
    info['git_commit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    info['git_commit_short'] = subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], text=True).strip()
    info['git_branch'] = subprocess.check_output(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], text=True).strip()
    info['git_message'] = subprocess.check_output(['git', 'log', '-1', '--format=%s'], text=True).strip()
    info['git_dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip())
except Exception:
    pass
with open('${RESULTS_DIR}/metadata.json', 'w') as f:
    json.dump(info, f, indent=2, ensure_ascii=False)
print('Metadata saved to ${RESULTS_DIR}/metadata.json')
"

# Step 1: Ingest data
if [ "$SKIP_INGEST" = true ]; then
    echo "[Step 1/2] Skipping ingest (--skip-ingest)."
    echo ""
elif [ -f "$USER_MAPPING" ]; then
    echo "[Step 1/2] User mapping already exists for ${VERSION}, skipping ingest."
    echo "  Delete ${USER_MAPPING} to re-ingest, or use --skip-ingest."
    echo ""
else
    echo "[Step 1/2] Ingesting LoCoMo conversations into Replica (version=${VERSION})..."
    python benchmarks/locomo/ingest.py \
        --data-file "$DATA_FILE" \
        --base-url "$REPLICA_URL" \
        --version "$VERSION" \
        --output "$USER_MAPPING"
    echo ""
fi

# Step 2: Evaluate with different top_k values
echo "[Step 2/2] Running QA evaluation..."
EVAL_COMMON_ARGS=(
    --data-file "$DATA_FILE"
    --user-mapping "$USER_MAPPING"
    --base-url "$REPLICA_URL"
    --version "$VERSION"
)

if [ -n "$DESCRIPTION" ]; then
    EVAL_COMMON_ARGS+=(--description "$DESCRIPTION")
fi

echo ""
echo "--- top_k=${TOP_K} ---"
python benchmarks/locomo/evaluate.py \
    "${EVAL_COMMON_ARGS[@]}" \
    --top-k "$TOP_K" \
    --output "${RESULTS_DIR}/results_top${TOP_K}.json"

for ENTRY_TYPE in episode event foresight; do
    echo ""
    echo "--- entry_type=${ENTRY_TYPE}, top_k=${TOP_K} ---"
    python benchmarks/locomo/evaluate.py \
        "${EVAL_COMMON_ARGS[@]}" \
        --top-k "$TOP_K" \
        --entry-type "$ENTRY_TYPE" \
        --output "${RESULTS_DIR}/results_${ENTRY_TYPE}_top${TOP_K}.json"
done

echo ""
echo "============================================"
echo "  Benchmark Complete!  [${VERSION}]"
echo "  Results saved to: ${RESULTS_DIR}/"
echo "============================================"
