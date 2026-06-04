#!/usr/bin/env python3
"""Validate a Codex /goal prompt draft."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


DEFAULT_LIMIT = 4000
REQUIRED_PHRASES = [
    "Required reading:",
    "Constraints/non-goals:",
    "Acceptance criteria:",
    "Verification:",
    "Stop and ask:",
]


def read_text(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    return Path(path).read_text(encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a paste-ready Codex /goal prompt.")
    parser.add_argument("path", help="Path to the draft prompt, or '-' for stdin.")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="Maximum characters.")
    args = parser.parse_args()

    text = read_text(args.path).strip()
    failures: list[str] = []

    if not text.startswith("/goal "):
        failures.append("prompt must start with '/goal '")

    length = len(text)
    if length > args.limit:
        failures.append(f"prompt is {length} characters; limit is {args.limit}")

    for phrase in REQUIRED_PHRASES:
        if phrase not in text:
            failures.append(f"missing required section: {phrase}")

    forbidden_prefixes = ("Here is", "Here's", "Sure", "Analysis", "Before writing")
    if text.startswith(forbidden_prefixes):
        failures.append("prompt includes non-/goal preamble")

    if "production was not touched" in text or "passed:" in text.lower():
        failures.append("prompt appears to include validation claims; avoid inventing proof state")

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1

    print(f"OK: {length} characters")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
