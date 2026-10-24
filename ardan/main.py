import asyncio
import os
import sys
from typing import Dict, Optional

import typer
import yaml
from rich.live import Live
from rich.markdown import Markdown
from rich.prompt import Confirm

from ardan import __version__
from ardan.agent.core import AgentCore
from ardan.config.credentials import credentials_manager
from ardan.config.settings import Settings
from ardan.providers.registry import (
    PROVIDERS,
    get_provider_instance,
    resolve_provider_name,
)
from ardan.ui.console import ArdanConsole
from ardan.utils.paths import expand_file_mentions

app = typer.Typer(
    name="ardan",
    help="Ardan - a multi-provider autonomous coding agent CLI.",
    no_args_is_help=True,
    add_completion=False,
)
console_ui = ArdanConsole()
settings = Settings()

# Legacy Windows consoles run a cp1252 codepage; the fancy box/shell glyphs
# rich prints would crash the legacy renderer. Force UTF-8 with replacement.
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass

SLASH_HELP = """\
/help              Show this list.
/plan [task]       Draft a plan in chat without executing it.
/stats             Session stats (files, commands, history).
/save              Flush the current session to disk.
/load <id>         Load a saved session id into this REPL.
/rewind            Undo the file changes recorded in this session.
/diff              Overview of session file changes.
/model <name>      Switch model on the active provider.
/reset             Clear chat history.
/exit | /quit      Leave the REPL (Ctrl+D also works).
Anything else goes to the model. Type @path/to/file to attach a file.
"""


def _version_callback(value: bool):
    if value:
        typer.echo(f"ardan {__version__}")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(
        False, "--version", "-v", callback=_version_callback, help="Show version and exit."
    ),
):
    """Ardan - a multi-provider autonomous coding agent."""


# --------------------------------------------------------------- rendering


def _render_update(update: Dict) -> None:
    """Render a build_system status event."""
    status = update.get("status")
    if status == "PLANNING":
        console_ui.console.print(f"[bold yellow]⣾ {update.get('message')}[/bold yellow]")
    elif status == "WARNING":
        console_ui.print_warning(update["message"])
    elif status == "EXECUTING_PARALLEL":
        console_ui.console.print(
            f"[bold magenta]◆[/bold magenta] Running [white]"
            f"{len(update['steps'])}[/white] independent steps in parallel"
        )
    elif status == "STEP_START":
        console_ui.print_step_start(update["step"])
    elif status == "STEP_NOTE":
        console_ui.print_note(update["message"])
    elif status == "TOOL_CALL":
        console_ui.print_tool_call(0, update["name"], update.get("args", {}))
    elif status == "TOOL_RESULT":
        console_ui.print_tool_result(
            update["name"], update.get("success", False), update.get("preview", "")
        )
    elif status == "STEP_PROGRESS":
        console_ui.print_stream(update["chunk"])
    elif status == "REVIEWING":
        console_ui.console.print(f"[bold blue]{update.get('message')}[/bold blue]")
    elif status == "FIXING":
        console_ui.console.print(f"[bold blue]{update.get('message')}[/bold blue]")
    elif status == "FINALIZING":
        console_ui.console.print(f"[bold blue]{update.get('message')}[/bold blue]")
    elif status == "DONE":
        console_ui.display_summary(update)
        console_ui.print_next_steps(str(os.getcwd()))


# ------------------------------------------------------------------ run


