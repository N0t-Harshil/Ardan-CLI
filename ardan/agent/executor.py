import asyncio
import inspect
import os
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

from ardan.agent.memory import Memory
from ardan.agent.messages import GenerationConfig, Message
from ardan.ollama.prompts import TOOL_FORMAT, build_tool_catalog
from ardan.providers.registry import failover_generate
from ardan.tools.code_tools import format_python, investigate_codebase, lint_python, search_in_files
from ardan.tools.deps_tools import install_missing, scan_imports
from ardan.tools.diagram_tools import generate_architecture_diagram
from ardan.tools.docker_tools import (
    docker_build,
    docker_run,
    generate_compose,
    generate_dockerfile,
)
from ardan.tools.file_tools import (
    ToolResult,
    append_file,
    delete_file,
    list_files,
    read_file,
    search_and_replace,
    write_file,
)
from ardan.tools.git_tools import (
    generate_commit_message,
    git_branch,
    git_commit,
    git_init,
    git_status,
)
from ardan.tools.mcp_tools import MCPManager
from ardan.tools.shell_tools import compile_c, compile_cpp, run_binary, run_command, run_script
from ardan.tools.test_tools import generate_tests, run_tests
from ardan.tools.web_tools import fetch_url, search_web
from ardan.utils.parse import (
    extract_finished_summary,
    extract_tool_calls,
    is_finished,
)

_DONE = object()  # sentinel for the parallel queue


