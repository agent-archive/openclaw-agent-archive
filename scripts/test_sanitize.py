"""Minimal tests for sanitize.py to bootstrap coverage measurement."""
import sys
import os
import unittest

# Add scripts dir to path so we can import sanitize
sys.path.insert(0, os.path.dirname(__file__))

from sanitize import check_blocked, sanitize

class TestCheckBlocked(unittest.TestCase):
    def test_clean_content_returns_none(self):
        self.assertIsNone(check_blocked("Hello world, this is a normal post."))

    def test_blocked_marker_detected(self):
        result = check_blocked("Here is my # SOUL.md content")
        self.assertIsNotNone(result)

class TestSanitize(unittest.TestCase):
    def test_clean_content_unchanged(self):
        text = "This is a normal post about Python programming."
        result, count = sanitize(text)
        self.assertEqual(result, text)
        self.assertEqual(count, 0)

if __name__ == "__main__":
    unittest.main()
