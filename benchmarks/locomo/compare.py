"""Compare benchmark results across multiple versions.

Usage:
    python benchmarks/locomo/compare.py v1 v2 v3
    python benchmarks/locomo/compare.py v1 v2 --pattern top10
    python benchmarks/locomo/compare.py --all
    python benchmarks/locomo/compare.py --all --pattern top10
"""

import argparse
import json
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

RESULTS_DIR = Path("benchmarks/locomo/results")

CATEGORY_ORDER = ["single_hop", "multi_hop", "temporal", "open_domain", "adversarial", "overall"]


def discover_versions() -> list[str]:
    """Find all version directories that contain result files."""
    if not RESULTS_DIR.exists():
        return []
    versions = []
    for d in sorted(RESULTS_DIR.iterdir()):
        if d.is_dir() and any(d.glob("results_*.json")):
            versions.append(d.name)
    return versions


def load_result_files(version: str, pattern: str | None = None) -> dict[str, dict]:
    """Load all result JSON files for a version. Returns {filename_stem: summary_dict}."""
    version_dir = RESULTS_DIR / version
    if not version_dir.exists():
        logger.warning("Version directory not found: %s", version_dir)
        return {}

    results = {}
    for f in sorted(version_dir.glob("results_*.json")):
        if pattern and pattern not in f.stem:
            continue
        with open(f) as fp:
            data = json.load(fp)
        results[f.stem] = data.get("summary", {})
    return results


def load_metadata(version: str) -> dict:
    """Load metadata.json for a version, if available."""
    meta_path = RESULTS_DIR / version / "metadata.json"
    if meta_path.exists():
        with open(meta_path) as f:
            return json.load(f)
    return {}


def format_comparison_table(
    versions: list[str],
    result_key: str,
    summaries: dict[str, dict],
) -> str:
    """Format a comparison table for a single result file across versions."""
    lines = []
    lines.append(f"\n{'=' * 80}")
    lines.append(f"  {result_key}")
    lines.append(f"{'=' * 80}")

    header = f"{'Category':<16}"
    for v in versions:
        header += f"  {v:>12}"
    lines.append(header)
    lines.append("-" * (16 + 14 * len(versions)))

    for cat in CATEGORY_ORDER:
        row = f"{cat:<16}"
        for v in versions:
            summary = summaries.get(v, {})
            cat_data = summary.get(cat, {})
            acc = cat_data.get("accuracy")
            if acc is not None:
                row += f"  {acc:>12.4f}"
            else:
                row += f"  {'—':>12}"
        lines.append(row)

    return "\n".join(lines)


def format_delta_table(
    versions: list[str],
    result_key: str,
    summaries: dict[str, dict],
) -> str:
    """Format a delta table showing improvement over the first version."""
    if len(versions) < 2:
        return ""

    base_version = versions[0]
    lines = []
    lines.append(f"\n  Delta vs {base_version}:")

    header = f"{'Category':<16}"
    for v in versions[1:]:
        header += f"  {v:>12}"
    lines.append(header)
    lines.append("-" * (16 + 14 * (len(versions) - 1)))

    for cat in CATEGORY_ORDER:
        row = f"{cat:<16}"
        base_acc = summaries.get(base_version, {}).get(cat, {}).get("accuracy")
        for v in versions[1:]:
            acc = summaries.get(v, {}).get(cat, {}).get("accuracy")
            if acc is not None and base_acc is not None:
                delta = acc - base_acc
                sign = "+" if delta >= 0 else ""
                row += f"  {sign}{delta:>11.4f}"
            else:
                row += f"  {'—':>12}"
        lines.append(row)

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Compare LoCoMo benchmark results across versions")
    parser.add_argument("versions", nargs="*", help="Version tags to compare (e.g. v1 v2 v3)")
    parser.add_argument("--all", action="store_true", help="Compare all available versions")
    parser.add_argument("--pattern", type=str, default=None, help="Filter result files by name pattern (e.g. top10)")
    args = parser.parse_args()

    if args.all:
        versions = discover_versions()
        if not versions:
            logger.error("No versions found in %s", RESULTS_DIR)
            return
    elif args.versions:
        versions = args.versions
    else:
        parser.print_help()
        return

    logger.info("Comparing versions: %s", ", ".join(versions))

    print("\n" + "=" * 80)
    print("  Version Metadata")
    print("=" * 80)
    for v in versions:
        meta = load_metadata(v)
        desc = meta.get("description", "")
        git_short = meta.get("git_commit_short", meta.get("git", {}).get("commit", "N/A"))
        ts = meta.get("timestamp", "N/A")
        dirty_flag = " [dirty]" if meta.get("git_dirty") else ""
        print(f"  {v:>8}  commit={git_short}{dirty_flag}  time={ts[:19]}  desc={desc or '—'}")

    all_result_keys: set[str] = set()
    version_results: dict[str, dict[str, dict]] = {}
    for v in versions:
        results = load_result_files(v, pattern=args.pattern)
        version_results[v] = results
        all_result_keys.update(results.keys())

    for result_key in sorted(all_result_keys):
        summaries = {v: version_results.get(v, {}).get(result_key, {}) for v in versions}
        print(format_comparison_table(versions, result_key, summaries))
        if len(versions) >= 2:
            print(format_delta_table(versions, result_key, summaries))

    print()


if __name__ == "__main__":
    main()
