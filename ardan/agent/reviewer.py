import re
from typing import Dict, Any, List, Optional

from ardan.agent.messages import Message, GenerationConfig
from ardan.agent.planner import normalize_plan
from ardan.ollama.prompts import REVIEWER_SYSTEM
from ardan.agent.memory import Memory
from ardan.utils.parse import extract_json_array, extract_json_objects


class Reviewer:
    def __init__(self, provider: Any, memory: Memory):
        self.provider = provider
        self.memory = memory

    async def review_work(self, task: str) -> Optional[List[Dict[str, Any]]]:
        """Return None when the work passed, else a list of fix steps."""
        context = self.memory.get_recent_context(limit=40)
        prompt = f"""
Original Task: {task}

Files Created: {', '.join(self.memory.files_created) or 'none'}
Files Modified: {', '.join(self.memory.files_modified) or 'none'}
Commands Run: {', '.join(self.memory.commands_run[-20:]) or 'none'}

Action history (most important parts):
{context}

Review whether the work is complete and correct for the original task.
If yes respond PASSED, otherwise respond with the JSON array of fix steps.
"""

        msgs = [
            Message(role="system", content=REVIEWER_SYSTEM),
            Message(role="user", content=prompt),
        ]
        response = ""
        async for chunk in self.provider.generate(msgs, GenerationConfig(stream=False)):
            response += chunk

        if re.search(r"\bPASSED\b", response):
            return None

        raw = extract_json_array(response)
        if raw:
            fix_plan = normalize_plan(raw, next_id=9000)
            if fix_plan:
                return fix_plan

        # Fallback: grab any JSON fix-step object, else generic fix step.
        for obj in extract_json_objects(response):
            if "description" in obj:
                normalized = normalize_plan([obj], next_id=9000)
                if normalized:
                    return normalized

        return normalize_plan(
            [
                {
                    "description": f"Fix issues found in review: {response[:400]}",
                    "tool_hint": "",
                    "depends_on": [],
                }
            ],
            next_id=9000,
        )
