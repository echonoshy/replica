"""Ingest LoCoMo conversations into Replica via HTTP API.

Usage:
    python benchmarks/locomo/ingest.py \
        --data-file benchmarks/locomo/data/locomo10.json \
        --base-url http://localhost:8790/v1 \
        [--sample-ids conv-26 conv-27]
"""

import argparse
import json
import logging
import time
from pathlib import Path

import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 600.0


def load_locomo_data(data_file: Path) -> list[dict]:
    with open(data_file) as f:
        return json.load(f)


def get_session_numbers(conversation: dict) -> list[int]:
    """Extract sorted session numbers from a conversation dict."""
    nums = set()
    for key in conversation:
        if key.startswith("session_") and "date_time" not in key:
            try:
                nums.add(int(key.split("_")[-1]))
            except ValueError:
                continue
    return sorted(nums)


def ingest_sample(client: httpx.Client, base_url: str, sample: dict) -> dict:
    """Ingest a single LoCoMo sample into Replica. Returns mapping of sample_id -> user_id."""
    sample_id = sample["sample_id"]
    conversation = sample["conversation"]
    speaker_a = conversation.get("speaker_a", "Speaker_A")
    speaker_b = conversation.get("speaker_b", "Speaker_B")

    logger.info("=== Ingesting sample %s (speakers: %s, %s) ===", sample_id, speaker_a, speaker_b)

    # Step 1: Create user
    resp = client.post(f"{base_url}/users", json={"external_id": f"locomo_{sample_id}", "name": sample_id})
    resp.raise_for_status()
    user = resp.json()
    user_id = user["id"]
    logger.info("Created user %s (id=%s)", sample_id, user_id)

    session_nums = get_session_numbers(conversation)
    total_messages = 0

    for sess_num in session_nums:
        session_key = f"session_{sess_num}"
        date_key = f"session_{sess_num}_date_time"
        dialogs = conversation.get(session_key, [])
        date_time = conversation.get(date_key, "")

        if not dialogs:
            continue

        # Step 2: Create session
        resp = client.post(
            f"{base_url}/users/{user_id}/sessions",
            json={"metadata": {"locomo_session": sess_num, "date_time": date_time}},
        )
        resp.raise_for_status()
        session = resp.json()
        session_id = session["id"]

        msg_count = 0
        for dialog in dialogs:
            speaker = dialog.get("speaker", "")
            text = dialog.get("text", "")

            if speaker == speaker_a:
                role = "user"
            else:
                role = "assistant"

            content = f"[{date_time}] {speaker}: {text}"
            if "blip_caption" in dialog:
                content += f" [shared image: {dialog['blip_caption']}]"

            resp = client.post(
                f"{base_url}/sessions/{session_id}/messages",
                json={"role": role, "content": content, "message_type": "message"},
            )
            resp.raise_for_status()
            msg_count += 1

        total_messages += msg_count
        logger.info(
            "  Session %d (%s): %d messages ingested",
            sess_num,
            date_time,
            msg_count,
        )

        # Step 3: Memorize the session
        logger.info("  Memorizing session %d ...", sess_num)
        t0 = time.time()
        resp = client.post(f"{base_url}/sessions/{session_id}/memorize")
        resp.raise_for_status()
        mem_result = resp.json()
        elapsed = time.time() - t0
        logger.info(
            "  Memorize done: %d knowledge entries extracted (%.1fs)",
            mem_result.get("memory_count", 0),
            elapsed,
        )

    logger.info("Sample %s complete: %d sessions, %d total messages", sample_id, len(session_nums), total_messages)
    return {"sample_id": sample_id, "user_id": user_id}


def main():
    parser = argparse.ArgumentParser(description="Ingest LoCoMo data into Replica")
    parser.add_argument("--data-file", type=str, default="benchmarks/locomo/data/locomo10.json")
    parser.add_argument("--base-url", type=str, default="http://localhost:8790/v1")
    parser.add_argument("--sample-ids", nargs="*", help="Only ingest specific sample IDs (e.g. conv-26 conv-27)")
    parser.add_argument("--output", type=str, default="benchmarks/locomo/data/user_mapping.json")
    args = parser.parse_args()

    data_file = Path(args.data_file)
    samples = load_locomo_data(data_file)
    logger.info("Loaded %d samples from %s", len(samples), data_file)

    if args.sample_ids:
        samples = [s for s in samples if s["sample_id"] in args.sample_ids]
        logger.info("Filtered to %d samples: %s", len(samples), args.sample_ids)

    client = httpx.Client(timeout=DEFAULT_TIMEOUT)
    mappings = []

    for sample in samples:
        mapping = ingest_sample(client, args.base_url, sample)
        mappings.append(mapping)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(mappings, f, indent=2)
    logger.info("User mappings saved to %s", output_path)


if __name__ == "__main__":
    main()
