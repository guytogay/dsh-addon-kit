#!/usr/bin/env python3
"""Wait for the next upstream ruling to appear on GitHub, then print it and exit.

Why this exists: the upstream maintainer works in a web session, so the coordination cost used to be
"scrape the browser and hope the reply finished". Two rules replaced that:

  1. upstream mirrors every final ruling as a comment on the coordination issue (ENA #34);
  2. this watcher polls that issue's comments - a tiny API response, no browser, no context cost -
     and exits the moment a new one appears.

Run it as a background job while waiting on upstream. The harness tells me when the job finishes, so
there is no busy-polling: I read one small result when it is actually ready.

    python ena-coord/watch-upstream.py            # waits for a ruling newer than the last seen one
    python ena-coord/watch-upstream.py --check    # one shot: report only if something new exists

State (the highest comment id already seen) lives next to this file in watch-upstream-state.json, so
a later run does not re-report old rulings.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = HERE / "watch-upstream-state.json"

# Comment bodies carry CJK and emoji; a GBK console would raise on the print and turn a successful
# watch into a traceback. Reporting must never be the failure surface.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
ISSUE_URL = "repos/guytogay/ENA/issues/34/comments"
MARKERS = ("UPSTREAM RULING", "UPSTREAM RULING CORRECTION", "Maintainer disposition",
           "Maintainer closure", "ACCEPT", "DECISION")


def gh_comments() -> list[dict]:
    proc = subprocess.run(
        ["gh", "api", f"{ISSUE_URL}?per_page=100",
         "--jq", '.[] | {id, created_at, body}'],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise SystemExit(f"gh failed: {proc.stderr.strip()}")
    return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]


def last_seen() -> int:
    try:
        return int(json.loads(STATE.read_text(encoding="utf-8"))["last_comment_id"])
    except (OSError, ValueError, KeyError):
        return 0


def remember(comment_id: int) -> None:
    STATE.write_text(json.dumps({"last_comment_id": comment_id,
                                 "updated_at": datetime.now(timezone.utc).isoformat()},
                                indent=2), encoding="utf-8")


def report(comments: list[dict]) -> int:
    fresh = [c for c in comments if c["id"] > last_seen()]
    if not fresh:
        return 0
    for comment in fresh:
        head = comment["body"].strip().splitlines()[0] if comment["body"].strip() else ""
        marker = any(word.lower() in head.lower() for word in MARKERS)
        print(f"--- comment {comment['id']} at {comment['created_at']}"
              f"{'  [looks like a ruling]' if marker else ''}")
        print(comment["body"])
        print()
    remember(max(c["id"] for c in fresh))
    return len(fresh)


def main() -> int:
    parser = argparse.ArgumentParser(description="Wait for the next upstream ruling on GitHub.")
    parser.add_argument("--check", action="store_true", help="one shot; exit 3 if nothing new")
    parser.add_argument("--interval", type=int, default=90, help="seconds between polls (default 90)")
    parser.add_argument("--timeout", type=int, default=3600, help="give up after this many seconds")
    args = parser.parse_args()

    deadline = time.time() + args.timeout
    while True:
        found = report(gh_comments())
        if found:
            print(f"[watch-upstream] {found} new comment(s) on the coordination issue")
            return 0
        if args.check:
            print("[watch-upstream] nothing new")
            return 3
        if time.time() > deadline:
            print(f"[watch-upstream] no new comment within {args.timeout}s")
            return 4
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
