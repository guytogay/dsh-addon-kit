#!/usr/bin/env python3
"""Hold one window's kernel mutex from ANOTHER PROCESS.

The point of the acceptance case that uses this: exclusion must be process-independent. A
declared identity (a name in a file, a pid a caller reports) cannot demonstrate that - two real
processes contending for the same window can. Killing this process while it holds the mutex is
also how the "abandoned" path is tested: the kernel should hand ownership over immediately
instead of making the next actor wait out a TTL.

Usage: hold_mutex.py <hwnd> [--seconds 30] [--module-dir <driver dir>]
Exit 0 after the hold elapses; 2 if the mutex could not be taken.
"""

import argparse
import json
import os
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("hwnd", type=int)
parser.add_argument("--seconds", type=float, default=30.0)
parser.add_argument("--module-dir", default=os.path.join(os.path.expanduser("~"), ".dsh", "mcp", "desktop"))
args = parser.parse_args()

sys.path.insert(0, os.path.abspath(args.module_dir))
import desktop_server as holder  # noqa: E402

gate = holder._cua_mutex_acquire(args.hwnd)
print(json.dumps(gate), flush=True)
if not gate.get("ok"):
    sys.exit(2)

holder._cua_label_write(args.hwnd, "acceptance-holder")
deadline = time.time() + args.seconds
try:
    while time.time() < deadline:
        time.sleep(0.2)
finally:
    holder._cua_label_remove(args.hwnd)
    holder._cua_mutex_release(gate.get("handle"))
