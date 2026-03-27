"""Profile memory extractor — extracts user profiles from conversations."""

import json
import logging
import re
import asyncio

from replica.providers.llm_provider import LLMProvider, get_llm_provider
from replica.prompts import get_prompt
from replica.extractors import (
    ProfileMemory,
    MemCellData,
    MemoryType,
)

logger = logging.getLogger(__name__)


class ProfileMemoryExtractor:
    """Two-stage profile extraction from conversations.

    Part 1: Skills, personality, decision-making, working habits
    Part 2: Role responsibility, opinions, project participation
    """

    def __init__(self, llm_provider: LLMProvider | None = None):
        self.llm = llm_provider or get_llm_provider()

    async def extract_profiles(
        self,
        memcells: list[MemCellData],
        existing_profiles: dict | None = None,
        project_id: str = "",
        project_name: str = "",
    ) -> list[ProfileMemory]:
        """Extract profiles for all participants across multiple MemCells."""
        if not memcells:
            return []

        conversation_text = self._build_conversation_text(memcells)
        if not conversation_text.strip():
            return []

        profiles_str = json.dumps(existing_profiles or {}, ensure_ascii=False)
        base_memory_str = "{}"

        # Run Part 1 and Part 2 in parallel
        part1_task = self._extract_part(
            "CONVERSATION_PROFILE_PART1_EXTRACTION_PROMPT",
            conversation_text,
            project_id,
            project_name,
            profiles_str,
            base_memory_str,
        )
        part2_task = self._extract_part(
            "CONVERSATION_PROFILE_PART2_EXTRACTION_PROMPT",
            conversation_text,
            project_id,
            project_name,
            profiles_str,
            base_memory_str,
        )

        part1_result, part2_result = await asyncio.gather(part1_task, part2_task)

        # Merge results
        merged = self._merge_profiles(part1_result, part2_result)
        return merged

    async def _extract_part(
        self,
        prompt_name: str,
        conversation: str,
        project_id: str,
        project_name: str,
        profiles: str,
        base_memory: str,
    ) -> list[dict]:
        prompt_template = get_prompt(prompt_name)
        prompt = prompt_template.format(
            conversation=conversation,
            project_id=f"{project_id}:{project_name}",
            project_name=project_name,
            participants_profile=profiles,
            participants_baseMemory=base_memory,
        )

        for attempt in range(5):
            try:
                resp = await self.llm.generate(prompt)
                parsed = self._parse_json_response(resp)
                if parsed and "user_profiles" in parsed:
                    return parsed["user_profiles"]
                logger.warning(
                    "Profile parse failed (attempt %d): no user_profiles key",
                    attempt + 1,
                )
            except Exception as e:
                logger.warning(
                    "Profile extraction error (attempt %d): %s", attempt + 1, e
                )

        return []

    def _merge_profiles(
        self, part1: list[dict], part2: list[dict]
    ) -> list[ProfileMemory]:
        """Merge Part 1 and Part 2 results by user_id."""
        by_user: dict[str, dict] = {}

        for p in part1:
            uid = p.get("user_id", "")
            if uid:
                by_user[uid] = {**p}

        for p in part2:
            uid = p.get("user_id", "")
            if uid:
                if uid in by_user:
                    by_user[uid].update(
                        {k: v for k, v in p.items() if v and k != "user_id"}
                    )
                else:
                    by_user[uid] = {**p}

        result = []
        for uid, data in by_user.items():
            profile = ProfileMemory(
                memory_type=MemoryType.PROFILE,
                user_id=uid,
                user_name=data.get("user_name"),
                output_reasoning=data.get("output_reasoning"),
                hard_skills=data.get("hard_skills", []),
                soft_skills=data.get("soft_skills", []),
                personality=data.get("personality", []),
                way_of_decision_making=data.get("way_of_decision_making", []),
                working_habit_preference=data.get("working_habit_preference", []),
                role_responsibility=data.get("role_responsibility", []),
                opinion_tendency=data.get("opinion_tendency", []),
                projects_participated=data.get("projects_participated", []),
                interests=data.get("interests", []),
                tendency=data.get("tendency", []),
                motivation_system=data.get("motivation_system", []),
                fear_system=data.get("fear_system", []),
                value_system=data.get("value_system", []),
                humor_use=data.get("humor_use", []),
                colloquialism=data.get("colloquialism", []),
                user_goal=data.get("user_goal", []),
                work_responsibility=data.get("work_responsibility", []),
            )
            result.append(profile)

        return result

    def _build_conversation_text(self, memcells: list[MemCellData]) -> str:
        """Build combined conversation text from multiple MemCells."""
        lines = []
        for mc in memcells:
            lines.append(f"=== MEMCELL_ID: {mc.event_id} ===")
            for msg in mc.original_data:
                if not isinstance(msg, dict):
                    continue
                content = msg.get("content", "")
                speaker = msg.get("speaker_name", "")
                speaker_id = msg.get("speaker_id", "")
                ts = msg.get("timestamp", "")
                if content:
                    speaker_fmt = (
                        f"{speaker}(user_id:{speaker_id})" if speaker_id else speaker
                    )
                    if ts:
                        lines.append(f"[{ts}] {speaker_fmt}: {content}")
                    else:
                        lines.append(f"{speaker_fmt}: {content}")
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
