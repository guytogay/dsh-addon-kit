#!/usr/bin/env python3
"""Create one GitHub App for one agent, via GitHub's manifest flow.

Why a script and not a manual click-through: the manifest flow is the only way to create an App
without hand-filling a long form, and it hands back the private key and secrets programmatically. The
human's part shrinks to confirming the creation page GitHub shows.

    python create-github-app.py --name my-agent --owner <your-login>

It serves a tiny page on 127.0.0.1 that auto-submits the manifest to GitHub, captures the redirect
code, exchanges it for credentials, and writes them under the user profile - never into a repository,
never to stdout, never to a log.
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

CRED_DIR = Path(os.environ.get("GH_APP_CRED_DIR")
                or Path.home() / ".dsh" / "gh-apps")
PORT = 8765
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def manifest(name: str, port: int, owner: str) -> dict:
    return {
        "name": name,
        "url": f"https://github.com/{owner}",
        "redirect_url": f"http://127.0.0.1:{port}/callback",
        "public": False,
        "request_oauth_on_install": False,
        "hook_attributes": {"active": False, "url": "https://example.invalid/unused"},
        "default_permissions": {
            "metadata": "read",          # always granted, listed for clarity
            "contents": "write",         # prepare a branch; merging stays manual
            "issues": "write",           # read, comment, label - the routing mechanism
            "pull_requests": "write",
        },
        "default_events": ["issues", "issue_comment", "pull_request"],
    }


class Handler(http.server.BaseHTTPRequestHandler):
    code: str | None = None

    def log_message(self, *args):        # keep the console quiet
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/callback":
            params = urllib.parse.parse_qs(parsed.query)
            Handler.code = (params.get("code") or [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"<html><body style='font-family:sans-serif;padding:2em'>"
                             b"<h2>OK - code received, you can close this tab.</h2>"
                             b"<p>The credentials are being written under your user profile.</p>"
                             b"</body></html>")
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        payload = json.dumps(manifest(Handler.app_name, PORT, Handler.owner))
        page = f"""<html><body onload="document.forms[0].submit()">
<form action="https://github.com/settings/apps/new" method="post">
<input type="hidden" name="manifest" value='{payload}'>
</form>
<p>Submitting the app manifest to GitHub…</p></body></html>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(page.encode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True, help="GitHub App name (must be globally unique)")
    parser.add_argument("--wait", type=int, default=600, help="seconds to wait for the confirmation")
    parser.add_argument("--owner", required=True,
                        help="GitHub account login that will own the App")
    args = parser.parse_args()

    Handler.app_name = args.name.replace(" ", "-")
    Handler.owner = args.owner          # type: ignore[attr-defined]
    CRED_DIR.mkdir(parents=True, exist_ok=True)

    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"1. open http://127.0.0.1:{PORT}/ in the logged-in browser")
        print(f"   it auto-submits the manifest for app '{Handler.app_name}'; "
              f"then confirm on GitHub's page")
        # Serve until the callback arrives. `handle_request()` serves exactly ONE request, which the
        # browser's first page load consumes, so the callback then hits a dead socket - the first
        # version of this did that and lost the code.
        watchdog = threading.Timer(args.wait, httpd.shutdown)
        watchdog.daemon = True
        watchdog.start()
        httpd.serve_forever()
        watchdog.cancel()

    if not Handler.code:
        print("no code captured; nothing written")
        return 1

    out = subprocess.run(["gh", "api", "--method", "POST", f"app-manifests/{Handler.code}/conversions"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    if out.returncode != 0:
        print(f"conversion failed: {out.stderr.strip()[:200]}")
        return 1
    data = json.loads(out.stdout)
    slug = data.get("slug") or args.name
    target = CRED_DIR / f"{slug}.json"
    secrets = {
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "name": data.get("name"), "slug": slug, "app_id": data.get("id"),
        "client_id": data.get("client_id"), "client_secret": data.get("client_secret"),
        "webhook_secret": data.get("webhook_secret"), "pem": data.get("pem"),
    }
    target.write_text(json.dumps(secrets, indent=2), encoding="utf-8")
    if not re.match(r"^[A-Za-z0-9._-]+$", slug):
        print("unexpected slug; inspect before using")
    print(f"2. credentials written to {target} (never print or commit this file)")
    print(f"3. install it on the repositories: https://github.com/apps/{slug}/installations/new")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