@app.command()
def run(
    prompt: str = typer.Argument(..., help="What do you want to build?"),
    provider: Optional[str] = typer.Option(None, "--provider", "-p"),
    model: Optional[str] = typer.Option(None, "--model", "-m"),
    workspace: Optional[str] = typer.Option(None, "--workspace", "-w"),
    auto: bool = typer.Option(False, "--auto", help="Skip the plan confirmation prompt."),
    watch: bool = typer.Option(False, "--watch", help="Re-build when workspace files change."),
):
    """Plan and build a software system from a single prompt."""
    agent = AgentCore(
        settings,
        provider_override=provider,
        model_override=model,
        workspace_override=workspace,
    )

    prompt_expanded, attached = expand_file_mentions(prompt)
    if attached:
        console_ui.console.print(
            f"[dim]Attached {len(attached)} file(s): {', '.join(attached)}[/dim]"
        )

    should_confirm = not (auto or watch) and not settings.agent_auto_confirm

    # Work inside the workspace so relative file tools land where expected.
    caller_dir = os.getcwd()
    os.chdir(agent.workspace)
    try:
        if watch:
            asyncio.run(_build_with_watch(agent, prompt_expanded))
        else:
            asyncio.run(_consume_events(agent, agent.build_system(prompt_expanded), should_confirm))
    except KeyboardInterrupt:
        console_ui.print_warning("Interrupted. Session saved - try `ardan undo` to revert files.")
    finally:
        os.chdir(caller_dir)


async def _consume_events(agent: AgentCore, updates, should_confirm: bool) -> bool:
    async for update in updates:
        if update.get("status") == "PLAN_READY":
            console_ui.display_plan(update["plan"])
            if should_confirm and not Confirm.ask("Proceed with this plan?", default=True):
                console_ui.print_warning("Plan rejected - nothing was built. Session saved.")
                break
            continue
        _render_update(update)
    return True


async def _build_with_watch(agent: AgentCore, prompt_text: str) -> None:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer

    loop = asyncio.get_running_loop()
    state: Dict = {"running": False, "dirty": False}

    async def run_once(source: str) -> None:
        state["running"] = True
        try:
            console_ui.print_note(f"Build triggered ({source})...")
            await _consume_events(agent, agent.build_system(prompt_text), should_confirm=False)
        finally:
            state["running"] = False
            if state.pop("dirty", False):
                asyncio.create_task(_bounded_rebuild())

    async def _bounded_rebuild() -> None:
        await asyncio.sleep(1.0)
        if not state["running"]:
            await run_once("fs")

    class Handler(FileSystemEventHandler):
        def on_modified(self, event) -> None:
            if event.is_directory:
                return
            if state["running"]:
                state["dirty"] = True
                return
            # We're on the watchdog thread here - schedule back onto the loop.
            asyncio.run_coroutine_threadsafe(_bounded_rebuild(), loop)

    console_ui.print_note(f"Watching {agent.workspace} - Ctrl+C to stop.")
    observer = Observer()
    observer.schedule(Handler(), agent.workspace, recursive=True)
    observer.start()
    try:
        await run_once("init")
        while True:
            await asyncio.sleep(3600)
    finally:
        observer.stop()
        observer.join()


# ----------------------------------------------------------------- chat


SLASH_COMMANDS = (
    "/help", "/plan", "/stats", "/save", "/load", "/rewind",
    "/diff", "/model", "/provider", "/reset", "/exit", "/quit",
)


def _load_session_agent(session_id: int) -> AgentCore:
    return AgentCore(settings, session_id=int(session_id))


