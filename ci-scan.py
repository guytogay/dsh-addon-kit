#!/usr/bin/env python3
# ci-scan.py — sanity gate for the public dsh-addon-kit repository.
# Runs in GitHub Actions on every push/PR, and locally: `python3 ci-scan.py`.
# Fails (exit 1) when any of:
#   1) real private identifiers appear (IPs, domains, local paths, private names)
#   2) secret-looking values or secret files are committed
#   3) required placeholders were removed (sanitization bypassed)
#   4) key code files fail syntax checks
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SKIP_DIRS = {".git", "node_modules", ".venv"}
SKIP_FILES = {"ci-scan.py", "LICENSE"}  # policy file (patterns) + license (author name)

PRIVATE_PATTERNS = [
    (r"100\.116\.50\.\d+", "tailscale IP (PC host)"),
    (r"100\.111\.20\.\d+", "tailscale IP (peer host)"),
    (r"100\.116\.20\.\d+", "tailscale IP (third host)"),
    (r"192\.168\.16\.\d+", "LAN IP"),
    (r"[a-z0-9-]+\.tailbe79\.ts\.net", "tailscale domain"),
    (r"C:\\Users\\?PC\\", "local user path"),
    (r"\bHermes\b", "private agent name"),
    (r"\bObsidian\b", "private app name"),
    (r"\bAnytype\b", "private kb name"),
    (r"pve-diag", "private directory"),
    (r"lxc-dsh", "private instance"),
    (r"MiniMax-M3", "private model"),
]

SECRET_PATTERNS = [
    (r"ghp_[A-Za-z0-9]{36,}", "GitHub PAT"),
    (r"sk-[A-Za-z0-9]{20,}", "API key (sk-…)"),
    (r"AKIA[0-9A-Z]{16}", "AWS access key"),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private key block"),
    (r"Bearer [0-9a-f]{32,}", "bearer token"),
    (r"(?i)password\s*[:=]\s*[^\s\"'<>]{6,}", "password literal"),
]

SECRET_SUFFIXES = (".token", ".secret", ".env", "credentials")

REQUIRED_PLACEHOLDERS = [
    ("bridges/a2a-peer-bridge/a2a-agent.mjs", ["<PC_TAILSCALE_IP>", "<YOUR_DOMAIN>.ts.net"]),
    ("bridges/a2a-peer-bridge/peer-mcp-server.mjs", ["<PC_TAILSCALE_IP>", "<YOUR_DOMAIN>.ts.net"]),
    ("mobile-remote/setup.ps1", ["<PC_TAILSCALE_IP>"]),
]

SYNTAX_CHECKS = [
    ("node", ["--check", "bridges/a2a-peer-bridge/a2a-agent.mjs"]),
    ("node", ["--check", "bridges/a2a-peer-bridge/peer-mcp-server.mjs"]),
    (sys.executable, ["-m", "py_compile", "mcp/desktop/desktop_server.py"]),
]

problems = []


def walk():
    for root, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            yield os.path.join(root, f)


def scan_contents():
    priv_rx = [(re.compile(p), d) for p, d in PRIVATE_PATTERNS]
    sec_rx = [(re.compile(p), d) for p, d in SECRET_PATTERNS]
    for path in walk():
        rel = os.path.relpath(path, ROOT)
        base = os.path.basename(path)
        if base in SKIP_FILES:
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="strict") as fh:
                content = fh.read()
        except (UnicodeDecodeError, OSError):
            continue
        for i, line in enumerate(content.splitlines(), 1):
            for rx, desc in priv_rx:
                if rx.search(line):
                    problems.append("PRIVATE %s: %s:%d  %s" % (desc, rel, i, line.strip()[:80]))
            for rx, desc in sec_rx:
                if rx.search(line):
                    problems.append("SECRET %s: %s:%d  %s" % (desc, rel, i, line.strip()[:80]))
        if any(base.endswith(s) for s in SECRET_SUFFIXES):
            problems.append("SECRET FILE committed: %s" % rel)


def scan_placeholders():
    for rel, must in REQUIRED_PLACEHOLDERS:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            problems.append("PLACEHOLDER FILE missing: %s" % rel)
            continue
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        for ph in must:
            if ph not in text:
                problems.append("PLACEHOLDER missing in %s: %s" % (rel, ph))


def scan_syntax():
    for cmd, args in SYNTAX_CHECKS:
        try:
            r = subprocess.run([cmd] + args, cwd=ROOT, capture_output=True, text=True, timeout=120)
        except FileNotFoundError:
            problems.append("SYNTAX SKIP (tool missing): %s" % cmd)
            continue
        if r.returncode != 0:
            problems.append("SYNTAX FAIL: %s %s -> %s" % (cmd, args[0], (r.stderr or r.stdout or "")[-300:]))


def main():
    scan_contents()
    scan_placeholders()
    scan_syntax()
    if problems:
        print("sanity-scan: FAIL (%d problems)" % len(problems))
        for p in problems:
            print("  -", p)
        sys.exit(1)
    print("sanity-scan: PASS (no private ids, no secrets, placeholders intact, syntax ok)")


if __name__ == "__main__":
    main()
