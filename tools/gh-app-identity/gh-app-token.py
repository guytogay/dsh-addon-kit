#!/usr/bin/env python3
"""Mint a GitHub App installation token and use it (without ever printing it).

Why this exists
---------------
Agents on one machine often share a single GitHub account, so their actions are
indistinguishable in the audit trail.  A GitHub App gives one
agent its own bot identity (`<slug>[bot]`), installed only on the repos the
owner selected.  Installation tokens last one hour and are scoped by the
App's own permissions, not by the human account's.

Design rules
------------
* The token is a secret.  It is never printed unless `--print-token` is
  passed explicitly; the normal path is `--exec -- <cmd>`, which runs the
  command with GH_TOKEN set in its environment.
* The private key never leaves its file: JWT signing shells out to
  `openssl dgst -sha256 -sign`, so no third-party Python crypto is needed.
* A cached token is reused until 60s before expiry to keep repeated calls
  cheap; the cache is best-effort and its absence is never fatal.

Usage
-----
  python gh-app-token.py --app my-agent
  python gh-app-token.py --app my-agent --exec -- gh api user --jq .login
  python gh-app-token.py --app my-agent --exec -- gh issue comment 1 -R owner/repo --body "..."

Exit codes
----------
  0  success
  1  usage error / credentials missing or unreadable
  2  GitHub API or signing failure
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.github.com"
API_VERSION = "2022-11-28"
UA = "ena-gh-app-token-helper"
CRED_DIR = Path(os.environ.get("GH_APP_CRED_DIR")
                or Path.home() / ".dsh" / "gh-apps")
CACHE_DIR = CRED_DIR  # overridden to the --creds file's directory when given
CACHE_MARGIN_S = 60


def die(code: int, msg: str) -> "None":
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(code)


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def find_openssl() -> str:
    found = shutil.which("openssl")
    if found:
        return found
    for cand in (
        r"C:\Program Files\Git\usr\bin\openssl.exe",
        r"C:\Program Files\Git\mingw64\bin\openssl.exe",
        "/usr/bin/openssl",
    ):
        if os.path.exists(cand):
            return cand
    die(1, "openssl not found; needed to sign the App JWT")


def load_creds(app: str, creds: str | None) -> dict:
    path = Path(creds) if creds else CRED_DIR / f"{app}.json"
    if not path.exists():
        die(1, f"credentials not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        die(1, f"cannot parse {path}: {exc}")
    pem = data.get("pem") or data.get("private_key")
    if not pem:
        die(1, f"{path} has no 'pem' field")
    if "BEGIN" not in pem:
        die(1, f"{path} 'pem' does not look like a PEM key")
    if not data.get("app_id") and not data.get("id"):
        die(1, f"{path} has no app_id")
    data["_path"] = str(path)
    return data


def api(path: str, jwt: str | None = None, token: str | None = None,
        method: str = "GET", body: dict | None = None) -> dict:
    if jwt:
        auth = f"Bearer {jwt}"
    elif token:
        auth = f"token {token}"
    else:
        die(2, "api() needs a jwt or a token")
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", auth)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", API_VERSION)
    req.add_header("User-Agent", UA)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        die(2, f"{method} {path} -> HTTP {exc.code}: {detail}")
    except Exception as exc:  # noqa: BLE001
        die(2, f"{method} {path} -> {exc}")
    return json.loads(raw) if raw else {}


def make_jwt(app_id: str, pem: str) -> str:
    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    payload = {"iat": now - 60, "exp": now + 540, "iss": str(app_id)}
    signing_input = (
        b64url(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + b64url(json.dumps(payload, separators=(",", ":")).encode())
    ).encode("ascii")
    openssl = find_openssl()
    with tempfile.TemporaryDirectory() as td:
        key = Path(td) / "app.pem"
        inp = Path(td) / "in.txt"
        sig = Path(td) / "sig.bin"
        key.write_text(pem if pem.endswith("\n") else pem + "\n", encoding="ascii")
        inp.write_bytes(signing_input)
        proc = subprocess.run(
            [openssl, "dgst", "-sha256", "-sign", str(key), "-out", str(sig), str(inp)],
            capture_output=True,
        )
        if proc.returncode != 0:
            die(2, "openssl signing failed: "
                   + proc.stderr.decode("utf-8", "replace")[:300])
        signature = sig.read_bytes()
    return signing_input.decode("ascii") + "." + b64url(signature)


def cached_token(app: str, app_id: str) -> str | None:
    path = CACHE_DIR / f".token-cache-{app}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if str(data.get("app_id")) != str(app_id):
        return None
    if data.get("expires_epoch", 0) - CACHE_MARGIN_S <= time.time():
        return None
    return data.get("token")


def store_token(app: str, app_id: str, token: str, expires_at: str) -> None:
    path = CACHE_DIR / f".token-cache-{app}.json"
    epoch = int(time.time()) + 3300
    try:
        from datetime import datetime, timezone
        epoch = int(datetime.strptime(expires_at, "%Y-%m-%dT%H:%M:%SZ")
                    .replace(tzinfo=timezone.utc).timestamp())
    except Exception:  # noqa: BLE001
        pass
    try:
        path.write_text(json.dumps(
            {"app_id": str(app_id), "token": token,
             "expires_at": expires_at, "expires_epoch": epoch}), encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except Exception:  # noqa: BLE001
            pass
    except Exception:  # noqa: BLE001
        pass  # cache is an optimisation only


def main() -> int:
    # `--exec -- <cmd...>` is split by hand: argparse treats a bare `--` as
    # its own option terminator and would reject the child command as
    # unrecognised arguments (observed 2026-09-14).
    raw = sys.argv[1:]
    exec_argv = None
    if "--exec" in raw:
        cut = raw.index("--exec")
        tail = raw[cut + 1:]
        if tail and tail[0] == "--":
            tail = tail[1:]
        if not tail:
            die(1, "--exec needs a command after --")
        exec_argv = tail
        raw = raw[:cut]

    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--app", required=True, help="App slug, e.g. my-agent")
    ap.add_argument("--account", help="owner login to pick the installation for "
                                      "(default: the credentials file's \"account\" field)")
    ap.add_argument("--creds", help="explicit credentials json path")
    ap.add_argument("--print-token", action="store_true",
                    help="print the token (secret; avoid unless required)")
    ap.add_argument("--json", action="store_true", help="machine-readable summary")
    ap.add_argument("--no-cache", action="store_true")
    args = ap.parse_args(raw)

    global CACHE_DIR
    if args.creds:
        CACHE_DIR = Path(args.creds).resolve().parent

    data = load_creds(args.app, args.creds)
    if args.account:
        data["account"] = args.account
    app_id = str(data.get("app_id") or data.get("id"))
    pem = data.get("pem") or data.get("private_key")

    token = None if args.no_cache else cached_token(args.app, app_id)
    source = "cache"
    installation_id = None
    expires_at = None
    if token is None:
        source = "minted"
        jwt = make_jwt(app_id, pem)
        app = api("/app", jwt=jwt)
        slug = app.get("slug") or args.app
        installs = api("/app/installations", jwt=jwt)
        if not installs:
            die(2, f"App {slug} has no installations; install it on a repository first")
        chosen = None
        wanted = (data.get("account") or "").lower()
        for inst in installs:
            acct = (inst.get("account") or {}).get("login", "")
            if wanted and acct.lower() == wanted:
                chosen = inst
                break
        if chosen is None and len(installs) > 1 and wanted == "":
            # Several owners and no stated account: refuse to guess.
            owners = sorted({(i.get("account") or {}).get("login", "?") for i in installs})
            die(2, f"App is installed for several owners {owners}; "
                   f"add \"account\": \"<login>\" to the credentials file or pass --account")
        chosen = chosen or installs[0]
        installation_id = chosen.get("id")
        tok = api(f"/app/installations/{installation_id}/access_tokens",
                  jwt=jwt, method="POST")
        token = tok.get("token")
        expires_at = tok.get("expires_at")
        if not token:
            die(2, "installation token response carried no token")
        store_token(args.app, app_id, token, expires_at or "")
        identity = f"{slug}[bot]"
    else:
        identity = f"{args.app}[bot]"

    if args.print_token:
        print(token)

    if exec_argv:
        argv = exec_argv
        env = dict(os.environ)
        env["GH_TOKEN"] = token
        env.pop("GITHUB_TOKEN", None)
        sys.stdout.flush()
        proc = subprocess.run(argv, env=env)
        return proc.returncode

    summary = {"app": args.app, "identity": identity, "app_id": app_id,
               "installation_id": installation_id, "token_source": source,
               "expires_at": expires_at, "creds": data["_path"]}
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"app          {args.app}  (id {app_id})")
        print(f"identity     {identity}")
        print(f"installation {installation_id if installation_id else 'from cache'}")
        print(f"token        {source}"
              + (f", expires {expires_at}" if expires_at else ""))
        print(f"token value  withheld (use --print-token or --exec)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
