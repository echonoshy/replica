"""Compaction service pure function tests."""

import enum

import pytest

from replica.services.compaction_service import _format_messages_as_summary


class MockRole(str, enum.Enum):
    user = "user"
    assistant = "assistant"
    system = "system"


class MockMessage:
    def __init__(self, role: MockRole, content: str):
        self.role = role
        self.content = content


class TestFormatMessagesAsSummary:
    def test_single_message(self):
        msgs = [MockMessage(MockRole.user, "Hello")]
        result = _format_messages_as_summary(msgs)
        assert "[user]: Hello" in result

    def test_multiple_messages(self):
        msgs = [
            MockMessage(MockRole.user, "Hello"),
            MockMessage(MockRole.assistant, "Hi there!"),
            MockMessage(MockRole.user, "How are you?"),
        ]
        result = _format_messages_as_summary(msgs)
        assert "[user]: Hello" in result
        assert "[assistant]: Hi there!" in result
        assert "[user]: How are you?" in result

    def test_preserves_order(self):
        msgs = [
            MockMessage(MockRole.user, "First"),
            MockMessage(MockRole.assistant, "Second"),
            MockMessage(MockRole.user, "Third"),
        ]
        result = _format_messages_as_summary(msgs)
        lines = result.split("\n\n")
        assert "First" in lines[0]
        assert "Second" in lines[1]
        assert "Third" in lines[2]

    def test_empty_list(self):
        result = _format_messages_as_summary([])
        assert result == ""

    def test_separator_is_double_newline(self):
        msgs = [
            MockMessage(MockRole.user, "A"),
            MockMessage(MockRole.assistant, "B"),
        ]
        result = _format_messages_as_summary(msgs)
        assert "\n\n" in result

    def test_system_role(self):
        msgs = [MockMessage(MockRole.system, "System message")]
        result = _format_messages_as_summary(msgs)
        assert "[system]: System message" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
