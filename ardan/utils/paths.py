"""@file mention expansion, OpenCode/Claude-Code-style.

Typing `@path/to/file.py` in a prompt attaches that file's content to the
message so the model can actually see it.
"""

import os
import re
from typing import List, Tuple


def _make_file_header(path: str, content: str) -> str:
    return f"\n\n--- FILE: {path} ({len(content)} chars) ---\n{content}"


def find_file_mentions(text: str) -> List[str]:
    """Return unique @path tokens that actually exist on disk."""
    paths: List[str] = []
    for match in re.finditer(r"@([A-Za-z0-9_.\-/\\]+)", text):
        raw = match.group(1)
        if os.path.isfile(raw):
            paths.append(raw)
    seen = set()
    unique = [p for p in paths if not (p in seen or seen.add(p))]
    return unique


def expand_file_mentions(text: str, max_chars_per_file: int = 20000) -> Tuple[str, List[str]]:
    """Replace @mentions with attached file contents.

    Returns (new_text, attached_paths). Mentioned files that don't exist are
    left untouched so the model knows they were referenced but missing.
    """
    attached: List[str] = []
    total_budget = 200000  # hard guard for the whole prompt
    budget = total_budget

    def _replace(match: re.Match) -> str:
        nonlocal budget
        raw = match.group(1)
        if not os.path.isfile(raw) or budget <= 0:
            return match.group(0)
        try:
            with open(raw, "r", encoding="utf-8", errors="replace") as handle:
                content = handle.read(max_chars_per_file)
        except OSError:
            return match.group(0)
        if not content:
            return match.group(0)
        attached.append(raw)
        chunk = _make_file_header(raw, content)
        budget -= len(chunk)
        return chunk

    expanded = re.sub(r"@([A-Za-z0-9_.\-/\\]+)", _replace, text)
    return expanded, attached
