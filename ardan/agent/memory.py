import json
import os
import time
from typing import Any, Dict, List, Optional

from ardan.agent.messages import Message, GenerationConfig


class Memory:
    """Session persistence for a build/chat session.

    Every recorded path is stored absolute so undo/diff work regardless of
    where the CLI is later invoked from.
    """

    def __init__(self, workspace: str, session_id: Optional[int] = None):
        self.workspace = os.path.abspath(workspace)
        self.session_dir = os.path.join(self.workspace, ".ardan")
        self.history: List[Dict[str, Any]] = []
        self.files_created: List[str] = []
        self.files_modified: List[str] = []
        self.commands_run: List[str] = []
        self.errors: List[str] = []
        self.backups: Dict[str, str] = {}
        self._loaded_session: bool = False

        if session_id:
            self.session_id = int(session_id)
            self.session_file = os.path.join(self.session_dir, f"session_{self.session_id}.json")
        else:
            sessions = self.list_sessions()
            if sessions:
                self.session_id = sessions[-1]
                self.session_file = os.path.join(
                    self.session_dir, f"session_{self.session_id}.json"
                )
            else:
                self.session_id = int(time.time())
                self.session_file = os.path.join(
                    self.session_dir, f"session_{self.session_id}.json"
                )

        self._load()

    # ------------------------------------------------------------- sessions

    def list_sessions(self) -> List[int]:
        """Return stored session ids sorted ascending."""
        if not os.path.isdir(self.session_dir):
            return []
        ids: List[int] = []
        for name in os.listdir(self.session_dir):
            if name.startswith("session_") and name.endswith(".json"):
                try:
                    ids.append(int(name[len("session_") : -len(".json")]))
                except ValueError:
                    continue
        return sorted(ids)

    def _load(self) -> None:
        try:
            with open(self.session_file, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            self.history = data.get("history", [])
            self.files_created = data.get("files_created", [])
            self.files_modified = data.get("files_modified", [])
            self.commands_run = data.get("commands_run", [])
            self.errors = data.get("errors", [])
            self.backups = data.get("backups", {})
            self._loaded_session = bool(self.history)
        except (OSError, json.JSONDecodeError):
            pass

    def _save(self) -> None:
        try:
            os.makedirs(self.session_dir, exist_ok=True)
            data = {
                "history": self.history[-500:],
                "files_created": self.files_created,
                "files_modified": self.files_modified,
                "commands_run": self.commands_run,
                "errors": self.errors,
                "backups": self.backups,
            }
            with open(self.session_file, "w", encoding="utf-8") as handle:
                json.dump(data, handle, indent=2)
        except OSError:
            pass

    # -------------------------------------------------------------- records

    def add_step(self, type: str, content: Any) -> None:
        self.history.append({"timestamp": time.time(), "type": type, "content": content})
        self._save()

    def record_file_created(self, path: str) -> None:
        path = os.path.abspath(path)
        if path not in self.files_created:
            self.files_created.append(path)
            self._save()

    def record_modification(self, path: str) -> None:
        """Back up file content before modification (for /rewind + undo)."""
        path = os.path.abspath(path)
        if path not in self.backups and os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    self.backups[path] = handle.read()
            except OSError:
                pass
        if path not in self.files_modified and path not in self.files_created:
            self.files_modified.append(path)
            self._save()

    def record_command(self, command: str) -> None:
        self.commands_run.append(command)
        self._save()

    def record_error(self, error: str) -> None:
        self.errors.append(str(error)[:500])
        self._save()

    # ---------------------------------------------------------------- undo

    def undo_last_run(self) -> int:
        """Revert creations and modifications tracked in this session."""
        count = 0
        for path, content in list(self.backups.items()):
            if not os.path.isfile(path):
                continue
            try:
                with open(path, "w", encoding="utf-8") as handle:
                    handle.write(content)
                count += 1
            except OSError:
                pass

        for path in list(self.files_created):
            if os.path.isfile(path):
                try:
                    os.remove(path)
                    count += 1
                except OSError:
                    pass

        self.files_created = []
        self.files_modified = []
        self.backups = {}
        self._save()
        return count

    # -------------------------------------------------------------- context

    def get_full_context(self) -> str:
        return "".join(f"[{h['type']}] {str(h['content'])}\n" for h in self.history)

    def get_recent_context(self, limit: int = 40) -> str:
        trimmed = [
            f"[{h['type']}] {str(h['content'])[:300]}\n" for h in self.history[-limit:]
        ]
        return "".join(trimmed)

    def get_context_summary(self) -> str:
        return "".join(
            f"[{h['type']}] {str(h['content'])[:200]}\n" for h in self.history[-10:]
        )

    def get_diff(self) -> str:
        diff = "Changes in this session:\n"
        diff += f"Files Created ({len(self.files_created)}): "
        diff += ", ".join(
            os.path.relpath(p, self.workspace) if p.startswith(self.workspace) else p
            for p in self.files_created
        )
        diff += "\n"
        diff += f"Files Modified ({len(self.files_modified)}): "
        diff += ", ".join(
            os.path.relpath(p, self.workspace) if p.startswith(self.workspace) else p
            for p in self.files_modified
        )
        diff += "\n"
        return diff

    # ------------------------------------------------------------- summarize

    async def summarize(self, provider: Any) -> None:
        """Condense history via the provider when it grows too large."""
        if len(self.history) < 20:
            return
        try:
            msgs = [
                Message(
                    role="system",
                    content="Summarize this agent session history into a concise technical summary. Reply with the summary only.",
                ),
                Message(role="user", content=self.get_full_context()),
            ]
            summary = ""
            async for chunk in provider.generate(msgs, GenerationConfig(stream=False)):
                summary += chunk
            if summary.strip():
                self.history = [
                    {"timestamp": time.time(), "type": "SUMMARY", "content": summary.strip()}
                ]
                self._save()
        except Exception:
            pass
