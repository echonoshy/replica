"""Evaluate Replica memory system on the LoCoMo QA benchmark.

Flow:
  1. Load LoCoMo QA data + user_mapping (from ingest step)
  2. For each QA question, call Replica knowledge/search to retrieve context
  3. Send retrieved context + question to LLM for answer generation
  4. Compute token-level F1 score per LoCoMo category
  5. Output per-question results + aggregated statistics

Usage:
    python benchmarks/locomo/evaluate.py \
        --data-file benchmarks/locomo/data/locomo10.json \
        --user-mapping benchmarks/locomo/results/v2/user_mapping.json \
        --base-url http://localhost:8790/v1 \
        --llm-base-url http://localhost:19000/v1 \
        --llm-model Qwen3.5-122B-A10B-FP8 \
        --version v2 \
        --top-k 10 \
        [--entry-type episode|event|foresight] \
        [--sample-ids conv-26] \
        [--output benchmarks/locomo/results/v2/results.json]
"""

import argparse
import json
import logging
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from tqdm import tqdm

from metrics import aggregate_scores, evaluate_single_qa

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 600.0

QA_PROMPT = """Based on the following memory context, write an answer in the form of a short phrase for the following question. Answer with exact words from the context whenever possible. If the information is not available in the context, say "No information available".

Context:
{context}

Question: {question}
Short answer:"""

QA_PROMPT_CAT5 = """Based on the following memory context, answer the following question. If the question asks about something not covered in the context, say "No information available" or "Not mentioned".

Context:
{context}

Question: {question}
Short answer:"""


def load_data(data_file: Path) -> list[dict]:
    with open(data_file) as f:
        return json.load(f)


def load_user_mapping(mapping_file: Path) -> dict[str, str]:
    """Load sample_id -> user_id mapping from ingest step."""
    with open(mapping_file) as f:
        mappings = json.load(f)
    return {m["sample_id"]: m["user_id"] for m in mappings}


def search_knowledge(
    client: httpx.Client,
    base_url: str,
    user_id: str,
    query: str,
    top_k: int = 10,
    entry_type: str | None = None,
) -> list[dict]:
    """Call Replica knowledge search API."""
    payload: dict = {"user_id": user_id, "query": query, "top_k": top_k}
    if entry_type:
        payload["entry_type"] = entry_type

    resp = client.post(f"{base_url}/knowledge/search", json=payload)
    resp.raise_for_status()
    return resp.json()


def call_llm(
    client: httpx.Client,
    llm_base_url: str,
    llm_model: str,
    llm_api_key: str,
    prompt: str,
    max_tokens: int = 64,
    temperature: float = 0.0,
) -> str:
    """Call LLM via OpenAI-compatible chat completions API (non-streaming)."""
    headers = {"Content-Type": "application/json"}
    if llm_api_key:
        headers["Authorization"] = f"Bearer {llm_api_key}"

    payload = {
        "model": llm_model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }

    if "qwen3" in llm_model.lower():
        payload["chat_template_kwargs"] = {"enable_thinking": False}

    resp = client.post(f"{llm_base_url}/chat/completions", json=payload, headers=headers)
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"].strip()


def evaluate_sample(
    client: httpx.Client,
    llm_client: httpx.Client,
    base_url: str,
    llm_base_url: str,
    llm_model: str,
    llm_api_key: str,
    sample: dict,
    user_id: str,
    top_k: int,
    entry_type: str | None,
    pbar: tqdm | None = None,
) -> list[dict]:
    """Evaluate all QA pairs for a single LoCoMo sample."""
    sample_id = sample["sample_id"]
    qa_list = sample["qa"]
    results = []
    f1_sum = 0.0

    for qa in qa_list:
        question = qa["question"]
        answer = str(qa.get("answer") or qa.get("adversarial_answer", ""))
        category = qa["category"]

        try:
            knowledge = search_knowledge(client, base_url, user_id, question, top_k, entry_type)
        except Exception as e:
            logger.warning("Knowledge search failed for question '%s': %s", question[:50], e)
            knowledge = []

        context_parts = []
        for k in knowledge:
            title = k.get("title", "")
            content = k.get("content", "")
            entry = k.get("entry_type", "")
            score = k.get("score", 0)
            context_parts.append(
                f"[{entry}, score={score:.3f}] {title}: {content}" if title else f"[{entry}] {content}"
            )

        context = "\n".join(context_parts) if context_parts else "No relevant information found."

        if category == 5:
            prompt = QA_PROMPT_CAT5.format(context=context, question=question)
        else:
            prompt = QA_PROMPT.format(context=context, question=question)

        try:
            prediction = call_llm(llm_client, llm_base_url, llm_model, llm_api_key, prompt)
        except Exception as e:
            logger.warning("LLM call failed for question '%s': %s", question[:50], e)
            prediction = ""

        f1 = evaluate_single_qa(prediction, answer, category)
        f1_sum += f1

        result = {
            "sample_id": sample_id,
            "question": question,
            "answer": answer,
            "prediction": prediction,
            "category": category,
            "f1": round(f1, 4),
            "top_k": top_k,
            "entry_type": entry_type,
            "num_retrieved": len(knowledge),
        }
        results.append(result)

        if pbar:
            avg_f1 = f1_sum / len(results)
            pbar.set_postfix_str(f"{sample_id} avg_f1={avg_f1:.3f}")
            pbar.update(1)

    return results


