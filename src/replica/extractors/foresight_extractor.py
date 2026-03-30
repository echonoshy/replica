"""Foresight extractor — generates future behavior predictions from conversations."""

import json
import logging
import re
from datetime import datetime

from replica.providers.llm_provider import LLMProvider, get_llm_provider
from replica.providers.embedding_provider import get_embedding_provider
from replica.prompts import get_prompt
from replica.extractors import (
    Foresight,
    MemoryExtractRequest,
    MemoryType,
)

logger = logging.getLogger(__name__)


class ForesightExtractor:
    """Generate 4-10 personal behavioral predictions from conversations."""

    def __init__(self, llm_provider: LLMProvider | None = None):
        self.llm = llm_provider or get_llm_provider()

    async def extract_memory(self, request: MemoryExtractRequest) -> list[Foresight]:
        memcell = request.memcell
        conversation_text = self._format_conversation(memcell.original_data)
        if not conversation_text.strip():
            return []

        user_id = request.user_id or (memcell.user_id_list[0] if memcell.user_id_list else "unknown")
        user_name = user_id  # Can be enhanced with user profile lookup

        prompt_template = get_prompt("FORESIGHT_GENERATION_PROMPT")
        prompt = prompt_template.format(
            USER_ID=user_id,
            USER_NAME=user_name,
            CONVERSATION_TEXT=conversation_text,
        )

        for attempt in range(5):
            try:
                resp = await self.llm.generate(prompt)
                items = self._parse_json_array(resp)
                if not items:
                    logger.warning("No foresight items parsed (attempt %d)", attempt + 1)
                    continue

                foresights = []
                contents = [item.get("content", "") for item in items if item.get("content")]

                # Batch embed all predictions
                embeddings = None
                if contents:
                    try:
                        provider = get_embedding_provider()
                        embeddings = await provider.embed_texts(contents)
                    except Exception as e:
                        logger.warning("Failed to embed foresights: %s", e)

                embed_idx = 0
                for item in items:
                    content = item.get("content", "")
                    if not content:
                        continue
                    vector = embeddings[embed_idx] if embeddings and embed_idx < len(embeddings) else None
                    embed_idx += 1

                    foresights.append(
                        Foresight(
                            memory_type=MemoryType.FORESIGHT,
                            user_id=request.user_id,
                            timestamp=memcell.timestamp,
                            ori_event_id_list=[memcell.event_id],
                            content=content,
                            evidence=item.get("evidence", ""),
                            start_time=item.get("start_time"),
                            end_time=item.get("end_time"),
                            duration_days=item.get("duration_days"),
                            vector=vector,
                        )
                    )

                return foresights

            except Exception as e:
                logger.warning("Foresight extraction error (attempt %d): %s", attempt + 1, e)

        return []

    def _format_conversation(self, messages: list[dict]) -> str:
        lines = []
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            content = msg.get("content", "")
            speaker = msg.get("speaker_name", "")
            ts = msg.get("timestamp", "")
            if content:
                if ts:
                    time_str = ts.strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(ts, datetime) else str(ts)
                    lines.append(f"[{time_str}] {speaker}: {content}")
                else:
                    lines.append(f"{speaker}: {content}")
        return "\n".join(lines)

    @staticmethod
    def _parse_json_array(resp: str) -> list[dict]:
        # Try markdown code block
        code_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", resp, re.DOTALL)
        if code_match:
            try:
                data = json.loads(code_match.group(1).strip())
                if isinstance(data, list):
                    return data
            except json.JSONDecodeError:
                pass
        # Try direct JSON
        try:
            data = json.loads(resp.strip())
            if isinstance(data, list):
                return data
        except json.JSONDecodeError:
            pass
        # Try finding JSON array
        match = re.search(r"\[.*\]", resp, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group())
                if isinstance(data, list):
                    return data
            except json.JSONDecodeError:
                pass
        return []
