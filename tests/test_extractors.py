"""Extractor data structures and helper function tests."""

from datetime import datetime, timezone, timedelta

import pytest

from replica.extractors import (
    MemCellData,
    EpisodeMemory,
    EventLog,
    Foresight,
    BoundaryDetectionResult,
    RawData,
    MemoryType,
    RawDataType,
)
from replica.extractors.memcell_extractor import ConvMemCellExtractor
from replica.extractors.episode_extractor import EpisodeMemoryExtractor
from replica.extractors.event_log_extractor import EventLogExtractor
from replica.extractors.foresight_extractor import ForesightExtractor


class TestDataClasses:
    def test_memcell_data_defaults(self):
        m = MemCellData()
        assert isinstance(m.event_id, str)
        assert m.user_id_list == []
        assert m.original_data == []
        assert m.data_type == RawDataType.CONVERSATION

    def test_episode_memory_creation(self):
        e = EpisodeMemory(
            memory_type=MemoryType.EPISODIC_MEMORY,
            title="Test Episode",
            episode="Something happened",
        )
        assert e.title == "Test Episode"
        assert e.memory_type == MemoryType.EPISODIC_MEMORY

    def test_event_log_creation(self):
        ev = EventLog(
            memory_type=MemoryType.EVENT_LOG,
            atomic_fact=["fact1", "fact2"],
        )
        assert len(ev.atomic_fact) == 2

    def test_foresight_creation(self):
        f = Foresight(
            memory_type=MemoryType.FORESIGHT,
            content="User will likely do X",
            evidence="They mentioned X",
        )
        assert f.content == "User will likely do X"

    def test_boundary_detection_result(self):
        b = BoundaryDetectionResult(
            should_end=True,
            should_wait=False,
            reasoning="Topic changed",
            confidence=0.9,
            topic_summary="Greeting",
        )
        assert b.should_end is True
        assert b.confidence == 0.9

    def test_raw_data(self):
        r = RawData(content={"content": "hello", "speaker_name": "Alice"})
        assert r.content["content"] == "hello"


class TestMemCellExtractorHelpers:
    def setup_method(self):
        self.extractor = ConvMemCellExtractor.__new__(ConvMemCellExtractor)

    def test_process_raw_text_message(self):
        raw = RawData(content={"msgType": 1, "content": "hello", "speaker_name": "Alice"})
        result = self.extractor._process_raw(raw)
        assert result is not None
        assert result["content"] == "hello"

    def test_process_raw_image_message(self):
        raw = RawData(content={"msgType": 2, "content": "original_img_data", "speaker_name": "Bob"})
        result = self.extractor._process_raw(raw)
        assert result["content"] == "[Image]"

    def test_process_raw_unsupported_type(self):
        raw = RawData(content={"msgType": 999, "content": "unknown"})
        result = self.extractor._process_raw(raw)
        assert result is None

    def test_process_raw_no_msg_type(self):
        raw = RawData(content={"content": "plain text", "speaker_name": "Alice"})
        result = self.extractor._process_raw(raw)
        assert result is not None

    def test_count_tokens(self):
        msgs = [
            {"speaker_name": "Alice", "content": "Hello world"},
            {"speaker_name": "Bob", "content": "Hi there"},
        ]
        tokens = self.extractor._count_tokens(msgs)
        assert tokens > 0

    def test_format_messages_without_timestamps(self):
        msgs = [
            {"speaker_name": "Alice", "content": "Hello"},
            {"speaker_name": "Bob", "content": "Hi"},
        ]
        text = self.extractor._format_messages(msgs, include_timestamps=False)
        assert "Alice: Hello" in text
        assert "Bob: Hi" in text

    def test_format_messages_with_timestamps(self):
        msgs = [
            {"speaker_name": "Alice", "content": "Hello", "timestamp": "2025-01-01T10:00:00Z"},
        ]
        text = self.extractor._format_messages(msgs, include_timestamps=True)
        assert "Alice: Hello" in text
        assert "2025-01-01" in text

    def test_format_messages_empty_content_skipped(self):
        msgs = [
            {"speaker_name": "Alice", "content": ""},
            {"speaker_name": "Bob", "content": "Hi"},
        ]
        text = self.extractor._format_messages(msgs, include_timestamps=False)
        assert "Alice" not in text
        assert "Bob: Hi" in text

    def test_parse_timestamp_iso_string(self):
        ts = ConvMemCellExtractor._parse_timestamp("2025-06-15T10:30:00Z")
        assert isinstance(ts, datetime)
        assert ts.year == 2025

    def test_parse_timestamp_datetime_object(self):
        now = datetime.now(timezone.utc)
        ts = ConvMemCellExtractor._parse_timestamp(now)
        assert ts == now

    def test_parse_timestamp_none(self):
        assert ConvMemCellExtractor._parse_timestamp(None) is None

    def test_parse_timestamp_invalid_string(self):
        assert ConvMemCellExtractor._parse_timestamp("not a date") is None

    def test_calculate_time_gap_seconds(self):
        now = datetime.now(timezone.utc)
        history = [{"timestamp": now.isoformat()}]
        new_msgs = [{"timestamp": (now + timedelta(seconds=30)).isoformat()}]
        gap = self.extractor._calculate_time_gap(history, new_msgs)
        assert "second" in gap.lower()

    def test_calculate_time_gap_minutes(self):
        now = datetime.now(timezone.utc)
        history = [{"timestamp": now.isoformat()}]
        new_msgs = [{"timestamp": (now + timedelta(minutes=15)).isoformat()}]
        gap = self.extractor._calculate_time_gap(history, new_msgs)
        assert "minute" in gap.lower()

    def test_calculate_time_gap_hours(self):
        now = datetime.now(timezone.utc)
        history = [{"timestamp": now.isoformat()}]
        new_msgs = [{"timestamp": (now + timedelta(hours=3)).isoformat()}]
        gap = self.extractor._calculate_time_gap(history, new_msgs)
        assert "hour" in gap.lower()

    def test_calculate_time_gap_days(self):
        now = datetime.now(timezone.utc)
        history = [{"timestamp": now.isoformat()}]
        new_msgs = [{"timestamp": (now + timedelta(days=5)).isoformat()}]
        gap = self.extractor._calculate_time_gap(history, new_msgs)
        assert "day" in gap.lower()

    def test_calculate_time_gap_empty_history(self):
        gap = self.extractor._calculate_time_gap([], [{"timestamp": "2025-01-01T00:00:00Z"}])
        assert "no" in gap.lower()


