"""Conversation MemCell extractor — boundary detection + MemCell creation."""

import json
import logging
import re
from datetime import datetime

from replica.config import settings
from replica.providers.llm_provider import LLMProvider, get_llm_provider
from replica.prompts import get_prompt
from replica.services.embedding_service import count_tokens
from replica.extractors import (
    BoundaryDetectionResult,
    MemCellData,
    MemCellExtractRequest,
    RawData,
    StatusResult,
)

logger = logging.getLogger(__name__)

# Supported message types and placeholders
_SUPPORTED_MSG_TYPES = {
    1: None,  # TEXT
    2: "[Image]",
    3: "[Video]",
    4: "[Audio]",
    5: "[File]",
    6: "[File]",
}


class ConvMemCellExtractor:
    """Boundary detection and MemCell creation from conversations.

    Uses LLM to detect episode boundaries (topic change, time gap, intent shift).
    Force-splits at token/message limits.
    """

    def __init__(
        self,
        llm_provider: LLMProvider | None = None,
        hard_token_limit: int | None = None,
        hard_message_limit: int | None = None,
    ):
        self.llm = llm_provider or get_llm_provider()
        self.hard_token_limit = hard_token_limit or settings.memory.boundary_max_tokens
        self.hard_message_limit = hard_message_limit or settings.memory.boundary_max_messages
        self._boundary_prompt = get_prompt("CONV_BOUNDARY_DETECTION_PROMPT")

    async def extract_memcell(self, request: MemCellExtractRequest) -> tuple[MemCellData | None, StatusResult]:
        """Detect boundary and create MemCell if boundary found."""
        history = [self._process_raw(r) for r in request.history_raw_data_list]
        history = [m for m in history if m is not None]

        new_msgs = [self._process_raw(r) for r in request.new_raw_data_list]
        new_msgs = [m for m in new_msgs if m is not None]

        if not new_msgs:
            return None, StatusResult(should_wait=True)

        # Force split check
        total_tokens = self._count_tokens(history) + self._count_tokens(new_msgs)
        total_messages = len(history) + len(new_msgs)

        needs_force_split = total_tokens >= self.hard_token_limit or total_messages >= self.hard_message_limit

        if needs_force_split and len(history) >= 2:
            logger.debug(
                "Force split: tokens=%d/%d, messages=%d/%d",
                total_tokens,
                self.hard_token_limit,
                total_messages,
                self.hard_message_limit,
            )
            memcell = self._create_memcell(history, request, summary="")
            return memcell, StatusResult(should_wait=False)

        # LLM-based boundary detection
        result = await self._detect_boundary(history, new_msgs)

        if result.should_end:
            summary = result.topic_summary or "Conversation segment"
            memcell = self._create_memcell(history, request, summary=summary)
            return memcell, StatusResult(should_wait=result.should_wait)

        return None, StatusResult(should_wait=result.should_wait)

    async def _detect_boundary(
        self,
        history: list[dict],
        new_messages: list[dict],
    ) -> BoundaryDetectionResult:
        if not history:
            return BoundaryDetectionResult(
                should_end=False,
                should_wait=False,
                reasoning="First messages",
                confidence=1.0,
            )

        history_text = self._format_messages(history, include_timestamps=True)
        new_text = self._format_messages(new_messages, include_timestamps=True)
        time_gap = self._calculate_time_gap(history, new_messages)

        prompt = self._boundary_prompt.format(
            conversation_history=history_text,
            new_messages=new_text,
            time_gap_info=time_gap,
        )

        for attempt in range(5):
            try:
                resp = await self.llm.generate(prompt)
                match = re.search(r"\{[^{}]*\}", resp, re.DOTALL)
                if match:
                    data = json.loads(match.group())
                    return BoundaryDetectionResult(
                        should_end=data.get("should_end", False),
                        should_wait=data.get("should_wait", True),
                        reasoning=data.get("reasoning", ""),
                        confidence=data.get("confidence", 1.0),
                        topic_summary=data.get("topic_summary", ""),
                    )
                logger.warning("Failed to parse boundary JSON (attempt %d)", attempt + 1)
            except Exception as e:
                logger.warning("Boundary detection error (attempt %d): %s", attempt + 1, e)

        return BoundaryDetectionResult(
            should_end=False,
            should_wait=True,
            reasoning="All retries exhausted",
            confidence=0.0,
        )

    def _create_memcell(self, messages: list[dict], request: MemCellExtractRequest, summary: str) -> MemCellData:
        ts = self._parse_timestamp(messages[-1].get("timestamp")) if messages else None
        participants = list({m.get("speaker_id", "") for m in messages if m.get("speaker_id")})
        return MemCellData(
            user_id_list=request.user_id_list,
            original_data=messages,
            timestamp=ts,
            summary=summary,
            participants=participants,
        )

    def _process_raw(self, raw_data: RawData) -> dict | None:
        content = raw_data.content.copy() if isinstance(raw_data.content, dict) else raw_data.content
        msg_type = content.get("msgType") if isinstance(content, dict) else None
        if isinstance(content, dict) and msg_type is not None:
            if msg_type not in _SUPPORTED_MSG_TYPES:
                return None
            placeholder = _SUPPORTED_MSG_TYPES[msg_type]
            if placeholder is not None:
                content = content.copy()
                content["content"] = placeholder
        return content

    def _count_tokens(self, messages: list[dict]) -> int:
        total = 0
        for msg in messages:
            speaker = msg.get("speaker_name", "") if isinstance(msg, dict) else ""
            content = msg.get("content", "") if isinstance(msg, dict) else str(msg)
            text = f"{speaker}: {content}" if speaker else content
            total += count_tokens(text)
        return total

    def _format_messages(self, messages: list[dict], include_timestamps: bool = False) -> str:
        lines = []
        for msg in messages:
            content = msg.get("content", "")
            speaker = msg.get("speaker_name", "")
            ts = msg.get("timestamp", "")
            if not content:
                continue
            if include_timestamps and ts:
                time_str = self._format_timestamp(ts)
                lines.append(f"[{time_str}] {speaker}: {content}")
            else:
                lines.append(f"{speaker}: {content}")
        return "\n".join(lines)

    def _calculate_time_gap(self, history: list[dict], new_messages: list[dict]) -> str:
        if not history or not new_messages:
            return "No time gap information available"
        try:
            last_ts = self._parse_timestamp(history[-1].get("timestamp"))
            first_ts = self._parse_timestamp(new_messages[0].get("timestamp"))
            if not last_ts or not first_ts:
                return "No timestamp information available"
            diff = (first_ts - last_ts).total_seconds()
            if diff < 60:
                return f"Time gap: {int(diff)} seconds"
            elif diff < 3600:
                return f"Time gap: {int(diff // 60)} minutes"
            elif diff < 86400:
                return f"Time gap: {int(diff // 3600)} hours"
            else:
                return f"Time gap: {int(diff // 86400)} days"
        except Exception:
            return "Time gap calculation error"

    @staticmethod
    def _parse_timestamp(ts) -> datetime | None:
        if isinstance(ts, datetime):
            return ts
        if isinstance(ts, str):
            try:
                return datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except ValueError:
                return None
        return None

    @staticmethod
    def _format_timestamp(ts) -> str:
        if isinstance(ts, datetime):
            return ts.strftime("%Y-%m-%d %H:%M:%S")
        if isinstance(ts, str):
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                return dt.strftime("%Y-%m-%d %H:%M:%S")
            except ValueError:
                return str(ts)
        return str(ts)
