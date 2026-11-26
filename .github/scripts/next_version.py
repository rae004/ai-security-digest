#!/usr/bin/env python3
"""Work out the next release version from Conventional Commit messages.

    git log --format=%B%x00 v1.4.0..HEAD | python3 next_version.py 1.4.0

Reads NUL-separated commit messages on stdin and prints the next version, or
nothing when no commit calls for a release. The biggest change wins:

    type!: ...  or a "BREAKING CHANGE:" footer   major
    feat: ...                                    minor
    fix: ... / perf: ...                         patch
    anything else (chore, docs, ci, ...)         no release

Stdlib only, no dependencies.
"""

import re
import sys

HEADER = re.compile(r"^(?P<type>[a-zA-Z]+)(\([^)]*\))?(?P<bang>!)?:\s")
BREAKING = re.compile(r"^BREAKING[ -]CHANGE:\s", re.MULTILINE)
LEVELS = {"feat": 2, "fix": 1, "perf": 1}  # 3 = major, 0 = no release


def level(message: str) -> int:
    """How big a release one commit message asks for."""
    match = HEADER.match(message.strip())
    if not match:
        return 0
    if match["bang"] or BREAKING.search(message):
        return 3
    return LEVELS.get(match["type"].lower(), 0)


def bump(current: str, messages: list[str]) -> str | None:
    """`current` raised by the biggest change in `messages`; None for no release."""
    major, minor, patch = (int(part) for part in current.split("."))
    biggest = max((level(m) for m in messages), default=0)
    if biggest == 3:
        return f"{major + 1}.0.0"
    if biggest == 2:
        return f"{major}.{minor + 1}.0"
    if biggest == 1:
        return f"{major}.{minor}.{patch + 1}"
    return None


def main(argv: list[str]) -> int:
    if len(argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", argv[1]):
        print(__doc__, file=sys.stderr)
        return 2
    messages = [m for m in sys.stdin.read().split("\0") if m.strip()]
    nxt = bump(argv[1], messages)
    if nxt:
        print(nxt)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
