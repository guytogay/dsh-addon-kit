"""Black-box tests for the file-only peer exchange CLI."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("exchange.py")


class ExchangeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "trace.md"
        self.source.write_text("User selected STOP. No more action was authorized.\n", encoding="utf-8")

    def run_exchange(self, *args, ok=True):
        done = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.root / "mail"), *args],
            text=True, capture_output=True,
        )
        if ok:
            self.assertEqual(done.returncode, 0, done.stderr)
        else:
            self.assertNotEqual(done.returncode, 0)
        return done

    def test_bidirectional_review_and_digest(self):
        first = json.loads(self.run_exchange(
            "send", "--from-agent", "alpha", "--to-agent", "beta",
            "--kind", "trace", "--file", str(self.source), "--key", "task-7",
        ).stdout)
        self.assertFalse(first["duplicate"])
        got = json.loads(self.run_exchange("list", "--agent", "beta", "--kind", "trace").stdout)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["sha256"], hashlib.sha256(self.source.read_bytes()).hexdigest())
        received = json.loads(self.run_exchange(
            "receive", "--agent", "beta", "--id", first["id"]
        ).stdout)
        self.assertEqual(Path(received["payload_path"]).read_bytes(), self.source.read_bytes())

        review = self.root / "review.md"
        review.write_text("Finding: stop after explicit user cancellation.\n", encoding="utf-8")
        response = json.loads(self.run_exchange(
            "send", "--from-agent", "beta", "--to-agent", "alpha",
            "--kind", "review", "--file", str(review), "--reply-to", first["id"],
        ).stdout)
        returned = json.loads(self.run_exchange(
            "receive", "--agent", "alpha", "--id", response["id"]
        ).stdout)
        self.assertEqual(returned["reply_to"], first["id"])
        self.assertEqual(returned["kind"], "review")

        duplicate = json.loads(self.run_exchange(
            "send", "--from-agent", "alpha", "--to-agent", "beta",
            "--kind", "trace", "--file", str(self.source), "--key", "task-7",
        ).stdout)
        self.assertEqual(duplicate["id"], first["id"])
        self.assertTrue(duplicate["duplicate"])

    def test_tamper_and_identity_rejected(self):
        first = json.loads(self.run_exchange(
            "send", "--from-agent", "a", "--to-agent", "b",
            "--kind", "trace", "--file", str(self.source),
        ).stdout)
        payload = self.root / "mail" / "inbox" / "b" / first["id"] / "payload"
        payload.write_text("tampered\n", encoding="utf-8")
        self.assertIn("digest mismatch", self.run_exchange(
            "receive", "--agent", "b", "--id", first["id"], ok=False
        ).stderr)
        self.run_exchange(
            "send", "--from-agent", "../escape", "--to-agent", "b",
            "--kind", "trace", "--file", str(self.source), ok=False,
        )

    def test_bounded_wait_and_conflicting_key(self):
        self.assertEqual(self.run_exchange(
            "wait", "--agent", "empty", "--timeout", "0"
        ).stdout.strip(), "[]")
        self.run_exchange("wait", "--agent", "empty", "--timeout", "61", ok=False)
        self.run_exchange(
            "send", "--from-agent", "a", "--to-agent", "b",
            "--kind", "trace", "--file", str(self.source), "--key", "once",
        )
        self.source.write_text("different", encoding="utf-8")
        self.run_exchange(
            "send", "--from-agent", "a", "--to-agent", "b",
            "--kind", "trace", "--file", str(self.source), "--key", "once", ok=False,
        )


if __name__ == "__main__":
    unittest.main()
