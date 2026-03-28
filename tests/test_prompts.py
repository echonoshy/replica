"""Prompt management system tests."""

import pytest

from replica.prompts import get_prompt, _manager


class TestGetPrompt:
    def test_get_episode_prompt_en(self):
        prompt = get_prompt("EPISODE_GENERATION_PROMPT", lang="en")
        assert isinstance(prompt, str)
        assert len(prompt) > 0

    def test_get_episode_prompt_zh(self):
        prompt = get_prompt("EPISODE_GENERATION_PROMPT", lang="zh")
        assert isinstance(prompt, str)
        assert len(prompt) > 0

    def test_get_event_log_prompt(self):
        prompt = get_prompt("EVENT_LOG_PROMPT", lang="en")
        assert isinstance(prompt, str)
        assert len(prompt) > 0

    def test_get_foresight_prompt(self):
        prompt = get_prompt("FORESIGHT_GENERATION_PROMPT", lang="en")
        assert isinstance(prompt, str)
        assert len(prompt) > 0

    def test_get_boundary_detection_prompt(self):
        prompt = get_prompt("CONV_BOUNDARY_DETECTION_PROMPT", lang="en")
        assert isinstance(prompt, str)
        assert len(prompt) > 0

    def test_get_profile_prompt(self):
        prompt = get_prompt("CONVERSATION_PROFILE_EXTRACTION_PROMPT", lang="en")
        assert isinstance(prompt, str)

    def test_get_group_profile_prompt(self):
        prompt = get_prompt("CONTENT_ANALYSIS_PROMPT", lang="en")
        assert isinstance(prompt, str)

    def test_default_language_uses_config(self):
        prompt = get_prompt("EPISODE_GENERATION_PROMPT")
        assert isinstance(prompt, str)
        assert len(prompt) > 0

    def test_en_and_zh_are_different(self):
        en = get_prompt("EPISODE_GENERATION_PROMPT", lang="en")
        zh = get_prompt("EPISODE_GENERATION_PROMPT", lang="zh")
        assert en != zh


class TestPromptErrors:
    def test_unknown_prompt_raises(self):
        with pytest.raises(ValueError, match="Unknown prompt"):
            get_prompt("NONEXISTENT_PROMPT")

    def test_unknown_language_raises(self):
        with pytest.raises(ValueError, match="not available"):
            get_prompt("EPISODE_GENERATION_PROMPT", lang="fr")


class TestPromptManager:
    def test_list_prompts(self):
        prompts = _manager.list_prompts()
        assert isinstance(prompts, list)
        assert len(prompts) > 0
        assert "EPISODE_GENERATION_PROMPT" in prompts
        assert "EVENT_LOG_PROMPT" in prompts

    def test_list_languages(self):
        langs = _manager.list_languages("EPISODE_GENERATION_PROMPT")
        assert "en" in langs
        assert "zh" in langs

    def test_list_languages_unknown_prompt(self):
        langs = _manager.list_languages("NONEXISTENT")
        assert langs == []


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
