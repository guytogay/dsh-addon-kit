#!/usr/bin/env python3
"""in-host acceptance: talk MCP stdio to the INSTALLED driver and assert the typed contract.

Why this exists: the main acceptance runner (acceptance.py) drives the module from a separate
Python process. That is how a real defect escaped it - a Chinese reply came back empty only when
the helper ran under the MCP host, because the producer inherited the parent console codepage.
An out-of-host suite cannot see that class of failure, so at least one check has to go through the
protocol a model actually uses.

    python in_host_check.py [--server <desktop_server.py>] [--window <title substring>] [--json out.json]

Exit code 0 = every checked field is present and typed as expected; 1 otherwise.
Checks are read-only or provably non-delivering (a stale screenshot_id must be refused before any
input is sent).
"""

import argparse
import json
import os
import subprocess
import sys
import time

PROTOCOL_VERSION = "2024-11-05"
RESULTS = []


def record(case, state, detail=""):
    RESULTS.append({"case": case, "state": state, "detail": detail})
    print("{:5} {:56} {}".format(state, case, detail))


def check(case, ok, detail=""):
    record(case, "PASS" if ok else "FAIL", detail)


class StdioClient:
    def __init__(self, server, python):
        self.process = subprocess.Popen(
            [python, server], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, cwd=os.path.dirname(os.path.abspath(server)),
        )
        self.next_id = 0

    def send(self, payload):
        self.process.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        self.process.stdin.flush()

    def read_until(self, wanted_id, deadline):
        while time.time() < deadline:
            line = self.process.stdout.readline()
            if not line:
                return None
            text = line.decode("utf-8", "replace").strip()
            if not text:
                continue
            try:
                message = json.loads(text)
            except json.JSONDecodeError:
                continue
            if message.get("id") == wanted_id:
                return message
        return None

    def request(self, method, params=None, timeout=40.0):
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}})
        return self.read_until(self.next_id, time.time() + timeout)

    def initialize(self):
        reply = self.request("initialize", {
            "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
            "clientInfo": {"name": "in-host-check", "version": "1.0"}})
        if not reply or "result" not in reply:
            return None
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        return reply["result"]

    def call_tool(self, name, arguments=None, timeout=60.0):
        reply = self.request("tools/call", {"name": name, "arguments": arguments or {}}, timeout)
        if not reply:
            return None, "no reply"
        if "error" in reply:
            return None, json.dumps(reply["error"])[:200]
        result = reply.get("result", {})
        content = result.get("content") or []
        text = "".join(item.get("text", "") for item in content if item.get("type") == "text")
        if not text:
            return None, "no text content"
        try:
            return json.loads(text), None
        except json.JSONDecodeError:
            return None, "content was not JSON: " + text[:120]

    def close(self):
        try:
            self.process.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.process.wait(timeout=5)
        except Exception:  # noqa: BLE001
            self.process.kill()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", default=os.path.join(os.path.expanduser("~"), ".dsh", "mcp", "desktop", "desktop_server.py"))
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--window", default="")
    parser.add_argument("--json", default="")
    args = parser.parse_args()

    client = StdioClient(args.server, args.python)
    try:
        handshake = client.initialize()
        if handshake is None:
            check("MCP handshake", False, "initialize did not answer")
            return finish(args)
        check("MCP handshake", True, "server={} version={}".format(
            handshake.get("serverInfo", {}).get("name"), handshake.get("serverInfo", {}).get("version")))

        listing = client.request("tools/list", {})
        tools = [tool.get("name") for tool in (listing or {}).get("result", {}).get("tools", [])]
        needed = ["desktop_observe", "desktop_diff_window", "desktop_wait_stable",
                  "desktop_click_verified", "desktop_type_verified", "desktop_probe_app",
                  "desktop_lease_status"]
        missing = [name for name in needed if name not in tools]
        check("contract tools are exposed", not missing,
              "{} tools, missing={}".format(len(tools), missing))

        status, error = client.call_tool("desktop_lease_status")
        check("lease_status answers over the wire", status is not None and status.get("ok") is True,
              "count={} error={}".format((status or {}).get("count"), error))

        window = args.window
        if not window:
            windows, error = client.call_tool("desktop_list_windows", {"only_visible": True})
            titles = []
            for line in str(windows or "").splitlines() if isinstance(windows, str) else []:
                if " | " in line:
                    titles.append(line.split(" | ")[0].strip())
            # the tool returns text, not JSON: read the raw content instead
            raw = client.request("tools/call", {"name": "desktop_list_windows", "arguments": {"only_visible": True}})
            try:
                body = raw["result"]["content"][0]["text"]
                titles = [line.split(" | ")[0].strip() for line in body.splitlines() if " | " in line]
            except Exception:  # noqa: BLE001
                titles = []
            window = next((title for title in titles if title and title != "Program Manager"), "")
        if not window:
            record("observe returns the evidence fields", "SKIP", "no window title could be selected")
        else:
            observation, error = client.call_tool("desktop_observe", {"title_substring": window})
            ok = bool(observation) and observation.get("ok") is True
            check("observe returns the evidence fields",
                  ok and observation.get("frame_id") and observation.get("revision")
                  and "tree_readable" in observation and observation.get("pixel_state"),
                  "window={!r} elements={} tree_readable={} frame={}".format(
                      window, (observation or {}).get("elements"),
                      (observation or {}).get("tree_readable"),
                      str((observation or {}).get("frame_id"))[:12]) if ok else "error={}".format(error))

            settled, error = client.call_tool("desktop_wait_stable",
                                              {"title_substring": window, "stable_ms": 300, "timeout_ms": 6000})
            check("wait_stable reports both signals over the wire",
                  bool(settled) and "settled" in settled and "samples" in settled
                  and "pixel_signal" in settled,
                  "settled={} samples={} last_moving={} pixel_signal={}".format(
                      (settled or {}).get("settled"), (settled or {}).get("samples"),
                      (settled or {}).get("last_moving_signal"), (settled or {}).get("pixel_signal"))
                  if settled else "error={}".format(error))

            refused, error = client.call_tool("desktop_click_verified", {
                "x": 5, "y": 5, "title_substring": window, "expect_text": "ZZZ-in-host-never",
                "screenshot_id": "deadbeefdeadbeef"})
            check("a stale frame is refused over the wire (nothing delivered)",
                  bool(refused) and refused.get("stale_capture") is True
                  and refused.get("effect") == "not-delivered",
                  "effect={} stale={}".format((refused or {}).get("effect"), (refused or {}).get("stale_capture"))
                  if refused else "error={}".format(error))

            card, error = client.call_tool("desktop_probe_app", {"title_substring": window})
            check("probe_app answers a read-only route card over the wire",
                  bool(card) and card.get("ok") is True and "route" in card
                  and card.get("step2_click", {}).get("ran") is False,
                  "route={} elements={}".format((card or {}).get("route", {}).get("route"),
                                                (card or {}).get("step1_tree", {}).get("elements"))
                  if card else "error={}".format(error))
    finally:
        client.close()
    return finish(args)


def finish(args):
    fails = [item for item in RESULTS if item["state"] == "FAIL"]
    summary = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "pass": len([item for item in RESULTS if item["state"] == "PASS"]),
        "fail": len(fails),
        "skip": len([item for item in RESULTS if item["state"] == "SKIP"]),
        "results": RESULTS,
    }
    print("\nSUMMARY pass={pass} fail={fail} skip={skip}".format(**summary))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as out:
            json.dump(summary, out, indent=2, ensure_ascii=False)
        print("report:", args.json)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
