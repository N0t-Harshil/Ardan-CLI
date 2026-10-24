import os
import subprocess
from typing import Any, AsyncIterator, Dict, List, Optional

from ardan.agent.executor import Executor
from ardan.agent.memory import Memory
from ardan.agent.messages import GenerationConfig, Message
from ardan.agent.planner import Planner, PlannerError
from ardan.agent.reviewer import Reviewer
from ardan.config.settings import Settings
from ardan.ollama.prompts import CHAT_SYSTEM
from ardan.providers.registry import detect_active_provider, get_provider_instance


class AgentCore:
    """Orchestrates the Ardan cycle:

    warn -> plan -> execute (DAG-aware, parallel where possible)
         -> review -> fix -> suggest.
    """

    def __init__(
        self,
        settings: Settings,
        provider_override: Optional[str] = None,
        model_override: Optional[str] = None,
        workspace_override: Optional[str] = None,
        session_id: Optional[int] = None,
    ):
        self.settings = settings
        self.provider_name = detect_active_provider(
            cli_flag=provider_override,
            env_var=os.getenv("ARDAN_PROVIDER"),
            config_val=settings.default_provider,
        )
        self.workspace = os.path.abspath(workspace_override or settings.agent_workspace)
        os.makedirs(self.workspace, exist_ok=True)

        self.provider = get_provider_instance(self.provider_name, settings.config)
        if model_override:
            self.provider.default_model = model_override
        self.model = self.provider.default_model

        self.memory = Memory(self.workspace, session_id=session_id)
        self.planner = Planner(self.provider)
        self.executor = Executor(self.provider, self.memory, settings=settings.config)
        self.reviewer = Reviewer(self.provider, self.memory)
        self.chat_history: List[Message] = []

    # ----------------------------------------------------------------- run

    def warn_uncommitted(self) -> Optional[str]:
        try:
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=self.workspace,
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.stdout.strip():
                return "Uncommitted git changes detected in the workspace."
        except (OSError, subprocess.SubprocessError):
            pass
        return None

    async def build_system(self, prompt: str, auto: bool = False) -> AsyncIterator[Dict[str, Any]]:
        show_raw = self.settings.show_raw_llm_output
        warn = self.warn_uncommitted()
        if warn:
            yield {"status": "WARNING", "message": warn}

        # 1. PLAN -----------------------------------------------------------
        yield {"status": "PLANNING", "message": "Analyzing request..."}
        try:
            plan = await self.planner.create_plan(prompt)
        except (PlannerError, Exception) as error:  # noqa: BLE001 - fallback keeps build alive
            yield {
                "status": "WARNING",
                "message": f"Planner failed ({error}); falling back to a single execution step.",
            }
            plan = Planner.fallback_plan(prompt)

        yield {"status": "PLAN_READY", "plan": plan}
        if not auto and self.settings.agent_auto_confirm is False:
            pass  # confirmation is handled by the CLI layer

        # 2. EXECUTE (dependency-aware scheduling) ---------------------------
        completed: set = set()
        executed_steps = 0
        max_steps = self.settings.agent_max_steps

        while len(completed) < len(plan) and executed_steps < max_steps:
            ready = [
                s
                for s in plan
                if s["id"] not in completed
                and all(dep in completed for dep in s.get("depends_on", []))
            ]
            if not ready:
                yield {
                    "status": "WARNING",
                    "message": "Plan scheduling stalled (circular dependency or missing step). Continuing to review.",
                }
                break

            if len(ready) > 1:
                yield {"status": "EXECUTING_PARALLEL", "steps": ready}
                async for event in self.executor.run_parallel(ready):
                    mapped = self._map_event(event, show_raw)
                    if mapped:
                        yield mapped
                for step in ready:
                    completed.add(step["id"])
                executed_steps += len(ready)
            else:
                step = ready[0]
                yield {"status": "STEP_START", "step": step}
                async for event in self.executor.execute_step(step):
                    mapped = self._map_event(event, show_raw)
                    if mapped:
                        yield mapped
                completed.add(step["id"])
                executed_steps += 1
                yield {"status": "STEP_COMPLETE", "step": step}

        if executed_steps >= max_steps:
            yield {
                "status": "WARNING",
                "message": f"Step budget exhausted ({max_steps} steps). Stopping execution.",
            }

        # 3. REVIEW + FIX -----------------------------------------------------
        if self.settings.get("agent", "auto_fix_errors", True) is not False:
            yield {"status": "REVIEWING", "message": "Performing senior code review..."}
            fix_plan: Optional[List[Dict[str, Any]]] = None
            try:
                fix_plan = await self.reviewer.review_work(prompt)
            except Exception as error:  # noqa: BLE001 - review must not kill the run
                yield {
                    "status": "WARNING",
                    "message": f"Reviewer could not run: {error}",
                }
            if fix_plan:
                yield {"status": "FIXING", "message": "Applying corrections...", "fix_plan": fix_plan}
                for step in fix_plan:
                    yield {"status": "STEP_START", "step": step}
                    try:
                        async for event in self.executor.execute_step(step):
                            mapped = self._map_event(event, show_raw)
                            if mapped:
                                yield mapped
                    except Exception as error:  # noqa: BLE001
                        yield {"status": "WARNING", "message": f"Fix step failed: {error}"}
                    yield {"status": "STEP_COMPLETE", "step": step}
        else:
            fix_plan = None

        # 4. FINALIZE ----------------------------------------------------------
        yield {"status": "FINALIZING", "message": "Finalizing build..."}
        try:
            suggestions = await self._generate_suggestions()
        except Exception:
            suggestions = []

        errors = len(self.memory.errors)
        steps = max(1, len(self.memory.history) or 1)
        confidence = max(0.0, 1.0 - (errors / steps))

        yield {
            "status": "DONE",
            "message": "System built successfully!",
            "stats": {
                "files_created": list(self.memory.files_created),
                "files_modified": list(self.memory.files_modified),
                "commands_run": list(self.memory.commands_run),
            },
            "suggestions": suggestions,
            "confidence": confidence,
        }

    def _map_event(self, event: Dict[str, Any], show_raw: bool) -> Optional[Dict[str, Any]]:
        """Convert executor events into CLI-facing status events."""
        kind = event.get("t")
        if kind == "text":
            if show_raw:
                return {"status": "STEP_PROGRESS", "chunk": event.get("s", "")}
            return None
        if kind == "tool_call":
            return {
                "status": "TOOL_CALL",
                "name": event.get("name"),
                "args": event.get("args", {}),
            }
        if kind == "obs":
            return {
                "status": "TOOL_RESULT",
                "name": event.get("name"),
                "success": event.get("success"),
                "preview": event.get("preview", ""),
            }
        if kind == "step_start":
            return {"status": "STEP_START", "step": event.get("step", {})}
        if kind == "finished":
            return {"status": "STEP_NOTE", "message": event.get("s", "")}
        return None

    async def _generate_suggestions(self) -> List[str]:
        prompt = (
            f"System built so far:\n{self.memory.get_context_summary()}\n\n"
            "Suggest the 3 highest-value follow-up improvements. "
            "Format each as one line starting with '1.', '2.', '3.'."
        )
        msgs = [
            Message(role="system", content=CHAT_SYSTEM),
            Message(role="user", content=prompt),
        ]
        response = ""
        async for chunk in self.provider.generate(msgs, GenerationConfig(stream=False)):
            response += chunk
        import re

        return [line.strip() for line in response.splitlines() if re.match(r"\s*[123][.)]", line)][:3]

    # ---------------------------------------------------------------- chat

    async def chat(self, user_input: str) -> AsyncIterator[str]:
        """Stateful chat: keeps history so follow-ups have context."""
        if not self.chat_history:
            self.chat_history.append(Message(role="system", content=CHAT_SYSTEM))

        self.chat_history.append(Message(role="user", content=user_input))
        response = ""
        async for chunk in failover_generate(
            self.chat_history, GenerationConfig(), self.provider, self.settings.config
        ):
            response += chunk
            yield chunk
        if response:
            self.chat_history.append(Message(role="assistant", content=response))

    def reset_chat(self) -> None:
        self.chat_history = []
