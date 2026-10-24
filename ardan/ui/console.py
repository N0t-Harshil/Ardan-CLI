import os

from rich.console import Console
from rich.panel import Panel
from rich.table import Table


class ArdanConsole:
    def __init__(self):
        self.console = Console()

    def print_banner(self):
        banner = """
 █████╗ ██████╗ ██████╗  █████╗ ███╗   ██╗
██╔══██╗██╔══██╗██╔══██╗██╔══██╗████╗  ██║
███████║██████╔╝██║  ██║███████║██╔██╗ ██║
██╔══██║██╔══██╗██║  ██║██╔══██║██║╚██╗██║
██║  ██║██║  ██║██████╔╝██║  ██║██║ ╚████║
╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝
    THE WORLD'S MOST POWERFUL CODING AGENT
        """
        self.console.print(Panel(banner, style="bold cyan"))

    def print_provider_badge(self, provider: str, model: str):
        colors = {
            "anthropic": "orange1",
            "google": "blue",
            "openai": "green",
            "mistral": "purple",
            "groq": "yellow",
            "openrouter": "cyan",
            "ollama": "white",
        }
        color = colors.get(provider.lower(), "white")
        local_badge = " [LOCAL]" if provider == "ollama" else ""
        self.console.print(
            f"[bold {color}]● {provider.upper()}[/bold {color}] ({model}){local_badge}"
        )
        self.console.print("Tips for getting started:")
        self.console.print("1. Ask questions, edit files, or run commands.")
        self.console.print(
            "2. Use [bold magenta]@path/to/file[/bold magenta] to include file content in context."
        )
        self.console.print(
            "3. Type [bold cyan]/help[/bold cyan] for more information.\n"
        )

    def show_spinner(self, message: str):
        return self.console.status(message)

    def display_plan(self, plan: list):
        table = Table(title="Execution Plan")
        table.add_column("ID", justify="right", style="cyan")
        table.add_column("Description", style="white")
        table.add_column("Tool Hint", style="magenta")
        table.add_column("Depends On", style="yellow")

        for step in plan:
            table.add_row(
                str(step.get("id")),
                step.get("description"),
                step.get("tool_hint"),
                ", ".join(map(str, step.get("depends_on", []))),
            )
        self.console.print(table)

    def print_step_start(self, step: dict):
        self.console.print(
            Panel(
                f"Step {step.get('id')}: {step.get('description')}",
                border_style="yellow",
            )
        )

    def print_step_complete(self, step: dict):
        self.console.print(f"[green]✔ Step {step.get('id')} complete[/green]")

    def print_progress(self, chunk: str):
        self.console.print(chunk, end="")

    def print_error(self, message: str):
        self.console.print(f"[red]ERROR: {message}[/red]")

    def print_success(self, message: str):
        self.console.print(f"[green]SUCCESS: {message}[/green]")

    def make_footer(
        self, workspace: str, model: str, steps: int = 0, provider: str = "ollama"
    ):
        provider_colors = {
            "anthropic": "orange1",
            "google": "blue",
            "openai": "green",
            "mistral": "purple",
            "groq": "yellow",
            "openrouter": "cyan",
            "ollama": "white",
        }
        color = provider_colors.get(provider.lower(), "white")
        badge = f"[{color}]●[/{color}] [bold]{provider.upper()}[/bold]"

        grid = Table.grid(expand=True)
        grid.add_column(justify="left", ratio=1)
        grid.add_column(justify="right", ratio=1)

        grid.add_row(
            f" {badge} | [bold cyan]Workspace:[/bold cyan] {workspace} | [bold yellow]Model:[/bold yellow] {model}",
            f"[bold magenta]Steps:[/bold magenta] {steps} | [bold red]Sandbox:[/bold red] no sandbox (see /docs)",
        )
        return Panel(grid, style="white on blue")

    def display_summary(self, update_data: dict):
        stats = update_data.get("stats", {})
        table = Table(title="Project Summary", border_style="bold green")
        table.add_column("Category", style="cyan")
        table.add_column("Count", style="white")
        table.add_column("Details", style="magenta")

        table.add_row(
            "Files Created",
            str(len(stats.get("files_created", []))),
            ", ".join(
                os.path.basename(p) if hasattr(p, "rfind") else str(p)
                for p in stats.get("files_created", [])
            )
            or "-",
        )
        table.add_row("Commands Run", str(len(stats.get("commands_run", []))), "")
        confidence = update_data.get("confidence", 0) or 0
        table.add_row("Confidence", f"{float(confidence) * 100:.0f}%", "")

        self.console.print(table)

        if update_data.get("suggestions"):
            self.console.print(
                Panel(
                    "\n".join([f"• {s}" for s in update_data["suggestions"]]),
                    title="Proactive Suggestions",
                    border_style="cyan",
                )
            )

    def display_models_table(self, provider: str, models: list):
        """Displays a formatted table of available models."""
        table = Table(
            title=f"Available Models for [bold]{provider.upper()}[/bold]",
            border_style="bright_blue",
        )
        table.add_column("Model ID", style="cyan")
        table.add_column("Name", style="white")
        table.add_column("Context", justify="right", style="magenta")
        table.add_column("Strength", style="italic yellow")

        for m in models:
            table.add_row(
                m.id,
                m.name,
                f"{m.context_window:,}" if m.context_window else "N/A",
                m.strength or "",
            )
        self.console.print(table)

    def print_next_steps(self, workspace: str):
        """Prints a friendly 'Next Steps' panel to guide the user."""
        next_steps = f"""
[bold green]Build complete![/bold green] What's next?

1. [bold cyan]Inspect:[/bold cyan] Check the generated files in [magenta]{workspace}[/magenta]
2. [bold cyan]Test:[/bold cyan] Run [white]ardan test[/white] to verify functionality
3. [bold cyan]Iterate:[/bold cyan] Use [white]ardan chat[/white] to refine the codebase
4. [bold cyan]Learn:[/bold cyan] Run [white]ardan explain <file>[/white] to understand any module
        """
        self.console.print(
            Panel(
                next_steps.strip(),
                title="🚀 [bold white]NEXT STEPS[/bold white]",
                border_style="bright_blue",
            )
        )

    # ------------------------------------------------------- step trace UI

    _TOOL_LABELS = {
        "write_file": "wrote",
        "read_file": "read",
        "append_file": "appended to",
        "delete_file": "deleted",
        "search_and_replace": "patched",
        "run_command": "ran",
        "run_script": "executed",
        "list_files": "listed",
        "search_in_files": "searched",
        "investigate_codebase": "analyzed",
        "scan_deps": "scanned deps of",
        "run_tests": "tested",
    }

    @staticmethod
    def summarize_args(name: str, args: dict) -> str:
        """Compact one-line summary of the interesting tool arguments."""
        interesting = {}
        for key in ("path", "directory", "command", "url", "query", "tag",
                    "output_path", "src_path", "name", "project_path"):
            value = args.get(key)
            if value:
                text = str(value)
                interesting[key] = text.split("\n")[0][:80]
        if not interesting:
            return ""
        return " ".join(f"{k}={v}" for k, v in interesting.items())

    def print_tool_call(self, step: int, name: str, args: dict):
        summary = self.summarize_args(name, args)
        line = f"  [bold cyan]◆[/bold cyan] {name}"
        if summary:
            line += f" [white]{summary}[/white]"
        self.console.print(line)

    def print_tool_result(self, name: str, success: bool, preview: str):
        if success:
            mark, style = "✔", "green"
            label = self._TOOL_LABELS.get(name, name)
            text = f"{label} - {preview}" if preview not in ("OK", "(no output)") else label
        else:
            mark, style = "✖", "red"
            text = f"failed: {preview}"
        self.console.print(f"    [{style}]{mark}[/] [dim]{text}[/dim]")

    def print_warning(self, message: str):
        self.console.print(Panel(str(message), title="⚠ Warning", border_style="yellow"))

    def print_note(self, message: str):
        self.console.print(f"[dim]ℹ {message}[/dim]")

    def print_stream(self, chunk: str):
        """Raw model text passthrough used when show_raw_llm_output is on."""
        self.console.print(chunk, end="")
