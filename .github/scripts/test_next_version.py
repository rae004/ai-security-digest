"""python3 -m unittest discover .github/scripts"""

import unittest

from next_version import bump, level


class Level(unittest.TestCase):
    def test_types(self):
        self.assertEqual(level("feat: add digest filters"), 2)
        self.assertEqual(level("feat(email): add footer (#12)"), 2)
        self.assertEqual(level("fix: handle empty feed"), 1)
        self.assertEqual(level("perf(scraper): batch requests"), 1)
        for message in ("chore(deps): bump eslint", "docs: readme", "ci: pin actions", "refactor: tidy"):
            self.assertEqual(level(message), 0, message)

    def test_breaking(self):
        self.assertEqual(level("feat!: drop the v1 config"), 3)
        self.assertEqual(level("fix(api)!: rename field"), 3)
        self.assertEqual(level("chore!: require node 24"), 3)
        self.assertEqual(level("feat: new config\n\nBREAKING CHANGE: old keys removed"), 3)
        self.assertEqual(level("feat: new config\n\nBREAKING-CHANGE: old keys removed"), 3)

    def test_not_conventional(self):
        for message in ("Update README", "Merge branch 'main'", "feature: nope is not a type we release", ""):
            self.assertEqual(level(message), 0, message)

    def test_the_word_breaking_in_prose_is_not_a_footer(self):
        self.assertEqual(level("fix: stop breaking change: detection on prose"), 1)


class Bump(unittest.TestCase):
    def test_single_commit(self):
        self.assertEqual(bump("1.4.0", ["feat: a"]), "1.5.0")
        self.assertEqual(bump("1.4.2", ["fix: a"]), "1.4.3")
        self.assertEqual(bump("1.4.2", ["feat!: a"]), "2.0.0")

    def test_biggest_change_wins(self):
        self.assertEqual(bump("1.4.2", ["chore: a", "fix: b", "feat: c", "fix: d"]), "1.5.0")
        self.assertEqual(bump("0.9.9", ["fix: a", "feat!: b"]), "1.0.0")

    def test_no_release(self):
        self.assertIsNone(bump("1.4.0", ["chore(deps): bump x", "docs: y"]))
        self.assertIsNone(bump("1.4.0", []))


if __name__ == "__main__":
    unittest.main()