def get_git_info() -> dict[str, str]:
    """Collect current git commit hash and subject."""
    info = {}
    try:
        info["commit"] = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], text=True).strip()
        info["commit_full"] = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        info["commit_message"] = subprocess.check_output(["git", "log", "-1", "--format=%s"], text=True).strip()
        info["branch"] = subprocess.check_output(["git", "rev-parse", "--abbrev-ref", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "status", "--porcelain"], text=True).strip()
        info["dirty"] = bool(dirty)
    except Exception:
        pass
    return info


def main():
    parser = argparse.ArgumentParser(description="Evaluate Replica on LoCoMo QA benchmark")
    parser.add_argument("--data-file", type=str, default="benchmarks/locomo/data/locomo10.json")
    parser.add_argument("--user-mapping", type=str, default=None)
    parser.add_argument("--base-url", type=str, default="http://localhost:8790/v1")
    parser.add_argument("--llm-base-url", type=str, default="http://localhost:19000/v1")
    parser.add_argument("--llm-model", type=str, default="Qwen3.5-122B-A10B-FP8")
    parser.add_argument("--llm-api-key", type=str, default="EMPTY")
    parser.add_argument("--version", type=str, required=True, help="Benchmark version tag (e.g. v2, v3)")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--entry-type", type=str, default=None, choices=["episode", "event", "foresight"])
    parser.add_argument("--sample-ids", nargs="*", help="Only evaluate specific sample IDs")
    parser.add_argument("--output", type=str, default=None)
    parser.add_argument("--description", type=str, default="", help="Description of this benchmark run")
    args = parser.parse_args()

    version_dir = Path(f"benchmarks/locomo/results/{args.version}")
    if args.user_mapping is None:
        args.user_mapping = str(version_dir / "user_mapping.json")
    if args.output is None:
        args.output = str(version_dir / "results.json")

    samples = load_data(Path(args.data_file))
    user_mapping = load_user_mapping(Path(args.user_mapping))
    logger.info("Loaded %d samples, %d user mappings", len(samples), len(user_mapping))

    if args.sample_ids:
        samples = [s for s in samples if s["sample_id"] in args.sample_ids]
        logger.info("Filtered to %d samples", len(samples))

    client = httpx.Client(timeout=DEFAULT_TIMEOUT)
    llm_client = httpx.Client(timeout=DEFAULT_TIMEOUT)

    all_results = []
    t0 = time.time()

    total_qa = sum(len(s["qa"]) for s in samples if user_mapping.get(s["sample_id"]))
    pbar = tqdm(total=total_qa, desc="Evaluating", unit="qa")

    for i, sample in enumerate(samples):
        sample_id = sample["sample_id"]
        user_id = user_mapping.get(sample_id)
        if not user_id:
            logger.warning("No user mapping for sample %s, skipping", sample_id)
            continue

        pbar.set_description(f"[{i + 1}/{len(samples)}] {sample_id}")

        results = evaluate_sample(
            client=client,
            llm_client=llm_client,
            base_url=args.base_url,
            llm_base_url=args.llm_base_url,
            llm_model=args.llm_model,
            llm_api_key=args.llm_api_key,
            sample=sample,
            user_id=user_id,
            top_k=args.top_k,
            entry_type=args.entry_type,
            pbar=pbar,
        )
        all_results.extend(results)

        sample_scores = aggregate_scores(results)
        logger.info(
            "Sample %s: overall=%.4f (%d questions)", sample_id, sample_scores["overall"]["accuracy"], len(results)
        )

    pbar.close()

    total_elapsed = time.time() - t0

    git_info = get_git_info()

    summary = aggregate_scores(all_results)
    summary["config"] = {
        "version": args.version,
        "description": args.description,
        "top_k": args.top_k,
        "entry_type": args.entry_type,
        "llm_model": args.llm_model,
        "total_questions": len(all_results),
        "elapsed_seconds": round(total_elapsed, 1),
        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        "git": git_info,
    }

    logger.info("=" * 60)
    logger.info("LoCoMo QA Evaluation Results  [%s]", args.version)
    logger.info("=" * 60)
    logger.info("Config: top_k=%d, entry_type=%s, model=%s", args.top_k, args.entry_type, args.llm_model)
    if git_info.get("commit"):
        logger.info(
            "Git: %s (%s)%s",
            git_info["commit"],
            git_info.get("branch", ""),
            " [dirty]" if git_info.get("dirty") else "",
        )
    logger.info("-" * 60)
    for cat_name, cat_data in summary.items():
        if cat_name == "config":
            continue
        logger.info("  %-15s  count=%-5d  accuracy=%.4f", cat_name, cat_data["count"], cat_data["accuracy"])
    logger.info("-" * 60)
    logger.info("Total time: %.1fs (%.2fs per question)", total_elapsed, total_elapsed / max(len(all_results), 1))

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    output_data = {
        "summary": summary,
        "results": all_results,
    }
    with open(output_path, "w") as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    logger.info("Results saved to %s", output_path)


if __name__ == "__main__":
    main()
