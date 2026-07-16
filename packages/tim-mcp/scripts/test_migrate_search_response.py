#!/usr/bin/env python3

import logging
import unittest

from migrate_v3_types import discover_projects


class FakeClient:
    def __init__(self, response):
        self.response = response

    def call_tool(self, name, arguments):
        self.assert_search_call(name, arguments)
        return self.response

    @staticmethod
    def assert_search_call(name, arguments):
        if name != "tim_search":
            raise AssertionError(f"unexpected tool: {name}")
        if arguments["topK"] > 100:
            raise AssertionError("tim_search topK exceeds its public schema")


class TestDiscoverProjectsSearchResponse(unittest.TestCase):
    def setUp(self):
        self.logger = logging.getLogger("test-migrate-search-response")
        self.entries = [
            {"id": "01ABC", "metadata": {"kind": "project", "label": "P0042"}},
            {"id": "L0001", "metadata": {"kind": "learning", "label": "L0001"}},
        ]

    def test_accepts_bounded_search_response_object(self):
        response = {
            "results": self.entries,
            "returned": 2,
            "omitted": 0,
            "truncated": False,
        }
        self.assertEqual(discover_projects(FakeClient(response), self.logger), ["P0042"])

    def test_keeps_legacy_array_compatibility(self):
        self.assertEqual(discover_projects(FakeClient(self.entries), self.logger), ["P0042"])


if __name__ == "__main__":
    unittest.main()
