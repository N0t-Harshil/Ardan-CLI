import os
import shutil
import subprocess

from .file_tools import ToolResult

_SKIP_DIRS = {
    ".git",
    "__pycache__",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    ".ardan",
}


def _walk_pruned(directory: str):
    """os.walk that prunes heavy/non-source dirs in place (fast + quiet)."""
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".")]
        yield root, files


def lint_python(path: str) -> ToolResult:
    """Lint a Python file with ruff (installed) or py_compile fallback."""
    try:
        if shutil.which("ruff"):
            result = subprocess.run(
                ["ruff", "check", path], capture_output=True, text=True, timeout=60
            )
            if result.returncode == 0:
                return ToolResult(True, "No lint errors found by ruff.")
            return ToolResult(False, result.stdout, result.stderr)
    except (subprocess.SubprocessError, OSError):
        pass

    # Fallback: syntax check only.
    try:
        import py_compile

        py_compile.compile(path, doraise=True)
        return ToolResult(True, "No syntax errors found by py_compile.")
    except py_compile.PyCompileError as error:
        return ToolResult(False, "", str(error))
    except Exception as e:
        return ToolResult(False, "", str(e))


def format_python(path: str) -> ToolResult:
    """Format a Python file with black."""
    if shutil.which("black") is None:
        return ToolResult(
            False,
            "",
            "black is not installed (this is not fixable by editing files). "
            "Skip formatting; use lint_python to verify syntax instead. "
            "A human can install it later with: pip install black",
        )
    try:
        result = subprocess.run(
            ["black", path], capture_output=True, text=True, timeout=60
        )
        if result.returncode == 0:
            return ToolResult(True, "File formatted successfully by black.")
        return ToolResult(False, result.stdout, result.stderr)
    except Exception as e:
        return ToolResult(False, "", str(e))


def search_in_files(directory: str, query: str) -> ToolResult:
    """Grep-like literal search across source files."""
    try:
        results = []
        for root, files in _walk_pruned(directory):
            for file in files:
                file_path = os.path.join(root, file)
                try:
                    if os.path.getsize(file_path) > 512 * 1024:
                        continue
                    with open(file_path, "r", encoding="utf-8", errors="replace") as handle:
                        for i, line in enumerate(handle, 1):
                            if query in line:
                                results.append(f"{file_path}:{i}: {line.strip()[:200]}")
                except OSError:
                    continue
        if results:
            return ToolResult(True, "\n".join(results[:100]))
        return ToolResult(True, f"No matches for '{query}' found.")
    except Exception as e:
        return ToolResult(False, "", str(e))


def investigate_codebase(directory: str) -> ToolResult:
    """Tree-style layout + summaries of key project files."""
    try:
        structure = []
        for root, files in _walk_pruned(directory):
            level = os.path.relpath(root, directory).count(os.sep)
            if os.path.relpath(root, directory) == ".":
                level = 0
            indent = "  " * level
            structure.append(f"{indent}{os.path.basename(root) if level else directory}/")
            for f in files[:12]:
                structure.append(f"{indent}  {f}")
        if len(structure) > 120:
            structure = structure[:120] + ["  ... (truncated)"]

        summaries = []
        for f_name in ("README.md", "pyproject.toml", "requirements.txt", "package.json"):
            path = os.path.join(directory, f_name)
            if os.path.isfile(path):
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    summaries.append(f"--- {f_name} ---\n{handle.read()[:500]}")

        output = "Codebase structure:\n" + "\n".join(structure)
        if summaries:
            output += "\n\nKey file contents:\n" + "\n".join(summaries)
        return ToolResult(True, output)
    except Exception as e:
        return ToolResult(False, "", str(e))
