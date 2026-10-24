import json
from typing import Any, Dict, List, Optional

from ardan.agent.messages import Message, GenerationConfig
from ardan.ollama.prompts import PLANNER_SYSTEM
from ardan.utils.parse import extract_json_array


class PlannerError(Exception):
    pass


def normalize_plan(raw: List[Any], next_id: int = 1) -> List[Dict[str, Any]]:
    """Coerce whatever the model returned into a valid plan.

    Auto-assigns ids, validates types, filters junk entries, and keeps
    depends_on references that actually exist.
    """
    plan: List[Dict[str, Any]] = []
    id_map: Dict[Any, int] = {}

    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            continue
        description = str(entry.get("description") or "").strip()
        if not description:
            continue
        new_id = next_id + len(plan)
        id_map[entry.get("id", index + 1)] = new_id
        deps_raw = entry.get("depends_on") or []
        if not isinstance(deps_raw, list):
            deps_raw = []
        plan.append(
            {
                "id": new_id,
                "description": description,
                "tool_hint": str(entry.get("tool_hint") or ""),
                "depends_on": deps_raw,
            }
        )

    valid_ids = {step["id"] for step in plan}
    for step in plan:
        step["depends_on"] = [
            id_map.get(dep, dep)
            for dep in step["depends_on"]
            if isinstance(dep, (int, str)) and id_map.get(dep, dep) in valid_ids
        ]
        step["depends_on"] = [d for d in dict.fromkeys(step["depends_on"]) if d != step["id"]]

    return plan


class Planner:
    def __init__(self, provider: Any):
        self.provider = provider

    async def create_plan(self, prompt: str) -> List[Dict[str, Any]]:
        msgs = [
            Message(role="system", content=PLANNER_SYSTEM),
            Message(role="user", content=prompt),
        ]
        response = ""
        async for chunk in self.provider.generate(msgs, GenerationConfig(stream=False)):
            response += chunk

        raw = extract_json_array(response)
        if raw is None:
            raise PlannerError(
                "Planner returned no JSON array. Raw response head: "
                + response[:300].replace("\n", " ")
            )

        plan = normalize_plan(raw)
        if not plan:
            raise PlannerError("Planner JSON array contained no valid steps.")

        return plan

    @staticmethod
    def fallback_plan(prompt: str) -> List[Dict[str, Any]]:
        """Single-step plan so a bad planner response kills nothing."""
        return [
            {
                "id": 1,
                "description": prompt.strip() or "Analyze the workspace and complete the task.",
                "tool_hint": "",
                "depends_on": [],
            }
        ]
