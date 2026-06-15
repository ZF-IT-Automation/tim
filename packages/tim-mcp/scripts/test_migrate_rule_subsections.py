#!/usr/bin/env python3
"""Unit tests for migrate_v3_types rule sub-section helpers."""

from __future__ import annotations

import unittest

from migrate_v3_types import (
    build_rule_object,
    has_rule_tag,
    is_rule_object,
    parse_rule_content,
)


class TestParseRuleContent(unittest.TestCase):
    def test_empty_content_uses_title_as_action(self) -> None:
        parsed = parse_rule_content("Always delegate", "")
        self.assertEqual(parsed["trigger"], "")
        self.assertEqual(parsed["action"], "Always delegate")

    def test_when_sentence_becomes_trigger(self) -> None:
        parsed = parse_rule_content(
            "Fallback title",
            "When user says caveman. Use caveman mode.",
        )
        self.assertEqual(parsed["trigger"], "When user says caveman.")
        self.assertEqual(parsed["action"], "Use caveman mode.")

    def test_trigger_prefix_case_insensitive(self) -> None:
        parsed = parse_rule_content("", "Trigger: on deploy. Run smoke tests.")
        self.assertEqual(parsed["trigger"], "Trigger: on deploy.")
        self.assertEqual(parsed["action"], "Run smoke tests.")

    def test_no_trigger_sentence_uses_full_body(self) -> None:
        parsed = parse_rule_content("Title", "Always commit before exit.")
        self.assertEqual(parsed["trigger"], "")
        self.assertEqual(parsed["action"], "Always commit before exit.")

    def test_multiline_when_trigger(self) -> None:
        parsed = parse_rule_content(
            "Title",
            "When tests fail\nFix before claiming done",
        )
        self.assertEqual(parsed["trigger"], "When tests fail")
        self.assertEqual(parsed["action"], "Fix before claiming done")


class TestBuildRuleObject(unittest.TestCase):
    def test_delegates_to_parse_rule_content(self) -> None:
        obj = build_rule_object("Title", "When X. Do Y.")
        self.assertEqual(obj["trigger"], "When X.")
        self.assertEqual(obj["action"], "Do Y.")


class TestRuleHelpers(unittest.TestCase):
    def test_is_rule_object(self) -> None:
        self.assertTrue(is_rule_object({"trigger": "When X", "action": "Do Y"}))
        self.assertFalse(is_rule_object(True))
        self.assertFalse(is_rule_object(None))

    def test_has_rule_tag(self) -> None:
        self.assertTrue(has_rule_tag(["#rule", "#other"]))
        self.assertTrue(has_rule_tag(["rule"]))
        self.assertFalse(has_rule_tag(["#human"]))


if __name__ == "__main__":
    unittest.main()
