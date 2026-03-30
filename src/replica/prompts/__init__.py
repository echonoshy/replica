"""Multi-language prompt management system.

Usage:
    from replica.prompts import get_prompt

    prompt = get_prompt("EPISODE_GENERATION_PROMPT")           # default language
    prompt = get_prompt("EPISODE_GENERATION_PROMPT", lang="zh")  # specific language
"""

import importlib
from typing import Any

from replica.config import settings

# ── Prompt Registry ─────────────────────────────────────────────────
# Format: {prompt_name: {language: module_path}}

_PROMPT_REGISTRY: dict[str, dict[str, str]] = {
    # Conversation
    "CONV_BOUNDARY_DETECTION_PROMPT": {
        "en": "replica.prompts.en.conv_prompts",
        "zh": "replica.prompts.zh.conv_prompts",
    },
    "CONV_SUMMARY_PROMPT": {
        "en": "replica.prompts.en.conv_prompts",
        "zh": "replica.prompts.zh.conv_prompts",
    },
    # Episode
    "EPISODE_GENERATION_PROMPT": {
        "en": "replica.prompts.en.episode_mem_prompts",
        "zh": "replica.prompts.zh.episode_mem_prompts",
    },
    "DEFAULT_CUSTOM_INSTRUCTIONS": {
        "en": "replica.prompts.en.episode_mem_prompts",
        "zh": "replica.prompts.zh.episode_mem_prompts",
    },
    # Profile
    "CONVERSATION_PROFILE_EXTRACTION_PROMPT": {
        "en": "replica.prompts.en.profile_mem_prompts",
        "zh": "replica.prompts.zh.profile_mem_prompts",
    },
    "CONVERSATION_PROFILE_PART1_EXTRACTION_PROMPT": {
        "en": "replica.prompts.en.profile_mem_part1_prompts",
        "zh": "replica.prompts.zh.profile_mem_part1_prompts",
    },
    "CONVERSATION_PROFILE_PART2_EXTRACTION_PROMPT": {
        "en": "replica.prompts.en.profile_mem_part2_prompts",
        "zh": "replica.prompts.zh.profile_mem_part2_prompts",
    },
    "CONVERSATION_PROFILE_PART3_EXTRACTION_PROMPT": {
        "en": "replica.prompts.en.profile_mem_part3_prompts",
        "zh": "replica.prompts.zh.profile_mem_part3_prompts",
    },
    "CONVERSATION_PROFILE_EVIDENCE_COMPLETION_PROMPT": {
        "en": "replica.prompts.en.profile_mem_evidence_completion_prompt",
        "zh": "replica.prompts.zh.profile_mem_evidence_completion_prompt",
    },
    # Foresight
    "FORESIGHT_GENERATION_PROMPT": {
        "en": "replica.prompts.en.foresight_prompts",
        "zh": "replica.prompts.zh.foresight_prompts",
    },
    # Event Log
    "EVENT_LOG_PROMPT": {
        "en": "replica.prompts.en.event_log_prompts",
        "zh": "replica.prompts.zh.event_log_prompts",
    },
    # Profile Life
    "PROFILE_LIFE_UPDATE_PROMPT": {
        "en": "replica.prompts.en.profile_mem_life_prompts",
        "zh": "replica.prompts.zh.profile_mem_life_prompts",
    },
    "PROFILE_LIFE_COMPACT_PROMPT": {
        "en": "replica.prompts.en.profile_mem_life_prompts",
        "zh": "replica.prompts.zh.profile_mem_life_prompts",
    },
    "PROFILE_LIFE_INITIAL_EXTRACTION_PROMPT": {
        "en": "replica.prompts.en.profile_mem_life_prompts",
        "zh": "replica.prompts.zh.profile_mem_life_prompts",
    },
}


# ── PromptManager ───────────────────────────────────────────────────


class PromptManager:
    """Dynamic multi-language prompt loader with caching."""

    def __init__(self):
        self._cache: dict[str, Any] = {}

    def _load_module(self, module_path: str) -> Any:
        if module_path not in self._cache:
            self._cache[module_path] = importlib.import_module(module_path)
        return self._cache[module_path]

    def get(self, prompt_name: str, lang: str | None = None) -> str:
        if lang is None:
            lang = settings.memory.language
        lang = lang.lower()

        if prompt_name not in _PROMPT_REGISTRY:
            raise ValueError(f"Unknown prompt: {prompt_name}. Available: {list(_PROMPT_REGISTRY.keys())}")

        lang_map = _PROMPT_REGISTRY[prompt_name]
        if lang not in lang_map:
            raise ValueError(f"Language '{lang}' not available for '{prompt_name}'. Available: {list(lang_map.keys())}")

        module = self._load_module(lang_map[lang])
        return getattr(module, prompt_name)

    def list_prompts(self) -> list[str]:
        return list(_PROMPT_REGISTRY.keys())

    def list_languages(self, prompt_name: str) -> list[str]:
        if prompt_name not in _PROMPT_REGISTRY:
            return []
        return list(_PROMPT_REGISTRY[prompt_name].keys())


# ── Singleton convenience ───────────────────────────────────────────

_manager = PromptManager()


def get_prompt(prompt_name: str, lang: str | None = None) -> str:
    """Get a prompt template by name and language."""
    return _manager.get(prompt_name, lang)
