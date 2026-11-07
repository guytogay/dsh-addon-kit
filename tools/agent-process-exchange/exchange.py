#!/usr/bin/env python3
"""Small, dependency-free file mailbox for opt-in agent process reviews.

Delivery is local/shared-filesystem only. Agent runtime integration and remote
file transport belong to the host; this tool neither launches nor loops agents.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time
from datetime import datetime, timezone
from uuid import uuid4


AGENT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
MESSAGE_ID = re.compile(r"[a-f0-9]{32}\Z")
MAX_BYTES = 10 * 1024 * 1024


def agent_id(value):
    if not AGENT_ID.fullmatch(value) or value in {".", ".."}:
        raise ValueError("agent id must be 1-64 safe ASCII characters")
    return value


def message_id(value):
    if not MESSAGE_ID.fullmatch(value):
        raise ValueError("invalid message id")
    return value


def mailbox(root, recipient, create=False):
    base = Path(root).expanduser().resolve(strict=False)
    if not base.is_absolute():
        raise ValueError("mailbox root must resolve to an absolute directory")
    if base.exists() and base.is_symlink():
        raise ValueError("mailbox root cannot be a symlink")
    path = base / "inbox" / agent_id(recipient)
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists() and path.is_symlink():
        raise ValueError("agent inbox cannot be a symlink")
    return path


def file_digest(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            size += len(chunk)
            if size > MAX_BYTES:
                raise ValueError("process file exceeds 10 MiB; select a bounded trace")
            digest.update(chunk)
    return digest.hexdigest(), size


def read_record(path):
    if path.is_symlink() or not path.is_dir():
        raise ValueError("message directory is invalid")
    meta_path = path / "manifest.json"
    payload_path = path / "payload"
    if meta_path.is_symlink() or payload_path.is_symlink():
        raise ValueError("message contains a symlink")
    data = json.loads(meta_path.read_text(encoding="utf-8"))
    if data.get("id") != path.name or data.get("schema") != 1:
        raise ValueError("message manifest is invalid")
    digest, size = file_digest(payload_path)
    if data.get("sha256") != digest or data.get("size") != size:
        raise ValueError("message digest mismatch")
    return data


def deliver(args):
    sender = agent_id(args.from_agent)
    recipient = agent_id(args.to_agent)
    if sender == recipient:
        raise ValueError("choose another agent for peer review")
    source = Path(args.file).expanduser().resolve(strict=True)
    if not source.is_file():
        raise ValueError("source must be a regular file")
    digest, size = file_digest(source)
    if args.reply_to:
        message_id(args.reply_to)
    if args.key:
        # Stable per sender/recipient/kind/key; a different payload cannot overwrite it.
        identifier = hashlib.sha256(
            json.dumps([sender, recipient, args.kind, args.key], ensure_ascii=True).encode()
        ).hexdigest()[:32]
    else:
        identifier = uuid4().hex
    dest_parent = mailbox(args.root, recipient, create=True)
    dest = dest_parent / identifier
    if dest.exists():
        existing = read_record(dest)
        if existing["sha256"] != digest or existing["from"] != sender:
            raise ValueError("idempotency key already used for a different message")
        print(json.dumps({"id": identifier, "recipient": recipient, "duplicate": True}))
        return
    staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=dest_parent))
    try:
        shutil.copyfile(source, staging / "payload")
        if file_digest(staging / "payload") != (digest, size):
            raise ValueError("source changed during transfer")
        manifest = {
            "schema": 1, "id": identifier, "kind": args.kind,
            "from": sender, "to": recipient, "reply_to": args.reply_to,
            "source_name": source.name, "size": size, "sha256": digest,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        (staging / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.chmod(staging / "payload", 0o600)
        os.chmod(staging / "manifest.json", 0o600)
        # Publish only after both files have been written and validated.
        staging.rename(dest)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    print(json.dumps({"id": identifier, "recipient": recipient, "duplicate": False}))


def records(args):
    inbox = mailbox(args.root, args.agent)
    if not inbox.exists():
        return []
    found = []
    for path in sorted(inbox.iterdir()):
        if not MESSAGE_ID.fullmatch(path.name):
            continue
        record = read_record(path)
        if getattr(args, "kind", None) and record["kind"] != args.kind:
            continue
        found.append(record)
    return found


def inspect(args):
    path = mailbox(args.root, args.agent) / message_id(args.id)
    record = read_record(path)
    print(json.dumps({**record, "payload_path": str(path / "payload")}, ensure_ascii=False))


def wait(args):
    # Bounded wait: do not turn a review into an unbounded background loop.
    deadline = time.monotonic() + args.timeout
    while True:
        matches = records(args)
        if matches:
            print(json.dumps(matches, ensure_ascii=False))
            return
        if time.monotonic() >= deadline:
            print("[]")
            return
        time.sleep(min(0.5, max(0, deadline - time.monotonic())))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, help="trusted shared mailbox directory")
    sub = parser.add_subparsers(dest="command", required=True)
    send = sub.add_parser("send", help="atomically deliver a pre-redacted trace or peer review")
    send.add_argument("--from-agent", required=True)
    send.add_argument("--to-agent", required=True)
    send.add_argument("--file", required=True)
    send.add_argument("--kind", choices=("trace", "review"), required=True)
    send.add_argument("--reply-to", help="original message id, for peer review replies")
    send.add_argument("--key", help="optional idempotency key for retries")
    listing = sub.add_parser("list", help="list verified messages")
    listing.add_argument("--agent", required=True)
    listing.add_argument("--kind", choices=("trace", "review"))
    receive = sub.add_parser("receive", help="verify and locate one payload")
    receive.add_argument("--agent", required=True)
    receive.add_argument("--id", required=True)
    watcher = sub.add_parser("wait", help="bounded mailbox poll, for host integration")
    watcher.add_argument("--agent", required=True)
    watcher.add_argument("--kind", choices=("trace", "review"))
    watcher.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    try:
        if args.command == "send":
            deliver(args)
        elif args.command == "list":
            print(json.dumps(records(args), ensure_ascii=False))
        elif args.command == "receive":
            inspect(args)
        elif args.command == "wait":
            if not 0 <= args.timeout <= 60:
                raise ValueError("timeout must be between 0 and 60 seconds")
            wait(args)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"exchange: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
