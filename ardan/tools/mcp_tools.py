"""Minimal MCP (Model Context Protocol) client over stdio JSON-RPC.

Servers are declared in config.yaml under mcp.servers. The executor merges
discovered tools into its registry so the agent can call them like native
tools. Disabled by default.
"""

import itertools
import json
import os
import subprocess
from typing import Any, Dict, List, Optional

from ardan.tools.file_tools import ToolResult

_SERVER_TIMEOUT = 10.0


class MCPServer:
    def __init__(self, name: str, command: str, args: Optional[List[str]] = None):
        self.name = name
        self.command = command
        self.args = args or []
        self.process: Optional[subprocess.Popen] = None
        self._ids = itertools.count(1)

    # ------------------------------------------------------------- process

    def start(self) -> None:
        if self.process:
            return
        try:
            self.process = subprocess.Popen(
                [self.command] + self.args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
        except OSError as error:
            raise RuntimeError(f"Failed to start MCP server '{self.name}': {error}") from error
        self._initialize()

    def _initialize(self) -> None:
        """MCP handshake: initialize request + initialized notification."""
        if not self.process:
            return
        request = {
            "jsonrpc": "2.0",
            "id": next(self._ids),
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "ardan", "version": "0.2.0"},
            },
        }
        response = self._roundtrip(request)
        if response is None:
            raise RuntimeError(f"MCP server '{self.name}' did not respond to initialize.")
        self._notify("notifications/initialized")

    def stop(self) -> None:
        if self.process:
            try:
                self.process.terminate()
            except OSError:
                pass
            self.process = None

    # ---------------------------------------------------------------- rpc

    def _send(self, payload: Dict[str, Any]) -> None:
        if not self.process or not self.process.stdin:
            raise RuntimeError(f"MCP server '{self.name}' not running.")
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()

    def _roundtrip(self, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            self._send(request)
            line = self.process.stdout.readline()
            if not line:
                return None
            return json.loads(line)
        except (OSError, json.JSONDecodeError):
            return None

    def _notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        try:
            self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})
        except (OSError, RuntimeError):
            pass

    # ---------------------------------------------------------------- items

    def list_tools(self) -> List[Dict[str, Any]]:
        response = self._roundtrip(
            {"jsonrpc": "2.0", "id": next(self._ids), "method": "tools/list", "params": {}}
        )
        if not response or "error" in response:
            return []
        return response.get("result", {}).get("tools", []) or []

    def call_tool(self, name: str, args: Dict[str, Any]) -> ToolResult:
        try:
            self.start()
        except RuntimeError as error:
            return ToolResult(False, "", str(error))
        response = self._roundtrip(
            {
                "jsonrpc": "2.0",
                "id": next(self._ids),
                "method": "tools/call",
                "params": {"name": name, "arguments": args},
            }
        )
        if not response:
            return ToolResult(False, "", f"MCP server '{self.name}' disconnected.")
        if "error" in response:
            return ToolResult(False, "", response["error"].get("message", "Unknown MCP error"))
        content = response.get("result", {}).get("content", []) or []
        output = "\n".join(
            c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"
        )
        return ToolResult(True, output, "")


class MCPManager:
    def __init__(self) -> None:
        self.servers: Dict[str, MCPServer] = {}
        self.tools: Dict[str, str] = {}  # tool_name -> server_name

    def load_from_config(self, config: Dict[str, Any]) -> None:
        for name, cfg in (config or {}).items():
            if not isinstance(cfg, dict) or "command" not in cfg:
                continue
            server = MCPServer(name, cfg["command"], cfg.get("args", []))
            self.servers[name] = server
            try:
                server.start()
                for tool in server.list_tools():
                    tool_name = tool.get("name")
                    if tool_name:
                        self.tools[str(tool_name)] = name
            except Exception:
                # Discovery failed: fall back to config-declared tool names.
                for declared in cfg.get("tools", []) or []:
                    self.tools[str(declared)] = name

    def make_caller(self, server_name: str, tool_name: str):
        """Return a sync tool function compatible with the Executor registry."""

        def _call(**args: Any) -> ToolResult:
            server = self.servers.get(server_name)
            if not server:
                return ToolResult(False, "", f"MCP server '{server_name}' not configured.")
            return server.call_tool(tool_name, args)

        _call.__name__ = tool_name
        _call.__doc__ = f"MCP tool from server '{server_name}'."
        return _call
