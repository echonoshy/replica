"""Event log extractor — extracts atomic facts from conversations."""

import json
import logging
import re
from datetime import datetime

from replica.providers.llm_provider import LLMProvider, get_llm_provider
from replica.providers.embedding_provider import get_embedding_provider
from replica.prompts import get_prompt
from replica.extractors import (
    EventLog,
    MemoryExtractRequest,
    MemoryType,
)

logger = logging.getLogger(__name__)


class EventLogExtractor:
    """Extract atomic facts from conversations for fine-grained retrieval."""

    def __init__(self, llm_provider: LLMProvider | None = None):
        self.llm = llm_provider or get_llm_provider()

    async def extract_memory(self, request: MemoryExtractRequest) -> EventLog | None:
        memcell = request.memcell
        conversation_text = self._format_conversation(memcell.original_data)
        if not conversation_text.strip():
            return None

        timestamp_str = ""
        if memcell.timestamp:
            timestamp_str = memcell.timestamp.strftime("%B %d, %Y(%A) at %I:%M %p UTC")

        prompt_template = get_prompt("EVENT_LOG_PROMPT")
        # The event log prompt uses {{TIME}} and {{INPUT_TEXT}} (double braces)
        prompt = prompt_template.replace("{{TIME}}", timestamp_str).replace(
            "{{INPUT_TEXT}}", conversation_text
        )

        for attempt in range(5):
            try:
                resp = await self.llm.generate(prompt)
                parsed = self._parse_json_response(resp)
                if parsed:
                    event_log_data = parsed.get("event_log", parsed)
                    atomic_facts = event_log_data.get("atomic_fact", [])
                    time_str = event_log_data.get("time", timestamp_str)

                    if not atomic_facts:
                        logger.warning(
                            "No atomic facts extracted (attempt %d)", attempt + 1
                        )
                        continue

                    # Batch embed all facts
                    fact_embeddings = None
                    try:
                        provider = get_embedding_provider()
                        fact_embeddings = await provider.embed_texts(atomic_facts)
                    except Exception as e:
                        logger.warning("Failed to embed atomic facts: %s", e)

                    return EventLog(
                        memory_type=MemoryType.EVENT_LOG,
                        user_id=request.user_id,
                        group_id=request.group_id or memcell.group_id,
                        timestamp=memcell.timestamp,
                        ori_event_id_list=[memcell.event_id],
                        time=time_str,
                        atomic_fact=atomic_facts,
                        fact_embeddings=fact_embeddings,
                    )
                logger.warning("Event log parse failed (attempt %d)", attempt + 1)
            except Exception as e:
                logger.warning(
                    "Event log extraction error (attempt %d): %s", attempt + 1, e
                )

        return None

    def _format_conversation(self, messages: list[dict]) -> str:
        lines = []
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            content = msg.get("content", "")
            speaker = msg.get("speaker_name", "")
            ts = msg.get("timestamp", "")
            if content:
                time_str = ""
                if ts:
                    if isinstance(ts, datetime):
                        time_str = ts.strftime("%Y-%m-%dT%H:%M:%SZ")
                    else:
                        time_str = str(ts)
                    lines.append(f"[{time_str}] {speaker}: {content}")
                else:
                    lines.append(f"{speaker}: {content}")
        return "\n".join(lines)

    @staticmethod
    def _parse_json_response(resp: str) -> dict | None:
        code_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", resp, re.DOTALL)
        if code_match:
            try:
                return json.loads(code_match.group(1).strip())
            except json.JSONDecodeError:
                pass
        try:
            return json.loads(resp.strip())
        except json.JSONDecodeError:
            pass
        match = re.search(r"\{.*\}", resp, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        return None
