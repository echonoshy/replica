"""Episode memory extractor — converts MemCell conversations into narrative episodes."""

import json
import logging
import re
from datetime import datetime

from replica.providers.llm_provider import LLMProvider, get_llm_provider
from replica.providers.embedding_provider import get_embedding_provider
from replica.prompts import get_prompt
from replica.extractors import (
    EpisodeMemory,
    MemoryExtractRequest,
    MemoryType,
)

logger = logging.getLogger(__name__)


class EpisodeMemoryExtractor:
    """Extract narrative episodic memories from MemCell conversations."""

    def __init__(self, llm_provider: LLMProvider | None = None):
        self.llm = llm_provider or get_llm_provider()

    async def extract_memory(
        self,
        request: MemoryExtractRequest,
        is_group: bool = False,
    ) -> EpisodeMemory | None:
        """Extract an episode memory from a MemCell."""
        memcell = request.memcell
        conversation_text = self._format_conversation(memcell.original_data)

        if not conversation_text.strip():
            return None

        timestamp_str = ""
        if memcell.timestamp:
            timestamp_str = memcell.timestamp.strftime("%B %d, %Y (%A) at %I:%M %p UTC")

        prompt_name = "GROUP_EPISODE_GENERATION_PROMPT" if is_group else "EPISODE_GENERATION_PROMPT"
        custom_instructions = get_prompt("DEFAULT_CUSTOM_INSTRUCTIONS")
        prompt_template = get_prompt(prompt_name)

        prompt = prompt_template.format(
            conversation_start_time=timestamp_str,
            conversation=conversation_text,
            custom_instructions=custom_instructions,
        )

        # Call LLM and parse response
        for attempt in range(5):
            try:
                resp = await self.llm.generate(prompt)
                parsed = self._parse_json_response(resp)
                if parsed and "title" in parsed and "content" in parsed:
                    title = parsed["title"]
                    content = parsed["content"]

                    # Compute embedding
                    embedding = None
                    try:
                        provider = get_embedding_provider()
                        embedding = await provider.embed_query(content)
                    except Exception as e:
                        logger.warning("Failed to compute episode embedding: %s", e)

                    episode = EpisodeMemory(
                        memory_type=MemoryType.EPISODIC_MEMORY,
                        user_id=request.user_id,
                        group_id=request.group_id or memcell.group_id,
                        timestamp=memcell.timestamp,
                        ori_event_id_list=[memcell.event_id],
                        title=title,
                        episode=content,
                        summary=title,
                        subject=title,
                        participants=memcell.participants,
                        memcell_event_id_list=[memcell.event_id],
                        extend={"embedding": embedding} if embedding else None,
                    )
                    return episode

                logger.warning(
                    "Episode parse failed (attempt %d): missing title/content",
                    attempt + 1,
                )
            except Exception as e:
                logger.warning("Episode extraction error (attempt %d): %s", attempt + 1, e)

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
                if ts:
                    time_str = self._format_ts(ts)
                    lines.append(f"[{time_str}] {speaker}: {content}")
                else:
                    lines.append(f"{speaker}: {content}")
        return "\n".join(lines)

    @staticmethod
    def _format_ts(ts) -> str:
        if isinstance(ts, datetime):
            return ts.strftime("%Y-%m-%dT%H:%M:%SZ")
        return str(ts)

    @staticmethod
    def _parse_json_response(resp: str) -> dict | None:
        # Try markdown code block
        code_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", resp, re.DOTALL)
        if code_match:
            try:
                return json.loads(code_match.group(1).strip())
            except json.JSONDecodeError:
                pass
        # Try direct JSON
        try:
            return json.loads(resp.strip())
        except json.JSONDecodeError:
            pass
        # Try finding JSON object
        match = re.search(r"\{.*\}", resp, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        return None