def _dispatch_slash(command: str, agent: AgentCore) -> Dict:
    """Handle slash commands. Returns {'exit': bool, 'agent': AgentCore}."""
    parts = command.strip().split(maxsplit=1)
    slug = parts[0].lower()
    argument = parts[1].strip() if len(parts) > 1 else ""
    result: Dict = {"exit": False, "agent": None}

    if slug == "/help":
        console_ui.console.print(SLASH_HELP)
    elif slug == "/plan":
        if not argument:
            console_ui.print_error("Usage: /plan build a FizzBuzz CLI")
        else:
            from ardan.agent.planner import Planner, PlannerError

            planner = Planner(agent.provider)

            async def _plan():
                return await planner.create_plan(argument)

            try:
                plan = asyncio.new_event_loop().run_until_complete(_plan())
                console_ui.display_plan(plan)
                console_ui.print_note("This was a preview - run `ardan run \"...\"` to execute it.")
            except (PlannerError, Exception) as error:  # noqa: BLE001
                console_ui.print_error(f"Plan failed: {error}")
    elif slug == "/stats":
        m = agent.memory
        console_ui.console.print(
            f"[bold]Session {m.session_id}[/bold]\n"
            f"Files created: [cyan]{len(m.files_created)}[/cyan]   "
            f"Files modified: [cyan]{len(m.files_modified)}[/cyan]   "
            f"Commands run: [cyan]{len(m.commands_run)}[/cyan]   "
            f"Errors: [cyan]{len(m.errors)}[/cyan]   "
            f"History: [cyan]{len(m.history)}[/cyan] entries"
        )
    elif slug == "/save":
        agent.memory._save()
        console_ui.print_success(f"Session {agent.memory.session_id} saved.")
    elif slug == "/load":
        if not argument.isdigit():
            console_ui.print_error("Usage: /load 1712345678")
        else:
            try:
                result["agent"] = _load_session_agent(int(argument))
                console_ui.print_success(
                    f"Loaded session {argument} "
                    f"({len(result['agent'].memory.history)} history entries)."
                )
            except Exception as error:  # noqa: BLE001
                console_ui.print_error(f"Could not load session: {error}")
    elif slug == "/rewind":
        count = agent.memory.undo_last_run()
        console_ui.print_success(f"Rewound {count} file changes.")
    elif slug == "/diff":
        console_ui.console.print(agent.memory.get_diff())
    elif slug == "/model":
        if not argument:
            console_ui.print_error("Usage: /model claude-sonnet-4-5")
        else:
            agent.provider.default_model = argument
            agent.model = argument
            console_ui.print_success(f"Model set to {argument}.")
    elif slug == "/provider":
        resolved = argument.lower()
        if resolved not in PROVIDERS:
            console_ui.print_error(
                f"Restart ardan with --provider <name> to switch. "
                f"Available: {', '.join(sorted(PROVIDERS))}"
            )
        else:
            console_ui.print_note(f"Current provider: {agent.provider_name}. Restart with --provider {resolved} to switch.")
    elif slug == "/reset":
        agent.reset_chat()
        console_ui.print_success("Chat history cleared.")
    elif slug in ("/exit", "/quit"):
        result["exit"] = True
    else:
        console_ui.print_error(f"Unknown command {slug}. Type /help.")
    return result


class ArdanCompleter:
    """Slash-command + @file completion for the REPL."""

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        stripped = text.strip()
        if stripped.startswith("/"):
            token = stripped.split(" ")[0]
            for command in SLASH_COMMANDS:
                if command.startswith(token):
                    yield_text = command
                    from prompt_toolkit.completion import Completion

                    yield Completion(yield_text, start_position=-len(token))
            return
        at_index = text.rfind("@")
        if at_index != -1:
            from prompt_toolkit.completion import Completion

            fragment = text[at_index + 1 :]
            if " " in fragment:
                return
            dir_part = os.path.dirname(fragment) or "."
            base = os.path.basename(fragment)
            try:
                entries = os.listdir(dir_part)
            except OSError:
                return
            for entry in sorted(entries):
                if entry.startswith(base):
                    candidate = os.path.join(dir_part, entry)
                    if os.path.isdir(candidate):
                        candidate += os.sep
                    yield Completion(candidate, start_position=-len(fragment))


def _repl(agent: AgentCore) -> None:
    from prompt_toolkit import PromptSession
    from prompt_toolkit.history import FileHistory

    session = PromptSession(
        history=FileHistory(os.path.join(agent.memory.session_dir, "repl_history.txt")),
        enable_history_search=True,
        completer=ArdanCompleter(),
        complete_while_typing=True,
    )

    console_ui.console.print("[dim]Type /help for commands, @file to attach files, Ctrl+D to exit.[/dim]")
    while True:
        try:
            line = session.prompt("ardan> ")
        except (KeyboardInterrupt, EOFError):
            console_ui.console.print()
            break
        line = line.strip()
        if not line:
            continue
        if line.startswith(("/", "@")) and line.startswith("/"):
            outcome = _dispatch_slash(line, agent)
            if outcome.get("agent"):
                agent = outcome["agent"]
                console_ui.print_provider_badge(agent.provider_name, agent.model)
            if outcome.get("exit"):
                break
            continue

        try:
            expanded, attached = expand_file_mentions(line)
            if attached:
                console_ui.console.print(f"[dim]Attached {len(attached)} file(s).[/dim]")
            _stream_chat(agent, expanded)
        except Exception as error:  # noqa: BLE001
            console_ui.print_error(str(error))


