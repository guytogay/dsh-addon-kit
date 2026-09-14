#!/usr/bin/env python3
# ci-scan.py — sanity gate for the public dsh-addon-kit repository.
# Runs in GitHub Actions on every push/PR, and locally: `python3 ci-scan.py`.
# Fails (exit 1) when any of:
#   1) real private identifiers appear (IPs, domains, local paths, private names)
#   2) secret-looking values or secret files are committed
#   3) a raw private identifier survives anywhere in the tree (sanitization bypassed)
#   4) key code files fail syntax checks
import os
import sys

# The syntax check must not create the artifact it is checking: py_compile writes byte-code beside the
# source, and a stray .pyc was previously committed as a published file. Suppress byte-code writing for
# this process before any check runs.
os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
sys.dont_write_bytecode = True

from pathlib import Path  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402

# Windows consoles default to a legacy code page (GBK here) and crash on characters such as
# U+2194 that appear in scan findings; force UTF-8 with replacement so the gate can also
# finish locally instead of dying mid-report.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

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

# Raw private identifiers that must never appear in a published tree, in every shape they take in real
# files: forward-slash Windows paths, escaped-backslash paths inside source code, the user prefix, the
# project directory name, tailnet addresses and private domains. Demanding a placeholder string instead
# only proves that substitution ran, not that the tree is clean - and a file that reads its address from
# the environment needs no placeholder at all.
RAW_IDENTIFIERS = [
    (r"100\.(?:1[0-9]{2}|[6-9][0-9])\.[0-9]{1,3}\.[0-9]{1,3}", "tailnet address"),
    (r"[a-z0-9-]+\.ts\.net", "private tailnet domain"),
    (r"C:/Users/[A-Za-z0-9._-]+", "forward-slash user path"),
    (r"C:\\\\Users\\\\[A-Za-z0-9._-]+", "escaped-backslash user path"),
    (r"C:\\Users\\[A-Za-z0-9._-]+", "user path"),
    (r"%USERPROFILE%[\\/]Documents[\\/](?!<YOUR_PROJECT>)", "project directory name"),
    (r"192\.168\.[0-9]{1,3}\.[0-9]{1,3}", "private LAN address"),
]


def raw_identifier_problems(root):
    found = []
    for path in sorted(Path(root).rglob("*")):
        if not path.is_file() or ".git" in path.parts:
            continue
        if path.name in {"ci-scan.py", "publish_public.py"}:
            continue                       # they carry the patterns themselves
        body = path.read_text(encoding="utf-8", errors="ignore")
        for pattern, label in RAW_IDENTIFIERS:
            for hit in re.finditer(pattern, body):
                if hit.group(0).startswith("<"):
                    continue
                found.append(f"{path.relative_to(root)}: {label} -> {hit.group(0)[:60]}")
    return found

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
    """Fail on a raw private identifier anywhere in the tree, not on a missing placeholder string.

    The previous version required specific placeholders to be present in specific files, which proves
    only that substitution ran. A file that reads its address from the environment carries no
    placeholder and is still clean, while a raw identifier anywhere is a leak regardless of which file
    it sits in.
    """
    for item in raw_identifier_problems(ROOT):
        problems.append("RAW IDENTIFIER %s" % item)
    if not os.path.exists(os.path.join(ROOT, "LICENSE")):
        problems.append("PLACEHOLDER FILE missing: LICENSE")


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
    print("sanity-scan: PASS (no raw private identifiers, no secrets, syntax ok)")


if __name__ == "__main__":
    main()
