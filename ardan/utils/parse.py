"""Robust extraction of JSON structures and tool calls from LLM output.

LLMs emit tool calls and plans mixed with prose and markdown fences. The
regex-only approach the original project used fell apart on prose wrapped
JSON. These helpers are string-aware and bracket-balanced, so they survive
nested quotes and braces.
"""

import json
import re
from typing import Any, Dict, List, Optional, Tuple


def _strip_code_fences(text: str) -> str:
    """Remove markdown code fences but keep their inner content."""
    return re.sub(r"```[a-zA-Z0-9_-]*\n?", "", text).replace("```", "")


def _scan_balanced(text: str, opener: str, closer: str, start: int = 0) -> Optional[Tuple[int, int]]:
    """Find the first balanced top-level block starting at or after `start`.

    Returns (open_index, close_index_after) or None. String-aware so braces
    inside quotes don't break the counting.
    """
    open_index = text.find(opener, start)
    while open_index != -1:
        depth = 0
        in_string = False
        escaped = False
        for i in range(open_index, len(text)):
            ch = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    return (open_index, i + 1)
        open_index = text.find(opener, open_index + 1)
    return None


def jsonify(fragment: str) -> Optional[Any]:
    """Parse a JSON fragment, returning None instead of raising."""
    try:
        return json.loads(fragment)
    except (json.JSONDecodeError, ValueError):
        return None


def extract_json_array(text: str) -> Optional[List[Any]]:
    """Extract the first JSON array from arbitrary model output.

    Handles fenced blocks, prose wrapping, nested arrays, and arrays whose
    braces contain strings with brackets in them.
    """
    cleaned = _strip_code_fences(text)
    pos = 0
    while True:
        hit = _scan_balanced(cleaned, "[", "]", pos)
        if hit is None:
            return None
        open_index, close_index = hit
        candidate = cleaned[open_index:close_index]
        parsed = jsonify(candidate)
        if isinstance(parsed, list):
            return parsed
        pos = open_index + 1


def extract_json_objects(text: str) -> List[Dict[str, Any]]:
    """Extract every top-level JSON object found in the text."""
    cleaned = _strip_code_fences(text)
    objects: List[Dict[str, Any]] = []
    pos = 0
    while True:
        hit = _scan_balanced(cleaned, "{", "}", pos)
        if hit is None:
            break
        open_index, close_index = hit
        candidate = cleaned[open_index:close_index]
        parsed = jsonify(candidate)
        if isinstance(parsed, dict):
            objects.append(parsed)
            pos = close_index
        else:
            pos = open_index + 1
    return objects


def extract_tool_calls(text: str) -> List[Tuple[str, Dict[str, Any]]]:
    """Extract tool calls in priority order:

    1. ``<tool>{"name": ..., "args": {...}}</tool>`` blocks (the standard).
    2. Fenced or bare JSON objects containing "name"/"args" (some models
       drop the tags under streaming).
    """
    calls: List[Tuple[str, Dict[str, Any]]] = []

    for match in re.finditer(r"<tool>(.*?)</tool>", text, re.DOTALL):
        parsed = jsonify(match.group(1).strip())
        if isinstance(parsed, dict) and isinstance(parsed.get("name"), str):
            calls.append((parsed["name"], parsed.get("args") or {}))
        elif isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict) and isinstance(item.get("name"), str):
                    calls.append((item["name"], item.get("args") or {}))

    if calls:
        return dedupe_calls(calls)

    # Fallback: scan all JSON objects for tool-shaped ones.
    for obj in extract_json_objects(text):
        if isinstance(obj.get("name"), str) and ("args" in obj or "arguments" in obj):
            args = obj.get("args") or obj.get("arguments") or {}
            calls.append((obj["name"], args if isinstance(args, dict) else {}))

    return dedupe_calls(calls)


def dedupe_calls(calls: List[Tuple[str, Dict[str, Any]]]) -> List[Tuple[str, Dict[str, Any]]]:
    """Drop consecutive duplicate tool calls models sometimes repeat."""
    result: List[Tuple[str, Dict[str, Any]]] = []
    seen: List[str] = []
    for name, args in calls:
        key = f"{name}:{json.dumps(args, sort_keys=True, ensure_ascii=False)}"
        if key in seen:
            continue
        seen.append(key)
        result.append((name, args))
    return result


def is_finished(text: str) -> bool:
    """True when the model signalled "<finished>". Case-insensitive."""
    return bool(re.search(r"</?\s*finished\s*>", text, re.IGNORECASE))


def extract_finished_summary(text: str) -> str:
    """Pull the text inside <finished>...</finished>"""
    match = re.search(r"<finished>(.*?)(?:</finished>|\Z)", text, re.IGNORECASE | re.DOTALL)
    return match.group(1).strip() if match else ""