def _stream_chat(agent: AgentCore, text: str) -> None:
    """Stream a reply as live-updating markdown."""
    buffer = ""
    try:
        with Live("", console=console_ui.console, refresh_per_second=8) as live:
            async def _go():
                nonlocal buffer
                async for chunk in agent.chat(text):
                    buffer += chunk
                    live.update(Markdown(buffer))

            asyncio.run(_go())
    except KeyboardInterrupt:
        console_ui.console.print("\n[dim]Interrupted.[/dim]")
    console_ui.console.print()


@app.command()
def chat(provider: Optional[str] = typer.Option(None, "--provider", "-p")):
    """Interactive REPL: slash commands, @file mentions, streaming replies."""
    agent = AgentCore(settings, provider_override=provider)
    console_ui.print_banner()
    console_ui.print_provider_badge(agent.provider_name, agent.model)
    _repl(agent)


# ------------------------------------------------------------ model keys


@app.command()
def models(
    provider: Optional[str] = typer.Option(None, "--provider", "-p", help="Provider name."),
):
    """List available AI models."""
    async def _models():
        if provider:
            names = [resolve_provider_name(provider)]
        else:
            names = sorted(PROVIDERS)

        for name in names:
            if name not in PROVIDERS:
                console_ui.print_error(f"Unknown provider: {name}")
                continue
            try:
                instance = get_provider_instance(name, settings.config)
            except ValueError as error:
                console_ui.print_error(str(error))
                continue
            try:
                model_list = await instance.list_models()
            except Exception as error:  # noqa: BLE001
                console_ui.print_error(f"{name}: {error}")
                continue
            if model_list:
                console_ui.display_models_table(name, model_list)
            else:
                console_ui.print_warning(
                    f"No models reachable for {name} - check `ardan keys test {name}`."
                )

    asyncio.run(_models())


@app.command()
def keys(
    action: str = typer.Argument(..., help="Action: set, list, remove, test"),
    provider: Optional[str] = typer.Argument(None, help="The AI provider"),
    value: Optional[str] = typer.Option(None, "--value", help="Directly provide the key value"),
):
    """Manage AI provider API keys (encrypted at rest)."""
    action = action.lower()
    if action == "set":
        if not provider or provider.lower() not in PROVIDERS:
            console_ui.print_error(
                f"'set' requires one of: {', '.join(sorted(PROVIDERS))}"
            )
            raise typer.Exit(1)
        key_value = value or typer.prompt(f"Enter key for {provider}", hide_input=True)
        credentials_manager.set(provider, key_value)
        console_ui.print_success(f"Key for {provider} stored (AES-encrypted).")
    elif action == "list":
        console_ui.console.print("Stored API keys (masked):")
        for provider_name, masked in credentials_manager.list_masked().items():
            console_ui.console.print(f"- {provider_name}: {masked}")
    elif action == "remove":
        if not provider:
            console_ui.print_error("'remove' requires a provider.")
            raise typer.Exit(1)
        credentials_manager.remove(provider)
        console_ui.print_success(f"Key for {provider} removed.")
    elif action == "test":
        if not provider or provider.lower() not in PROVIDERS:
            console_ui.print_error(
                f"'test' requires one of: {', '.join(sorted(PROVIDERS))}"
            )
            raise typer.Exit(1)

        async def _test():
            try:
                instance = get_provider_instance(provider.lower(), settings.config)
            except ValueError as error:
                console_ui.print_error(str(error))
                return
            health = await instance.health_check()
            if health.status == "healthy":
                console_ui.print_success(f"{provider}: {health.message}")
            else:
                console_ui.print_error(f"{provider}: {health.message}")

        asyncio.run(_test())
    else:
        console_ui.print_error("Unknown action. Use set, list, remove or test.")
        raise typer.Exit(1)


# ------------------------------------------------------- housekeeping


