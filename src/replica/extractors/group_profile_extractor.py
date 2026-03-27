"""Group profile extractor — extracts topics, roles, and summary for groups."""

import json
import logging
import re
import asyncio

from replica.providers.llm_provider import LLMProvider, get_llm_provider
from replica.prompts import get_prompt
from replica.extractors import (
    GroupProfileMemory,
    MemCellData,
    MemoryType,
)

logger = logging.getLogger(__name__)


class GroupProfileExtractor:
    """Parallel extraction of group content (topics) and behavior (roles)."""

    def __init__(self, llm_provider: LLMProvider | None = None):
        self.llm = llm_provider or get_llm_provider()

    async def extract_memory(
        self,
        memcells: list[MemCellData],
        group_id: str,
        group_name: str = "",
        existing_profile: dict | None = None,
        max_topics: int = 10,
    ) -> GroupProfileMemory | None:
        if not memcells:
            return None

        conversation_text = self._build_conversation_text(memcells)
        if not conversation_text.strip():
            return None

        existing_str = json.dumps(existing_profile or {}, ensure_ascii=False)
        timespan = self._compute_timespan(memcells)

        # Parallel content + behavior analysis
        content_task = self._extract_content(
            conversation_text,
            group_id,
            group_name,
            existing_str,
            timespan,
            max_topics,
        )
        behavior_task = self._extract_behavior(
            conversation_text,
            group_id,
            group_name,
            existing_str,
        )

        content_result, behavior_result = await asyncio.gather(
            content_task, behavior_task
        )

        topics = content_result.get("topics", []) if content_result else []
        summary = content_result.get("summary", "") if content_result else ""
        subject = content_result.get("subject", "") if content_result else ""
        roles = behavior_result.get("roles", {}) if behavior_result else {}

        return GroupProfileMemory(
            memory_type=MemoryType.GROUP_PROFILE,
            group_id=group_id,
            group_name=group_name,
            summary=summary,
            subject=subject,
            topics=topics,
            roles=roles,
        )

    async def _extract_content(
        self,
        conversation: str,
        group_id: str,
        group_name: str,
        existing_profile: str,
        timespan: str,
        max_topics: int,
    ) -> dict | None:
        prompt_template = get_prompt("CONTENT_ANALYSIS_PROMPT")
        prompt = prompt_template.format(
            conversation=conversation,
            group_id=group_id,
            group_name=group_name,
            existing_profile=existing_profile,
            timespan=timespan,
            max_topics=max_topics,
        )

        for attempt in range(3):
            try:
                resp = await self.llm.generate(prompt)
                return self._parse_json_response(resp)
            except Exception as e:
                logger.warning(
                    "Content analysis error (attempt %d): %s", attempt + 1, e
                )
        return None

    async def _extract_behavior(
        self,
        conversation: str,
        group_id: str,
        group_name: str,
        existing_profile: str,
    ) -> dict | None:
        prompt_template = get_prompt("BEHAVIOR_ANALYSIS_PROMPT")
        prompt = prompt_template.format(
            conversation=conversation,
            group_id=group_id,
            group_name=group_name,
            existing_profile=existing_profile,
            speaker_info="",
        )

        for attempt in range(3):
            try:
                resp = await self.llm.generate(prompt)
                return self._parse_json_response(resp)
            except Exception as e:
                logger.warning(
                    "Behavior analysis error (attempt %d): %s", attempt + 1, e
                )
        return None

    def _build_conversation_text(self, memcells: list[MemCellData]) -> str:
        lines = []
        for mc in memcells:
            lines.append(f"=== MEMCELL_ID: {mc.event_id} ===")
            for msg in mc.original_data:
                if not isinstance(msg, dict):
                    continue
                content = msg.get("content", "")
                speaker = msg.get("speaker_name", "")
                ts = msg.get("timestamp", "")
                if content:
                    if ts:
                        lines.append(f"[{ts}] {speaker}: {content}")
                    else:
                        lines.append(f"{speaker}: {content}")
        return "\n".join(lines)

    @staticmethod
    def _compute_timespan(memcells: list[MemCellData]) -> str:
        timestamps = [mc.timestamp for mc in memcells if mc.timestamp]
        if not timestamps:
            return "Unknown"
        start = min(timestamps).strftime("%Y-%m-%d %H:%M")
        end = max(timestamps).strftime("%Y-%m-%d %H:%M")
        return f"{start} to {end}"

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