class Executor:
    """ReAct execution engine: receives plan steps, drives the model through
    tool calls, and records everything into Memory.

    Yields structured events:
        {"t": "text", "s": chunk}                  - raw model text
        {"t": "tool_call", "name", "args"}         - about to run a tool
        {"t": "obs", "name", "success", "preview"} - compact tool result
        {"t": "finished", "s": summary}            - ReAct loop complete
    """

    def __init__(self, provider: Any, memory: Memory, settings: Optional[Dict[str, Any]] = None):
        self.provider = provider
        self.memory = memory
        self.settings = settings or {}
        agent_cfg = self.settings.get("agent", {}) or {}
        self.max_turns = int(agent_cfg.get("max_turns_per_step", 5))
        self.max_obs_chars = int(agent_cfg.get("max_observation_chars", 4000))

        self.tools: Dict[str, Callable] = {
            "read_file": read_file,
            "write_file": write_file,
            "append_file": append_file,
            "list_files": list_files,
            "delete_file": delete_file,
            "search_and_replace": search_and_replace,
            "run_command": run_command,
            "run_script": run_script,
            "lint_python": lint_python,
            "format_python": format_python,
            "search_in_files": search_in_files,
            "investigate_codebase": investigate_codebase,
            "git_init": git_init,
            "git_commit": git_commit,
            "git_branch": git_branch,
            "git_status": git_status,
            "generate_commit_message": generate_commit_message,
            "run_tests": run_tests,
            "generate_tests": generate_tests,
            "docker_build": docker_build,
            "docker_run": docker_run,
            "generate_dockerfile": generate_dockerfile,
            "generate_compose": generate_compose,
            "scan_deps": scan_imports,
            "auto_install_deps": install_missing,
            "generate_ascii_diagram": generate_architecture_diagram,
            "fetch_url": fetch_url,
            "search_web": search_web,
            "compile_c": compile_c,
            "compile_cpp": compile_cpp,
            "run_binary": run_binary,
        }
        self._attach_mcp_tools()

    # ----------------------------------------------------------------- mcp

    def _attach_mcp_tools(self) -> None:
        servers_cfg = (self.settings.get("mcp", {}) or {}).get("servers", {}) or {}
        if not servers_cfg:
            return
        try:
            self.mcp_manager = MCPManager()
            self.mcp_manager.load_from_config(servers_cfg)
            for tool_name, server_name in self.mcp_manager.tools.items():
                if tool_name in self.tools:
                    continue  # built-ins win
                self.tools[tool_name] = self.mcp_manager.make_caller(server_name, tool_name)
        except Exception:
            pass  # MCP is optional; never break the build over it

    # -------------------------------------------------------------- catalog

    def tool_catalog(self) -> str:
        """One line per tool: name(params) - docstring summary."""
        lines = []
        for name, func in sorted(self.tools.items()):
            try:
                sig = inspect.signature(func)
                params = list(
                    p.name
                    for p in sig.parameters.values()
                    if p.kind not in (p.VAR_POSITIONAL, p.VAR_KEYWORD)
                )
            except (TypeError, ValueError):
                params = []
            doc = (inspect.getdoc(func) or "").strip().splitlines()
            summary = doc[0] if doc else ""
            args_str = ", ".join(params)
            lines.append(f"- {name}({args_str}) - {summary}")
        return "\n".join(lines)

    def system_prompt(self) -> str:
        return f"{build_tool_catalog(self.tool_catalog())}\n{TOOL_FORMAT}"

    # ----------------------------------------------------------------- loop

    async def execute_step(self, step: Dict[str, Any]) -> AsyncIterator[Dict[str, Any]]:
        description = step.get("description", "")
        hint = step.get("tool_hint", "")
        messages: List[Message] = [
            Message(role="system", content=self.system_prompt()),
            Message(role="user", content=f"Task: {description}\nTool hint: {hint}\nWorkspace: {os.getcwd()}"),
        ]

        for turn in range(self.max_turns):
            response_full = ""
            async for chunk in failover_generate(
                messages, GenerationConfig(), self.provider, self.settings
            ):
                response_full += chunk
                yield {"t": "text", "s": chunk}

            self.memory.add_step("EXECUTOR_REASONING", response_full)
            messages.append(Message(role="assistant", content=response_full))

            if is_finished(response_full) and not extract_tool_calls(response_full):
                summary = extract_finished_summary(response_full)
                yield {"t": "finished", "s": summary or "Task complete."}
                return

            tool_calls = extract_tool_calls(response_full)
            if not tool_calls:
                messages.append(
                    Message(
                        role="user",
                        content=(
                            "No tool call detected. Either issue one tool call as "
                            '<tool>{"name": ..., "args": {...}}</tool>, or, if the task '
                            "is complete, reply ending with <finished>...</finished>."
                        ),
                    )
                )
                continue

            for name, args in tool_calls:
                yield {"t": "tool_call", "name": name, "args": args}
                result = await self._run_tool(name, args)
                self._record_side_effects(name, args, result)
                preview = self._preview(result)
                self.memory.add_step(
                    "TOOL_RESULT",
                    {"tool": name, "args": args, "output": result.output, "error": result.error},
                )
                if not result.success:
                    self.memory.record_error(f"{name}: {result.error}")
                yield {
                    "t": "obs",
                    "name": name,
                    "success": result.success,
                    "preview": preview,
                }

                if result.success:
                    obs = f"Observation:\n{result.output[: self.max_obs_chars]}"
                else:
                    obs = f"Observation:\n{result.output[:1000]}\nError: {result.error[:2000]}"
                messages.append(Message(role="user", content=obs))

        yield {
            "t": "finished",
            "s": "Step reached the turn limit without <finished> - continuing.",
        }

    # ---------------------------------------------------------------- tools

    async def _run_tool(self, name: str, args: Dict[str, Any]) -> ToolResult:
        func = self.tools.get(name)
        if func is None:
            return ToolResult(
                False,
                "",
                f"Unknown tool '{name}'. Call list_files first to orient yourself, "
                f"or use: {', '.join(sorted(self.tools))}",
            )
        try:
            return await asyncio.to_thread(self._call_sync, func, args)
        except Exception as error:
            return ToolResult(False, "", f"Tool execution failed: {error}")

    def _call_sync(self, func: Callable, args: Dict[str, Any]) -> ToolResult:
        """Wrap tool invocation with friendly TypeError reporting."""
        cleaned = dict(args)
        try:
            result = func(**cleaned)
        except TypeError as error:
            try:
                sig = inspect.signature(func)
                params = list(sig.parameters.keys())
            except (TypeError, ValueError):
                params = []
            return ToolResult(
                False, "", f"Bad arguments for {func.__name__}{tuple(params)}: {error}"
            )
        if isinstance(result, ToolResult):
            return result
        return ToolResult(True, str(result))

    def _preview(self, result: ToolResult) -> str:
        if result.success:
            text = (result.output or "").strip().replace("\n", " ")
            preview = text[:160] + ("..." if len(text) > 160 else "")
            return preview or "OK"
        text = (result.error or "").strip().replace("\n", " ")
        return (text[:160] + ("..." if len(text) > 160 else "")) or "failed"

    def _record_side_effects(self, name: str, args: Dict[str, Any], result: ToolResult) -> None:
        if not result.success:
            return
        path = args.get("path") or args.get("directory")
        if name == "write_file" and path:
            self.memory.record_file_created(path)
        elif name in ("append_file", "search_and_replace") and path:
            self.memory.record_modification(path)
        if name in ("run_command", "run_script", "run_tests", "docker_build", "docker_run"):
            self.memory.record_command(args.get("command") or name)

    # ------------------------------------------------------------- parallel

    async def run_parallel(
        self, steps: List[Dict[str, Any]], max_concurrency: int = 3
    ) -> AsyncIterator[Dict[str, Any]]:
        """Run independent steps concurrently, streaming interleaved events."""
        queue: asyncio.Queue = asyncio.Queue()
        semaphore = asyncio.Semaphore(max(1, max_concurrency))

        async def worker(step: Dict[str, Any]) -> None:
            async with semaphore:
                await queue.put({"t": "step_start", "step": step})
                try:
                    async for event in self.execute_step(step):
                        await queue.put(event)
                except Exception as error:
                    await queue.put(
                        {
                            "t": "obs",
                            "name": "step_execution",
                            "success": False,
                            "preview": f"Step {step.get('id')} failed: {error}",
                        }
                    )

        workers = [asyncio.create_task(worker(step)) for step in steps]

        async def monitor() -> None:
            await asyncio.gather(*workers, return_exceptions=True)
            await queue.put(_DONE)

        monitor_task = asyncio.create_task(monitor())
        try:
            while True:
                event = await queue.get()
                if event is _DONE:
                    break
                yield event
        finally:
            monitor_task.cancel()

    # -------------------------------------------------------------- python

    def installed_tool_names(self) -> List[str]:
        return sorted(self.tools)