@app.command()
def recommend(task: str = typer.Argument(..., help="Describe the task.")):
    """Ask Ardan which provider/model fits the task."""
    agent = AgentCore(settings)
    prompt = (
        f"Which provider/model suits this task best? Task: '{task}'. Options: "
        "anthropic, openai, google, mistral, groq, openrouter, ollama (local). "
        "Answer as a compact markdown table (Provider | Model | Why)."
    )
    _stream_chat(agent, prompt)


@app.command()
def diff():
    """Show a change overview of the latest session."""
    agent = AgentCore(settings)
    console_ui.console.print(agent.memory.get_diff())


@app.command()
def undo():
    """Undo the file changes recorded in the latest session."""
    agent = AgentCore(settings)
    count = agent.memory.undo_last_run()
    console_ui.print_success(f"Reverted {count} file changes.")


@app.command()
def resume(
    session: Optional[int] = typer.Argument(None, help="Session id (defaults to latest)."),
):
    """Resume a saved session and drop into the REPL."""
    if session is None:
        sessions = AgentCore(settings).memory.list_sessions()
        if not sessions:
            console_ui.print_error("No sessions found. Run `ardan run \"...\"` first.")
            raise typer.Exit(1)
        session = sessions[-1]
    agent = AgentCore(settings, session_id=session)
    console_ui.print_success(f"Resuming session {agent.memory.session_id}")
    console_ui.print_provider_badge(agent.provider_name, agent.model)
    _repl(agent)


@app.command()
def explain(file: str = typer.Argument(..., help="Path to a source file.")):
    """Explain a file's contents with the active model."""
    if not os.path.isfile(file):
        console_ui.print_error(f"File not found: {file}")
        raise typer.Exit(1)
    agent = AgentCore(settings)
    expanded, attached = expand_file_mentions(f"Explain this file in detail: @{file}")
    if not attached:
        console_ui.print_error("Could not attach the file.")
        raise typer.Exit(1)
    _stream_chat(agent, expanded)


@app.command()
def improve(
    file: str = typer.Argument(..., help="Path to a source file."),
    provider: Optional[str] = typer.Option(None, "--provider", "-p"),
):
    """Plan + execute an improvement for one file in its own directory."""
    if not os.path.isfile(file):
        console_ui.print_error(f"File not found: {file}")
        raise typer.Exit(1)
    agent = AgentCore(settings, provider_override=provider)
    expanded, _ = expand_file_mentions(
        f"Improve this file (refactor, fix bugs, better naming): @{file}"
    )

    caller_dir = os.getcwd()
    target_dir = os.path.dirname(os.path.abspath(file))
    os.chdir(target_dir)
    try:
        asyncio.run(_consume_events(agent, agent.build_system(expanded), should_confirm=True))
    finally:
        os.chdir(caller_dir)


@app.command()
def test(
    directory: str = typer.Argument(".", help="Directory holding the project."),
    provider: Optional[str] = typer.Option(None, "--provider", "-p"),
):
    """Run tests in a directory and auto-fix failures."""
    if not os.path.isdir(directory):
        console_ui.print_error(f"Directory not found: {directory}")
        raise typer.Exit(1)
    agent = AgentCore(settings, provider_override=provider)

    caller_dir = os.getcwd()
    os.chdir(os.path.abspath(directory))
    try:
        asyncio.run(
            _consume_events(
                agent,
                agent.build_system(
                    "Run the project tests, find every failure, fix it in the source, "
                    "and re-run until green."
                ),
                should_confirm=False,
            )
        )
    finally:
        os.chdir(caller_dir)


@app.command()
def config():
    """Show the current configuration."""
    console_ui.console.print(yaml.safe_dump(settings.config, sort_keys=False))


@app.command()
def providers():
    """List supported providers and key status."""
    for name in sorted(PROVIDERS):
        has_key = bool(credentials_manager.get(name))
        local = " [dim](local)[/dim]" if name == "ollama" else ""
        if has_key or name == "ollama":
            marker = "[green]● ready[/green]"
        else:
            marker = "[red]○ no key[/red]"
        console_ui.console.print(f"- {name}{local}: {marker}")


if __name__ == "__main__":
    app()
