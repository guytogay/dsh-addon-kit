#!/usr/bin/env python3
"""Smoke test: MCP stdio handshake + tools/list + a real screenshot for the desktop server."""
import json
import subprocess
import sys

PY = r"%USERPROFILE%\.dsh\mcp\desktop\.venv\Scripts\python.exe"
SRV = r"%USERPROFILE%\.dsh\mcp\desktop\desktop_server.py"

proc = subprocess.Popen(
    [PY, SRV],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    bufsize=1, text=True, encoding="utf-8",
)


def rpc(req):
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError(f"server closed (stderr: {proc.stderr.read()})")
    return json.loads(line)


resp = rpc({
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "dsh-smoke", "version": "0.0.1"},
    },
})
print("INITIALIZE:", resp.get("result", {}).get("serverInfo"), resp.get("result", {}).get("protocolVersion"))

proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
proc.stdin.flush()

resp = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
tools = [t["name"] for t in resp.get("result", {}).get("tools", [])]
print("TOOLS:", len(tools))
for t in tools:
    print("  -", t)

resp = rpc({
    "jsonrpc": "2.0", "id": 3, "method": "tools/call",
    "params": {"name": "desktop_screenshot", "arguments": {"save_path": r"%USERPROFILE%\.dsh\mcp\desktop\screenshots\smoke-test.png"}},
})
result = resp.get("result", {})
content = result.get("content", [])
print("SCREENSHOT isError:", result.get("isError", False))
for c in content:
    if c.get("type") == "text":
        print("  text:", c["text"])
    elif c.get("type") == "image":
        print(f"  image bytes(base64 len): {len(c['data'])}")

resp = rpc({
    "jsonrpc": "2.0", "id": 4, "method": "tools/call",
    "params": {"name": "desktop_list_windows", "arguments": {}},
})
print("WINDOWS head:")
for line in resp.get("result", {}).get("content", [{}])[0].get("text", "").splitlines()[:6]:
    print("  ", line)

proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 5, "method": "shutdown"}) + "\n")
proc.stdin.flush()
proc.terminate()
print("SMOKE OK")