class TestEpisodeExtractorHelpers:
    def test_parse_json_response_code_block(self):
        resp = '```json\n{"title": "Test", "content": "Episode"}\n```'
        result = EpisodeMemoryExtractor._parse_json_response(resp)
        assert result["title"] == "Test"

    def test_parse_json_response_direct(self):
        resp = '{"title": "Test", "content": "Episode"}'
        result = EpisodeMemoryExtractor._parse_json_response(resp)
        assert result["title"] == "Test"

    def test_parse_json_response_embedded(self):
        resp = 'Here is the result: {"title": "Test", "content": "Episode"} done.'
        result = EpisodeMemoryExtractor._parse_json_response(resp)
        assert result is not None

    def test_parse_json_response_invalid(self):
        result = EpisodeMemoryExtractor._parse_json_response("not json at all")
        assert result is None


class TestEventLogExtractorHelpers:
    def test_parse_json_response_with_event_log_key(self):
        resp = '{"event_log": {"atomic_fact": ["fact1"], "time": "2025-01-01"}}'
        result = EventLogExtractor._parse_json_response(resp)
        assert "event_log" in result or "atomic_fact" in result

    def test_parse_json_response_code_block(self):
        resp = '```json\n{"atomic_fact": ["a", "b"]}\n```'
        result = EventLogExtractor._parse_json_response(resp)
        assert result is not None

    def test_parse_json_response_invalid(self):
        result = EventLogExtractor._parse_json_response("no json here")
        assert result is None


class TestForesightExtractorHelpers:
    def test_parse_json_array_code_block(self):
        resp = '```json\n[{"content": "pred1"}, {"content": "pred2"}]\n```'
        result = ForesightExtractor._parse_json_array(resp)
        assert len(result) == 2

    def test_parse_json_array_direct(self):
        resp = '[{"content": "pred1"}]'
        result = ForesightExtractor._parse_json_array(resp)
        assert len(result) == 1

    def test_parse_json_array_embedded(self):
        resp = 'Result: [{"content": "pred1"}] end'
        result = ForesightExtractor._parse_json_array(resp)
        assert len(result) == 1

    def test_parse_json_array_invalid(self):
        result = ForesightExtractor._parse_json_array("not an array")
        assert result == []

    def test_parse_json_array_returns_list(self):
        resp = '{"content": "not an array"}'
        result = ForesightExtractor._parse_json_array(resp)
        assert result == []


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
