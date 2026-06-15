#!/usr/bin/env python3
"""Unit tests for migrate_v3_types task sub-section helpers."""

from __future__ import annotations

import unittest

from migrate_v3_types import (
    build_task_object,
    is_task_object,
    parse_task_tags,
)


class TestParseTaskTags(unittest.TestCase):
    def test_status_tags(self) -> None:
        parsed = parse_task_tags(["#todo", "#priority-high", "#due-2026-06-15"])
        self.assertEqual(parsed["status"], "todo")
        self.assertEqual(parsed["priority"], "high")
        self.assertEqual(parsed["due_date"], "2026-06-15")

    def test_first_match_wins(self) -> None:
        parsed = parse_task_tags(["#done", "#todo"])
        self.assertEqual(parsed["status"], "done")

    def test_empty_tags(self) -> None:
        self.assertEqual(parse_task_tags([]), {})


class TestBuildTaskObject(unittest.TestCase):
    def test_skips_when_no_tags_and_no_evidence(self) -> None:
        self.assertIsNone(build_task_object([], {}))

    def test_defaults_status_and_priority(self) -> None:
        obj = build_task_object(["#priority-low"], {})
        self.assertIsNotNone(obj)
        assert obj is not None
        self.assertEqual(obj["status"], "todo")
        self.assertEqual(obj["priority"], "low")

    def test_completion_evidence_only(self) -> None:
        obj = build_task_object([], {"completion_evidence": "commit abc"})
        self.assertIsNotNone(obj)
        assert obj is not None
        self.assertEqual(obj["completion_evidence"], "commit abc")
        self.assertEqual(obj["status"], "todo")
        self.assertEqual(obj["priority"], "medium")


class TestIdempotency(unittest.TestCase):
    def test_is_task_object(self) -> None:
        self.assertTrue(is_task_object({"status": "todo"}))
        self.assertFalse(is_task_object(True))
        self.assertFalse(is_task_object(None))
        self.assertFalse(is_task_object("todo"))


if __name__ == "__main__":
    unittest.main()
