import os
import shlex
import subprocess
import shutil
import sys
import tempfile
from typing import Optional

from .file_tools import ToolResult

IS_WINDOWS = os.name == "nt"
_CHAIN_OPS = (";", "&&", "||", "|", ">", "<")


def _split(command: str):
    """Windows-aware command splitting (posix=False keeps C:\\ paths intact)."""
    return shlex.split(command, posix=not IS_WINDOWS)


def run_command(command: str, cwd: str = None, timeout: int = 60) -> ToolResult:
    """Execute a system command safely with shell=False.

    Chain operators (| ; && > etc.) are rejected with an actionable error so
    the agent splits work into separate calls instead of relying on shell
    piping (which is the classic injection surface).
    """
    try:
        if any(op in command for op in _CHAIN_OPS):
            return ToolResult(
                False,
                "",
                "Shell chaining (| ; && > <) is disabled. Split the work into "
                "separate run_command calls (e.g. one to build, one to redirect).",
            )

        try:
            safe_args = _split(command)
        except ValueError as error:
            return ToolResult(False, "", f"Could not parse command: {error}")
        if not safe_args:
            return ToolResult(False, "", "Empty command.")

        if IS_WINDOWS and safe_args[0] == "python3":
            safe_args[0] = "python"  # Windows never ships python3.exe

        process = subprocess.Popen(
            safe_args,
            shell=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=cwd,
        )
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            return ToolResult(False, "", f"Command timed out after {timeout}s.")
        if process.returncode == 0:
            return ToolResult(True, stdout or "(no output)")
        return ToolResult(
            False,
            stdout,
            stderr or f"Process exited with code {process.returncode}",
        )
    except FileNotFoundError:
        executable = safe_args[0] if safe_args else command
        return ToolResult(
            False,
            "",
            f"Executable '{executable}' not found on PATH. "
            "Install it or pick another tool.",
        )
    except Exception as e:
        return ToolResult(False, "", str(e))


def run_script(script_content: str, language: str = "bash") -> ToolResult:
    """Write a script to a temp file and run it."""
    try:
        suffix = ".sh" if language == "bash" else f".{language}"
        with tempfile.NamedTemporaryFile(
            mode="w", delete=False, suffix=suffix, encoding="utf-8"
        ) as tmp_file:
            tmp_file.write(script_content)
            tmp_file_path = tmp_file.name

        try:
            if language == "bash":
                if IS_WINDOWS and shutil.which("bash") is None:
                    return ToolResult(
                        False,
                        "",
                        "bash is not available on this Windows machine. "
                        "Use language='python' instead.",
                    )
                command = f"bash {shlex.quote(tmp_file_path)}"
            elif language == "python":
                command = f"{shlex.quote(sys.executable)} {shlex.quote(tmp_file_path)}"
            else:
                command = f"{shlex.quote(language)} {shlex.quote(tmp_file_path)}"

            return run_command(command)
        finally:
            if os.path.exists(tmp_file_path):
                os.remove(tmp_file_path)
    except Exception as e:
        return ToolResult(False, "", str(e))


def _require_compiler(executable: str) -> Optional[ToolResult]:
    if shutil.which(executable) is None:
        return ToolResult(
            False,
            "",
            f"'{executable}' not found on PATH. Install a C toolchain "
            "(gcc / g++ via MinGW on Windows, build-essential on Linux).",
        )
    return None


def compile_c(src_path: str, output_path: str = "a.out") -> ToolResult:
    """Compile C source code using gcc."""
    if not os.path.exists(src_path):
        return ToolResult(False, "", f"Source file {src_path} does not exist.")
    missing = _require_compiler("gcc")
    if missing:
        return missing
    return run_command(f"gcc -O3 {shlex.quote(src_path)} -o {shlex.quote(output_path)}", timeout=120)


def compile_cpp(src_path: str, output_path: str = "a.out") -> ToolResult:
    """Compile C++ source code using g++."""
    if not os.path.exists(src_path):
        return ToolResult(False, "", f"Source file {src_path} does not exist.")
    missing = _require_compiler("g++")
    if missing:
        return missing
    return run_command(f"g++ -O3 {shlex.quote(src_path)} -o {shlex.quote(output_path)}", timeout=120)


def run_binary(path: str, args: str = "") -> ToolResult:
    """Run a compiled binary (prefixes ./ when needed on unix)."""
    if not os.path.exists(path) and not path.startswith(("./", "/")):
        path = f"./{path}"
    if not os.path.exists(path):
        return ToolResult(False, "", f"Binary {path} does not exist.")
    return run_command(f"{shlex.quote(path)} {args}")
