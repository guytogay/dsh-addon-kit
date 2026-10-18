#!/usr/bin/env python3
"""desktop MCP server — Windows computer-use execution layer for DSH.

Zero paid dependencies: mss (screenshot) + ctypes (user32). Vision decisions
are made by the calling agent's model (DSH's deepseek vision route), so this
server never costs any OpenAI/Codex token.

Tools: desktop_screenshot, desktop_get_cursor, desktop_list_windows,
desktop_activate_window, desktop_click, desktop_double_click, desktop_move,
desktop_type, desktop_key, desktop_hotkey, desktop_scroll.
"""

import base64
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import time

from mcp.server.fastmcp import FastMCP
from mcp.types import ImageContent, TextContent

mcp = FastMCP("desktop")

_UIA_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uia_helper.ps1")


def _uia(req: dict) -> str:
    """Run the PowerShell UIA helper with a JSON action; return its JSON reply."""
    try:
        p = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", _UIA_SCRIPT, json.dumps(req)],
            capture_output=True, text=True, encoding="utf-8", timeout=45,
        )
        out = (p.stdout or "").strip()
        if p.returncode != 0:
            return f'{{"ok":false,"msg":"uia error: {(p.stderr or "")[:400]}"}}'
        return out if out else '{"ok":false,"msg":"empty output"}'
    except Exception as e:  # noqa: BLE001
        return f'{{"ok":false,"msg":"{e}"}}'

user32 = ctypes.windll.user32
user32.SetCursorPos.restype = wt.BOOL
user32.GetCursorPos.argtypes = [ctypes.POINTER(wt.POINT)]
user32.GetWindowTextLengthW.argtypes = [wt.HWND]
user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
user32.IsWindowVisible.argtypes = [wt.HWND]
user32.SetForegroundWindow.argtypes = [wt.HWND]
user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]

# ── SendInput structures ─────────────────────────────────────────────────────

ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", wt.DWORD),
        ("dwFlags", wt.DWORD),
        ("time", wt.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wt.WORD),
        ("wScan", wt.WORD),
        ("dwFlags", wt.DWORD),
        ("time", wt.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]


class INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("u", INPUT_UNION)]


INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
WHEEL_DELTA = 120

VK = {
    "back": 0x08, "tab": 0x09, "enter": 0x0D, "return": 0x0D, "shift": 0x10,
    "ctrl": 0x11, "control": 0x11, "alt": 0x12, "menu": 0x12, "pause": 0x13,
    "capslock": 0x14, "esc": 0x1B, "escape": 0x1B, "space": 0x20,
    "pageup": 0x21, "pagedown": 0x22, "end": 0x23, "home": 0x24,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "insert": 0x2D, "delete": 0x2E, "win": 0x5B, "lwin": 0x5B,
    "rwin": 0x5C, "apps": 0x5D, "f1": 0x70, "f2": 0x71, "f3": 0x72,
    "f4": 0x73, "f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77,
    "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}


def _send_input(entries):
    n = len(entries)
    arr = (INPUT * n)(*entries)
    user32.SendInput(n, arr, ctypes.sizeof(INPUT))


def _key_event(vk, keyup=False, unicode_char=None):
    flags = KEYEVENTF_KEYUP if keyup else 0
    scan, vk_field = 0, vk
    if unicode_char is not None:
        scan = ord(unicode_char)
        vk_field = 0
        flags |= KEYEVENTF_UNICODE
    return INPUT(type=INPUT_KEYBOARD, u=INPUT_UNION(ki=KEYBDINPUT(
        wVk=vk_field, wScan=scan, dwFlags=flags, time=0, dwExtraInfo=0)))


def _mouse_event(flags, dx=0, dy=0, data=0):
    return INPUT(type=INPUT_MOUSE, u=INPUT_UNION(mi=MOUSEINPUT(
        dx=dx, dy=dy, mouseData=data, dwFlags=flags, time=0, dwExtraInfo=0)))


@mcp.tool()
def desktop_screenshot(monitor: int = 0, save_path: str = "", left: int | None = None,
                       top: int | None = None, width: int | None = None,
                       height: int | None = None) -> list:
    """Capture a screen region. monitor: 0 = whole virtual desktop, 1 = primary.
    Optionally pass left/top/width/height to capture only a rectangle (much cheaper
    in vision tokens than a full-screen shot). save_path optional.
    Returns the saved PNG path plus the image itself (visible to vision models)."""
    import mss

    with mss.mss() as sct:
        if left is not None and top is not None and width is not None and height is not None:
            region = {"left": left, "top": top, "width": width, "height": height}
        elif monitor == 0:
            region = sct.monitors[0]
        else:
            region = sct.monitors[monitor]
        shot = sct.grab(region)
        from mss.tools import to_png

        png = to_png(shot.rgb, shot.size)
    if not save_path:
        save_path = os.path.join(_CUA_SHOT_DIR, "screen-{}.png".format(int(time.time())))
    import os

    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    with open(save_path, "wb") as f:
        f.write(png)
    b64 = base64.b64encode(png).decode("ascii")
    return [
        TextContent(type="text", text=f"screenshot saved: {save_path}"),
        ImageContent(type="image", data=b64, mimeType="image/png"),
    ]


@mcp.tool()
def desktop_screenshot_window(title_substring: str, save_path: str = "") -> list:
    """Capture only the window whose title contains title_substring (cheaper than
    a full-screen shot). Returns the saved PNG path plus the image itself."""
    import mss

    hwnd_title = _find_window(title_substring)
    if hwnd_title is None:
        return [TextContent(type="text", text=f"no window title contains {title_substring!r}")]
    hwnd, title = hwnd_title
    rect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    region = {"left": rect.left, "top": rect.top,
              "width": max(1, rect.right - rect.left),
              "height": max(1, rect.bottom - rect.top)}
    with mss.mss() as sct:
        shot = sct.grab(region)
        from mss.tools import to_png

        png = to_png(shot.rgb, shot.size)
        frame = _cua_frame_id(_cua_cells_from_shot(shot))
    if not save_path:
        save_path = os.path.join(_CUA_SHOT_DIR, "window-{}.png".format(int(time.time())))
    import os

    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    with open(save_path, "wb") as f:
        f.write(png)
    b64 = base64.b64encode(png).decode("ascii")
    return [
        TextContent(type="text", text="window screenshot saved: {} | frame_id={} "
                                      "(pass it as screenshot_id to desktop_click_verified to bind the "
                                      "coordinates to this frame)".format(save_path, frame)),
        ImageContent(type="image", data=b64, mimeType="image/png"),
    ]


def _find_window(title_substring: str):
    """Return (hwnd, title) of the first visible top-level window whose title
    contains title_substring (case-insensitive), or None."""
    target = None

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, lparam):
        nonlocal target
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if title_substring.lower() in buf.value.lower():
            target = (hwnd, buf.value)
            return False
        return True

    user32.EnumWindows(cb, 0)
    return target


@mcp.tool()
def desktop_get_cursor() -> str:
    """Return the current cursor position as x:y."""
    pt = wt.POINT(0, 0)
    user32.GetCursorPos(ctypes.byref(pt))
    return f"{pt.x}:{pt.y}"


@mcp.tool()
def desktop_list_windows(only_visible: bool = True) -> str:
    """List top-level windows (title | hwnd | rect) so the agent can pick a target."""
    out = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, lparam):
        if only_visible and not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        rect = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        out.append(f"{buf.value} | 0x{hwnd:X} | [{rect.left},{rect.top},{rect.right},{rect.bottom}]")
        return True

    user32.EnumWindows(cb, 0)
    return "\n".join(out[:80]) if out else "(no titled windows)"


@mcp.tool()
def desktop_activate_window(title_substring: str) -> str:
    """Bring the top-level window whose title contains title_substring to the foreground.
    Returns the matched window title or an error message."""
    import ctypes.wintypes as wt2

    target = None

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, lparam):
        nonlocal target
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if title_substring.lower() in buf.value.lower():
            target = (hwnd, buf.value)
            return False
        return True

    user32.EnumWindows(cb, 0)
    if target is None:
        return f"no window title contains {title_substring!r}"
    hwnd, title = target
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE if minimized
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.2)
    return f"activated: {title} (0x{hwnd:X})"


@mcp.tool()
def desktop_click(x: int, y: int, button: str = "left", clicks: int = 1) -> str:
    """Move the cursor to (x, y) and click. button: left|right|middle."""
    user32.SetCursorPos(x, y)
    time.sleep(0.05)
    down_flags = {"left": 0x0002, "right": 0x0008, "middle": 0x0020}
    up_flags = {"left": 0x0004, "right": 0x0010, "middle": 0x0040}
    down = down_flags.get(button)
    up = up_flags.get(button)
    if down is None or up is None:
        return f"unsupported button: {button}"
    entries = []
    for _ in range(max(1, clicks)):
        entries.append(_mouse_event(down))
        entries.append(_mouse_event(up))
    _send_input(entries)
    return f"clicked {button} at {x},{y} (x{clicks})"


@mcp.tool()
def desktop_move(x: int, y: int) -> str:
    """Move the cursor to absolute (x, y)."""
    user32.SetCursorPos(x, y)
    return f"cursor -> {x},{y}"


@mcp.tool()
def desktop_type(text: str) -> str:
    """Type Unicode text (Chinese/English) into the focused window."""
    if not text:
        return "nothing to type"
    entries = []
    for ch in text:
        entries.append(_key_event(0, unicode_char=ch))
        entries.append(_key_event(0, keyup=True, unicode_char=ch))
    _send_input(entries)
    return f"typed {len(text)} chars"


def _resolve_vk(name: str):
    """Resolve a key name to a Windows virtual-key code. Supports named keys,
    single ASCII letters/digits (a-z, A-Z, 0-9) and raw vk_XX hex."""
    n = name.strip().lower()
    if n.startswith("vk_"):
        try:
            return int(n[3:], 16)
        except ValueError:
            return None
    if n in VK:
        return VK[n]
    if len(n) == 1 and (n.isalpha() or n.isdigit()):
        return ord(n.upper())
    return None


@mcp.tool()
def desktop_key(key: str) -> str:
    """Press a named key once (enter/esc/tab/space/up/down/left/right/f1..f12/delete/...)."""
    vk = _resolve_vk(key)
    if vk is None:
        return f"unknown key: {key}"
    _send_input([_key_event(vk), _key_event(vk, keyup=True)])
    return f"pressed {key}"


@mcp.tool()
def desktop_hotkey(combo: str) -> str:
    """Press a modifier+key combo, e.g. 'ctrl+shift+t' or 'alt+tab' or 'ctrl+p'."""
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    if not parts:
        return "empty combo"
    mods = []
    for p in parts[:-1]:
        m = _resolve_vk(p)
        if m is None:
            return f"unknown modifier: {p}"
        mods.append(m)
    fk = _resolve_vk(parts[-1])
    if fk is None:
        return f"unknown key: {parts[-1]}"
    entries = [_key_event(m) for m in mods]
    entries.append(_key_event(fk))
    entries.append(_key_event(fk, keyup=True))
    entries.extend(_key_event(m, keyup=True) for m in reversed(mods))
    _send_input(entries)
    return f"sent {combo}"


@mcp.tool()
def desktop_scroll(delta_x: int, delta_y: int, x: int | None = None, y: int | None = None) -> str:
    """Scroll the wheel (delta_y units of 120, e.g. 120 = wheel up, -120 = down)."""
    if x is not None and y is not None:
        user32.SetCursorPos(x, y)
        time.sleep(0.05)
    data = -delta_y * WHEEL_DELTA  # mcp 语义：+y = 向下滚动（与鼠标 wheel down 一致）
    _send_input([_mouse_event(0x0800, data=data)])  # MOUSEEVENTF_WHEEL
    return f"scrolled dx={delta_x} dy={delta_y}"


@mcp.tool()
def desktop_uia_tree(title_substring: str, depth: int = 3, max_items: int = 150) -> str:
    """List the UI Automation control tree of a window as TEXT (no screenshot, no vision tokens).
    Returns visible controls with name/type/enabled/rect. Prefer this over screenshots."""
    return _uia({"action": "tree", "title": title_substring, "depth": depth, "max": max_items})


@mcp.tool()
def desktop_uia_find(title_substring: str, name: str, control_type: str | None = None) -> str:
    """Locate one control by name inside a window (optional control_type: Button/Edit/Text/...).
    Returns its name/type/enabled/rect/value without touching the mouse."""
    return _uia({"action": "find", "title": title_substring, "name": name, "control_type": control_type or ""})


@mcp.tool()
def desktop_uia_click(title_substring: str, name: str, control_type: str | None = None) -> str:
    """Activate a control by name via UIA (Invoke/Select/Toggle/ExpandCollapse) — NO physical mouse.
    Falls back automatically to desktop_click with rect coordinates only if no pattern exists."""
    return _uia({"action": "click", "title": title_substring, "name": name, "control_type": control_type or ""})


@mcp.tool()
def desktop_uia_setvalue(title_substring: str, name: str, value: str, control_type: str = "Edit") -> str:
    """Set text into a control via ValuePattern — no keyboard simulation, mouse untouched."""
    return _uia({"action": "setvalue", "title": title_substring, "name": name, "control_type": control_type, "value": value})


@mcp.tool()
def desktop_uia_getvalue(title_substring: str, name: str, control_type: str | None = None) -> str:
    """Read the current value of a control (ValuePattern)."""
    return _uia({"action": "getvalue", "title": title_substring, "name": name, "control_type": control_type or ""})


@mcp.tool()
def desktop_uia_read_text(title_substring: str, name: str, max_chars: int = 1500, control_type: str | None = None) -> str:
    """Read visible text content of a control (TextPattern) — replace screenshots for reading UI text."""
    return _uia({"action": "text", "title": title_substring, "name": name, "control_type": control_type or "", "max_chars": max_chars})


@mcp.tool()
def desktop_uia_scroll(title_substring: str, name: str, direction: str, amount: str = "small", control_type: str | None = None) -> str:
    """Scroll a scrollable control via ScrollPattern (direction: up/down/left/right, amount: small/large)."""
    return _uia({"action": "scroll", "title": title_substring, "name": name, "control_type": control_type or "", "direction": direction, "amount": amount})




# ─────────────────────── computer-use contract layer (c021) ───────────────────────
# Ported RULES (not code) from a macOS-side computer-use contract kit; the mechanisms
# are Windows shapes. Three rules drive everything below:
#   1. delivery is not effect — every mutating call returns a typed verdict;
#   2. an expectation is evidence only if it newly appeared (absent before, present after);
#   3. coordinates belong to the frame they were read from — a stale frame is refused.
#
# Two measured corrections to the source kit, both from this machine (2026-10-19):
#   * an exact screenshot hash is too brittle as a quiescence/binding signal — a blinking
#     caret or a desktop overlay changes a window's bytes while nothing meaningful moved
#     (observed: 9 samples, 6.3 s, "still moving: pixels" on a quiet window). So the pixel
#     evidence is a COARSE signature (sampled luminance grid, quantized) plus a reported
#     delta; the exact sha256 is kept and reported, but it does not decide anything alone.
#   * a readback must use a channel that can actually see the text: ValuePattern, then
#     TextPattern, then the element tree — and "no channel could read it" is `unverifiable`,
#     never `not-met`.
# Learned-signature compliance (k-0092 / k-0095): an unreadable signal is never coerced into
# the neighbouring meaning — an unavailable pixel signal is reported as unavailable and cannot
# make a window look settled.

import hashlib as _hashlib
from collections import Counter as _Counter

# The UIA helper is resolved next to this module (line 27). A candidate copy therefore cannot
# observe anything where it lives, which is exactly where the closed loop wants it tested.
# DSH_UIA_HELPER lets a candidate run against its own copy; unset means "unchanged behaviour".
if os.environ.get("DSH_UIA_HELPER"):
    _UIA_SCRIPT = os.environ["DSH_UIA_HELPER"]

_CUA_LEASE_DIR = os.environ.get("DSH_CUA_LEASE_DIR") or os.path.join(
    os.path.expanduser("~"), ".dsh", "computer-use", "leases")
_CUA_LEASE_TTL = 30.0            # seconds before another owner may take over
_CUA_PIXEL_TOLERANCE = 1.5       # mean |cell delta| (0-255) still counted as "the same frame"
_CUA_LAST = {}                   # hwnd -> last observation (evidence for diff/verdicts)
_CUA_PIXEL_UNAVAILABLE = "unavailable"

_CUA_SHOT_DIR = os.environ.get("DSH_CUA_SCREENSHOT_DIR") or os.path.join(
    os.path.expanduser("~"), ".dsh", "mcp", "desktop", "screenshots")

try:  # pid of a window, for a per-window lease key
    user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
except Exception:  # noqa: BLE001
    pass


def _cua_clip(value, limit=200):
    text = "" if value is None else str(value)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _cua_window_region(hwnd):
    rect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return {"left": rect.left, "top": rect.top,
            "width": max(1, rect.right - rect.left),
            "height": max(1, rect.bottom - rect.top)}


_CUA_MOVED_CELLS = 12         # cells whose luminance jumped by _CUA_CELL_JUMP or more
_CUA_CELL_JUMP = 32


def _cua_cells_from_shot(shot, cols=48, rows=27):
    """Sampled luminance grid of one already-captured mss shot: cols x rows cells, each the mean
    of a 2x2 block. A real grid (not one mean per row) is what makes a small moving object
    visible: a 36x36 square changes ~16 cells by ~200 levels while a blinking caret changes one
    or two cells, so the jump COUNT separates "something moved" from "a caret blinked"."""
    width, height = shot.size
    data = shot.rgb
    cells = []
    for row in range(rows):
        y0 = min(height - 1, int((row + 0.5) * height / rows))
        for col in range(cols):
            x0 = min(width - 1, int((col + 0.5) * width / cols))
            total = 0
            counted = 0
            for dy in (0, 1):
                y = min(height - 1, y0 + dy)
                base = y * width * 3
                for dx in (0, 1):
                    x = min(width - 1, x0 + dx)
                    index = base + x * 3
                    total += data[index] + data[index + 1] + data[index + 2]
                    counted += 3
            cells.append(int(total / counted))
    return cells


def _cua_count_moved_cells(before_cells, after_cells, jump=None):
    """How many cells changed by a large amount. Answers "did something move", which the mean
    difference alone cannot: a small object barely shifts the mean but lights up its own cells."""
    jump = _CUA_CELL_JUMP if jump is None else jump
    if not before_cells or not after_cells or len(before_cells) != len(after_cells):
        return None
    return sum(1 for a, b in zip(before_cells, after_cells) if abs(a - b) >= jump)


def _cua_pixel_state(hwnd, cols=48, rows=27):
    """Pixel evidence for one window, two ways:
      * `cells` - sampled luminance grid; tolerant to carets and overlays, immune to noise;
      * `exact` - sha256 of the PNG; answers 'byte-identical', which a caret breaks.
    Returns ('ok', exact, cells) or ('unavailable', reason, None)."""
    try:
        import mss
        from mss.tools import to_png

        with mss.mss() as sct:
            shot = sct.grab(_cua_window_region(hwnd))
            exact = _hashlib.sha256(to_png(shot.rgb, shot.size)).hexdigest()
        cells = _cua_cells_from_shot(shot, cols, rows)
        return "ok", exact, cells
    except Exception as exc:  # noqa: BLE001
        return _CUA_PIXEL_UNAVAILABLE, _cua_clip(exc, 120), None


def _cua_frame_id(cells):
    """Stable frame identity: cell luminances quantized into 32 bands so a caret, an
    anti-aliasing flicker or a soft overlay does not mint a new frame."""
    if cells is None:
        return _CUA_PIXEL_UNAVAILABLE
    banded = bytes(min(31, cell // 8) for cell in cells)
    return _hashlib.sha256(banded).hexdigest()[:16]


def _cua_pixel_delta(before_cells, after_cells):
    """Mean absolute luminance difference over the sampled grid (0-255), or None."""
    if not before_cells or not after_cells or len(before_cells) != len(after_cells):
        return None
    return round(sum(abs(a - b) for a, b in zip(before_cells, after_cells)) / len(before_cells), 2)


def _cua_rect_key(rect):
    parts = []
    for piece in str(rect or "").replace(";", ",").split(","):
        try:
            parts.append(str(int(float(piece.strip()))))
        except Exception:  # noqa: BLE001
            parts.append(piece.strip())
    return ",".join(parts)


def _cua_fingerprint(item):
    """role + name + enabled + rounded frame: order-independent element identity."""
    return "{}|{}|{}|{}".format(item.get("type") or "", item.get("name") or "",
                                item.get("en"), _cua_rect_key(item.get("rect")))


def _cua_revision(items):
    fingerprints = sorted(_cua_fingerprint(item) for item in items)
    return _hashlib.sha256("\n".join(fingerprints).encode("utf-8")).hexdigest()


def _cua_contains(observation, needle):
    """Literal match first, then whitespace-normalized: a literal miss alone is a known
    false negative (the text can land with different spacing), and retyping would duplicate it."""
    if not needle:
        return False
    haystack = "\n".join(observation.get("lines") or [])
    if needle in haystack:
        return True
    return " ".join(needle.split()) in " ".join(haystack.split())


def _cua_observe(title_substring, depth=6, max_items=400):
    """One observation of a window: element fingerprints, content revision, pixel evidence."""
    reply = _uia({"action": "tree", "title": title_substring, "depth": depth, "max": max_items})
    try:
        data = json.loads(reply)
    except Exception:  # noqa: BLE001
        return {"ok": False, "reason": "the UIA reply was not JSON: " + _cua_clip(reply, 200)}
    if not data.get("ok"):
        return {"ok": False, "reason": str(data.get("msg") or "the UIA tree could not be read")}
    found = _find_window(title_substring)
    if found is None:
        return {"ok": False, "reason": "the window disappeared while it was being observed: " + title_substring}
    hwnd, opened_title = found
    items = data.get("items") or []
    pixel_state, exact, cells = _cua_pixel_state(hwnd)
    return {
        "ok": True,
        "window": data.get("window") or opened_title,
        "hwnd": int(hwnd),
        "elements": len(items),
        "tree_readable": len(items) > 0,
        "revision": _cua_revision(items)[:16],
        "pixel_state": pixel_state,
        "pixel_id": exact,
        "frame_id": _cua_frame_id(cells),
        "cells": cells,
        "lines": ["{} {}".format(item.get("type") or "", item.get("name") or "") for item in items],
        "items": items,
        "at": time.time(),
    }


def _cua_lease_key(hwnd):
    pid = wt.DWORD()
    try:
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        owner_pid = int(pid.value)
    except Exception:  # noqa: BLE001
        owner_pid = 0
    return "win-{}-{}".format(owner_pid, int(hwnd))


def _cua_lease_owner():
    return os.environ.get("DSH_SESSION_ID") or "pid:{}".format(os.getpid())


def _cua_lease_path(key):
    safe = "".join(ch if (ch.isalnum() or ch in "-_") else "-" for ch in key)
    return os.path.join(_CUA_LEASE_DIR, safe + ".json")


_CUA_MUTEX_PREFIX = os.environ.get("DSH_CUA_MUTEX_PREFIX") or "Global\\DSH-CUA-win-"
_WAIT_OBJECT_0 = 0x00000000
_WAIT_ABANDONED = 0x00000080
_WAIT_TIMEOUT = 0x00000102
_kernel32 = ctypes.windll.kernel32
_kernel32.CreateMutexW.restype = wt.HANDLE
_kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wt.BOOL, wt.LPCWSTR]
_kernel32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
_kernel32.WaitForSingleObject.restype = wt.DWORD
_kernel32.ReleaseMutex.argtypes = [wt.HANDLE]
_kernel32.ReleaseMutex.restype = wt.BOOL


def _cua_mutex_name(hwnd):
    return "{}{}".format(_CUA_MUTEX_PREFIX, int(hwnd))


def _cua_mutex_acquire(hwnd):
    """Kernel-enforced exclusion on one window. Identity plays no part: holding the mutex is the
    right to act, and the kernel releases it when the holder dies - so a crashed holder is taken
    over immediately (WAIT_ABANDONED) instead of blocking everyone until a TTL expires."""
    name = _cua_mutex_name(hwnd)
    handle = _kernel32.CreateMutexW(None, False, name)
    if not handle:
        return {"ok": False, "reason": "CreateMutex failed (error {})".format(ctypes.GetLastError())}
    waited = _kernel32.WaitForSingleObject(handle, 0)
    if waited in (_WAIT_OBJECT_0, _WAIT_ABANDONED):
        return {"ok": True, "handle": int(handle), "name": name,
                "took_over_abandoned": waited == _WAIT_ABANDONED}
    _kernel32.CloseHandle(handle)
    if waited == _WAIT_TIMEOUT:
        return {"ok": False, "busy": True, "contended": True, "name": name,
                "reason": "another process holds this window (kernel mutex {}); nothing was delivered".format(name)}
    return {"ok": False, "reason": "WaitForSingleObject returned 0x{:X}".format(waited)}


def _cua_mutex_release(handle):
    if not handle:
        return True
    try:
        _kernel32.ReleaseMutex(wt.HANDLE(handle))
        return True
    except Exception:  # noqa: BLE001
        return False
    finally:
        try:
            _kernel32.CloseHandle(wt.HANDLE(handle))
        except Exception:  # noqa: BLE001
            pass


def _cua_label_owner(session_tag=""):
    return session_tag or os.environ.get("DSH_SESSION_ID") or "pid:{}".format(os.getpid())


def _cua_label_write(hwnd, session_tag=""):
    """A best-effort note of who is acting. It is never consulted for exclusion."""
    try:
        os.makedirs(_CUA_LEASE_DIR, exist_ok=True)
        payload = {"key": _cua_lease_key(hwnd), "hwnd": int(hwnd),
                   "label": _cua_label_owner(session_tag), "pid": os.getpid(), "at": time.time()}
        with open(_cua_lease_path(_cua_lease_key(hwnd)), "w", encoding="utf-8") as label_file:
            json.dump(payload, label_file)
        return True
    except OSError:
        return False


def _cua_label_remove(hwnd):
    try:
        os.remove(_cua_lease_path(_cua_lease_key(hwnd)))
        return True
    except OSError:
        return True


def _cua_lease_acquire(hwnd):
    """One-sided defence: our own agent sessions honour the lease; nothing can force another
    vendor's agent to. It is politeness inside this host, not a mutex."""
    try:
        os.makedirs(_CUA_LEASE_DIR, exist_ok=True)
    except OSError as exc:
        return {"ok": False, "reason": "lease directory unavailable: " + _cua_clip(exc, 120)}
    key = _cua_lease_key(hwnd)
    path = _cua_lease_path(key)
    payload = {"key": key, "owner": _cua_lease_owner(), "at": time.time()}
    for _attempt in (1, 2):
        try:
            handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            held, unreadable = None, False
            try:
                with open(path, encoding="utf-8") as existing:
                    held = json.load(existing)
            except Exception:  # noqa: BLE001
                unreadable = True
            if unreadable:
                # An unreadable lease is neither "free" nor "expired": report and stop.
                return {"ok": False, "busy": True, "contended": True, "key": key,
                        "reason": "a lease file exists but could not be read ({}); refusing to take it over".format(path)}
            holder = (held or {}).get("owner") or "unknown"
            age = time.time() - float((held or {}).get("at") or 0.0)
            if holder == _cua_lease_owner():
                return {"ok": True, "key": key, "note": "this session already holds the lease"}
            if age > _CUA_LEASE_TTL:
                try:
                    os.remove(path)
                except OSError:
                    pass
                continue
            return {"ok": False, "busy": True, "contended": True, "key": key, "holder": holder,
                    "held_for_s": round(age, 1),
                    "reason": "busy - held by {} for {} s; nothing was delivered".format(holder, round(age, 1))}
        except OSError as exc:
            return {"ok": False, "reason": "lease could not be created: " + _cua_clip(exc, 120)}
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as out:
                json.dump(payload, out)
            return {"ok": True, "key": key}
        except OSError as exc:
            return {"ok": False, "reason": "lease could not be written: " + _cua_clip(exc, 120)}
    return {"ok": False, "busy": True, "contended": True, "key": key,
            "reason": "the lease could not be taken even after taking over an expired one"}


def _cua_lease_release(hwnd):
    path = _cua_lease_path(_cua_lease_key(hwnd))
    try:
        with open(path, encoding="utf-8") as held_file:
            held = json.load(held_file)
    except FileNotFoundError:
        return True
    except Exception:  # noqa: BLE001
        return False
    if (held or {}).get("owner") != _cua_lease_owner():
        return False
    try:
        os.remove(path)
        return True
    except OSError:
        return False


def _cua_read_text(title_substring, control_name):
    """Read the named control's text through whichever channel can see it.
    Returns (source, text) with source in ValuePattern / TextPattern, or (None, None)."""
    if not control_name:
        return None, None
    value = _uia({"action": "getvalue", "title": title_substring, "name": control_name, "control_type": ""})
    try:
        parsed = json.loads(value)
    except Exception:  # noqa: BLE001
        parsed = {}
    if parsed.get("ok") and parsed.get("value") is not None:
        return "ValuePattern", str(parsed["value"])
    text = _uia({"action": "text", "title": title_substring, "name": control_name,
                 "control_type": "", "max_chars": 600})
    try:
        parsed = json.loads(text)
    except Exception:  # noqa: BLE001
        parsed = {}
    if parsed.get("ok") and parsed.get("text") is not None:
        return "TextPattern", str(parsed["text"])
    return None, None


def _cua_wait_stable(title_substring, stable_ms=400, timeout_ms=6000, interval_ms=150,
                     depth=6, max_items=400, tolerance=None):
    """Measured quiescence: the element tree AND the coarse pixel signature must both stop
    moving. Two samples are the floor - one slow observation can already outlast stable_ms and
    fake a quiet window. Never claims to have waited when it could not settle."""
    tolerance = _CUA_PIXEL_TOLERANCE if tolerance is None else tolerance
    started = time.time()
    samples = 0
    last_change = started
    last_moving = "none"
    previous = None
    final = None
    moved_cells = None
    while True:
        current = _cua_observe(title_substring, depth, max_items)
        samples += 1
        if not current.get("ok"):
            return {"settled": False, "samples": samples, "reason": current.get("reason")}
        final = current
        if previous is not None:
            moving = []
            if previous["revision"] != current["revision"]:
                moving.append("tree")
            if previous["pixel_state"] == "ok" and current["pixel_state"] == "ok":
                delta = _cua_pixel_delta(previous["cells"], current["cells"])
                moved_cells = _cua_count_moved_cells(previous["cells"], current["cells"])
                if (delta is not None and delta > tolerance) or \
                        (moved_cells is not None and moved_cells >= _CUA_MOVED_CELLS):
                    moving.append("pixels")
            if moving:
                last_change = time.time()
                last_moving = "+".join(moving)
        previous = current
        now = time.time()
        waited_ms = int((now - started) * 1000)
        pixel_signal = "ok" if current["pixel_state"] == "ok" else _CUA_PIXEL_UNAVAILABLE
        base = {"samples": samples, "waited_ms": waited_ms, "last_moving_signal": last_moving,
                "pixel_signal": pixel_signal, "pixel_tolerance": tolerance,
                "moved_cells": moved_cells, "moved_cells_threshold": _CUA_MOVED_CELLS,
                "revision": current["revision"], "frame_id": current["frame_id"],
                "pixel_id": current["pixel_id"]}
        if samples >= 2 and (now - last_change) * 1000 >= stable_ms:
            base["settled"] = True
            if pixel_signal != "ok":
                base["caveat"] = ("the pixel signal was unavailable, so this settled on the element "
                                  "tree alone - an animated window can still be moving")
            base["_observation"] = final
            return base
        if waited_ms >= timeout_ms:
            base["settled"] = False
            base["reason"] = "still moving after {} ms (last moving signal: {})".format(waited_ms, last_moving)
            base["_observation"] = final
            return base
        time.sleep(max(1, interval_ms) / 1000.0)


@mcp.tool()
def desktop_observe(title_substring: str, depth: int = 6, max_items: int = 400,
                    include_items: bool = False) -> str:
    """Read one observation of a window: element count, content revision, pixel evidence.
    revision answers "did the structure change". frame_id is the tolerant pixel identity and
    is what you pass back as screenshot_id to bind an action to this frame; pixel_id is the
    exact byte hash (a blinking caret changes it, so it decides nothing on its own).
    None of them says WHAT the content is - read text for that. Also stores the observation
    as the baseline for desktop_diff_window."""
    observation = _cua_observe(title_substring, depth, max_items)
    if not observation.get("ok"):
        return json.dumps({"ok": False, "reason": observation.get("reason")}, ensure_ascii=False)
    _CUA_LAST[observation["hwnd"]] = observation
    payload = {"ok": True, "window": observation["window"], "elements": observation["elements"],
               "tree_readable": observation["tree_readable"],
               "revision": observation["revision"], "frame_id": observation["frame_id"],
               "pixel_id": observation["pixel_id"], "pixel_state": observation["pixel_state"],
               "note": "revision = structure changed; frame_id = tolerant pixel identity "
                       "(use as screenshot_id); pixel_id = exact bytes"}
    if not observation["tree_readable"]:
        payload["caveat"] = ("the element tree is empty (a UWP/XAML window exposes none to UIA2), so the "
                             "revision is a constant and no text verdict is possible here; judge this "
                             "window by the pixel signature")
    if observation["pixel_state"] != "ok":
        payload["caveat"] = "the pixel signal is unavailable here; only the element tree is evidence"
    if include_items:
        payload["items"] = observation["items"][:max_items]
    return json.dumps(payload, ensure_ascii=False)


@mcp.tool()
def desktop_diff_window(title_substring: str, depth: int = 6, max_items: int = 400) -> str:
    """What changed since the previous observation of this window: structural diff (role+name+
    rounded rect), text diff, and the pixel delta. Order alone is not a change; element
    identity, not index."""
    observation = _cua_observe(title_substring, depth, max_items)
    if not observation.get("ok"):
        return json.dumps({"ok": False, "reason": observation.get("reason")}, ensure_ascii=False)
    hwnd = observation["hwnd"]
    previous = _CUA_LAST.get(hwnd)
    if previous is None:
        _CUA_LAST[hwnd] = observation
        return json.dumps({"ok": False, "reason": "no previous observation of this window; "
                                                  "this call is now the baseline, ask again after the action"},
                          ensure_ascii=False)
    before_elements = _Counter(_cua_fingerprint(item) for item in previous["items"])
    after_elements = _Counter(_cua_fingerprint(item) for item in observation["items"])
    before_text = _Counter(previous["lines"])
    after_text = _Counter(observation["lines"])
    elements_added = list((after_elements - before_elements).elements())
    elements_removed = list((before_elements - after_elements).elements())
    text_added = list((after_text - before_text).elements())
    text_removed = list((before_text - after_text).elements())
    delta = _cua_pixel_delta(previous.get("cells"), observation.get("cells"))
    _CUA_LAST[hwnd] = observation
    return json.dumps({
        "ok": True,
        "window": observation["window"],
        "changed": bool(elements_added or elements_removed),
        "structure": {"added": len(elements_added), "removed": len(elements_removed),
                      "elements_before": previous["elements"], "elements_after": observation["elements"]},
        "elements": {"added": elements_added[:8], "removed": elements_removed[:8]},
        "text": {"added": text_added[:8], "removed": text_removed[:8]},
        "revision": {"before": previous["revision"], "after": observation["revision"]},
        "pixels": {"delta": delta, "frame_before": previous["frame_id"],
                   "frame_after": observation["frame_id"],
                   "state": observation["pixel_state"]},
    }, ensure_ascii=False)


@mcp.tool()
def desktop_wait_stable(title_substring: str, stable_ms: int = 400, timeout_ms: int = 6000,
                        interval_ms: int = 150, tolerance: float = 0.0,
                        depth: int = 6, max_items: int = 400) -> str:
    """Wait for MEASURED quiescence instead of a fixed sleep: the element tree and the coarse
    pixel signature must both stop moving. Reports sample count, which signal moved last, and
    the pixel tolerance used; says so when it could not settle (never pretends it waited).
    tolerance<=0 uses the module default."""
    result = _cua_wait_stable(title_substring, max(0, stable_ms), max(0, timeout_ms),
                              max(1, interval_ms), depth, max_items,
                              tolerance if tolerance > 0 else None)
    result.pop("_observation", None)
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
def desktop_click_verified(x: int, y: int, title_substring: str = "", expect_text: str = "",
                           screenshot_id: str = "", button: str = "left", clicks: int = 1,
                           stable_ms: int = 400, timeout_ms: int = 6000,
                           session_tag: str = "") -> str:
    """Click with a typed verdict. ok (delivered) is NOT verified (effect observed).
    expect_text must be ABSENT before and PRESENT after - that incremental criterion is the
    only thing that turns a click into evidence; an expectation already on screen is rejected
    as invalid rather than counted as a pass. screenshot_id binds the coordinates to the frame
    they were read from (use frame_id from desktop_observe; the exact pixel_id is accepted
    too): a different frame is refused and nothing is delivered. Exclusion is a KERNEL named
    mutex on the window, so a second process - of any session - is refused; session_tag is only a
    label for the record and never decides."""
    if not title_substring:
        delivered = desktop_click(x, y, button, clicks)
        return json.dumps({"ok": True, "verified": False, "effect": "unverifiable",
                           "verification_required": True, "delivered": delivered,
                           "reason": "no window was named, so nothing could be observed; "
                                     "re-observe before retrying, do not blind-retry"},
                          ensure_ascii=False)
    before = _cua_observe(title_substring)
    if not before.get("ok"):
        return json.dumps({"ok": False, "effect": "not-delivered", "verification_required": True,
                           "reason": "the target window could not be observed: " + str(before.get("reason"))},
                          ensure_ascii=False)
    hwnd = before["hwnd"]
    if screenshot_id:
        if before["pixel_state"] != "ok":
            return json.dumps({"ok": False, "effect": "not-delivered", "verification_required": True,
                               "reason": "a screenshot_id was supplied but the pixel signal is unavailable, "
                                         "so the binding cannot be checked; refusing rather than assuming"},
                              ensure_ascii=False)
        if screenshot_id not in (before["frame_id"], before["pixel_id"]):
            return json.dumps({"ok": False, "effect": "not-delivered", "stale_capture": True,
                               "verification_required": True,
                               "reason": "screenshot_id {} is not this frame (frame_id now {}, "
                                         "pixel_id now {}); re-observe and re-read the coordinates".format(
                                             _cua_clip(screenshot_id, 24), before["frame_id"],
                                             _cua_clip(before["pixel_id"], 16))},
                              ensure_ascii=False)
    gate = _cua_mutex_acquire(hwnd)
    if not gate.get("ok"):
        return json.dumps({"ok": False, "effect": "not-delivered", "busy": True,
                           "contended": bool(gate.get("contended")), "mutex": gate.get("name"),
                           "reason": gate.get("reason"), "verification_required": True},
                          ensure_ascii=False)
    _cua_label_write(hwnd, session_tag)
    try:
        had_expect_before = _cua_contains(before, expect_text)
        delivered = desktop_click(x, y, button, clicks)
        stable = _cua_wait_stable(title_substring, max(0, stable_ms), max(0, timeout_ms), 150)
        after = stable.pop("_observation", None) or _cua_observe(title_substring)
        appeared = _cua_contains(after, expect_text) if expect_text else False
        if not expect_text:
            effect, verified = "unverifiable", False
            reason = "no expect_text was declared, so delivery cannot be judged; re-observe instead of retrying"
        elif not before["tree_readable"]:
            effect, verified = "unverifiable", False
            reason = ("the element tree is empty, so no text verdict is possible; the pixel signal is the only "
                      "evidence here (frame {} -> {}). Do not read this as \"the click missed\""
                      .format(_cua_clip(before["frame_id"], 16), _cua_clip(after.get("frame_id"), 16)))
        elif had_expect_before:
            effect, verified = "invalid-expectation", False
            reason = ('"{}" was already present before the action, so it is not evidence; '
                      "pick a string that only appears afterwards".format(_cua_clip(expect_text, 60)))
        elif appeared:
            effect, verified = "verified", True
            reason = '"{}" newly appeared'.format(_cua_clip(expect_text, 60))
        else:
            effect, verified = "not-met", False
            reason = ('"{}" did not newly appear; the click may have missed (coordinates are '
                      "window-local?) or the window did not repaint in time".format(_cua_clip(expect_text, 60)))
        return json.dumps({
            "ok": True, "verified": verified, "effect": effect,
            "verification_required": not verified, "delivered": delivered,
            "settled": stable.get("settled"), "samples": stable.get("samples"),
            "waited_ms": stable.get("waited_ms"), "last_moving_signal": stable.get("last_moving_signal"),
            "pixel_signal": stable.get("pixel_signal"),
            "revision": {"before": before["revision"], "after": after.get("revision")},
            "elements": {"before": before["elements"], "after": after.get("elements")},
            "tree_readable": before["tree_readable"],
            "pixel_changed": before["frame_id"] != after.get("frame_id"),
            "took_over_abandoned": gate.get("took_over_abandoned"),
            "reason": reason,
        }, ensure_ascii=False)
    finally:
        _cua_label_remove(hwnd)
        _cua_mutex_release(gate.get("handle"))


@mcp.tool()
def desktop_type_verified(text: str, title_substring: str = "", control_name: str = "",
                          expect_text: str = "", stable_ms: int = 300,
                          timeout_ms: int = 5000, session_tag: str = "") -> str:
    """Type text and report success ONLY when a readback channel can show it landed.
    Channels are tried in order: ValuePattern, TextPattern, then the element tree. When no
    channel can read the text the verdict is `unverifiable` - never `not-met` and never a
    pass. A literal miss is retried once as a whitespace-normalized match; the input is never
    sent twice (that would duplicate it)."""
    if not text:
        return json.dumps({"ok": False, "reason": "nothing to type"}, ensure_ascii=False)
    expectation = expect_text or text
    before_source, before_text = _cua_read_text(title_substring, control_name) if title_substring else (None, None)
    before_observed = _cua_observe(title_substring) if title_substring else None
    hwnd = before_observed["hwnd"] if (before_observed and before_observed.get("ok")) else None
    if hwnd is None:
        gate = {"ok": True, "handle": 0}
    else:
        gate = _cua_mutex_acquire(hwnd)
        if not gate.get("ok"):
            return json.dumps({"ok": False, "effect": "not-delivered", "busy": True,
                               "contended": bool(gate.get("contended")), "mutex": gate.get("name"),
                               "reason": gate.get("reason"), "verification_required": True},
                              ensure_ascii=False)
        _cua_label_write(hwnd, session_tag)
    try:
        delivered = desktop_type(text)
        stable = _cua_wait_stable(title_substring, max(0, stable_ms), max(0, timeout_ms), 150) \
            if title_substring else {"settled": None, "samples": 0}
        after_observed = stable.pop("_observation", None) or (
            _cua_observe(title_substring) if title_substring else None)
        readback_source, readback = _cua_read_text(title_substring, control_name) if title_substring else (None, None)
        if readback is None and after_observed and after_observed.get("ok"):
            readback_source, readback = "element tree", "\n".join(after_observed["lines"])
        match = "none"
        if readback is not None:
            if expectation in str(readback):
                match = "literal"
            elif " ".join(expectation.split()) in " ".join(str(readback).split()):
                match = "whitespace-normalized"
        already_present = False
        if before_text is not None and expectation in str(before_text):
            already_present = True
        elif before_observed and before_observed.get("ok") and _cua_contains(before_observed, expectation):
            already_present = True
        if not readback:
            effect, verified = "unverifiable", False
            reason = ("no readback channel could read this control (ValuePattern, TextPattern and "
                      "the element tree all came back empty - a UWP/XAML window exposes no tree to "
                      "UIA2); re-observe before retrying, and do not retype blindly")
        elif already_present:
            effect, verified = "invalid-expectation", False
            reason = ('"{}" was already in the readback before typing, so it cannot be evidence; '
                      "name the control and the expected value explicitly".format(_cua_clip(expectation, 60)))
        elif match != "none":
            effect, verified = "verified", True
            reason = "readback matched ({}) via {}".format(match, readback_source)
        else:
            effect, verified = "not-met", False
            reason = "the typed text did not appear in the readback; do NOT retype blindly - re-observe first"
        return json.dumps({
            "ok": True, "verified": verified, "effect": effect,
            "verification_required": not verified, "delivered": delivered,
            "readback_source": readback_source,
            "readback": _cua_clip(readback, 200) if readback is not None else None,
            "settled": stable.get("settled"), "samples": stable.get("samples"),
            "pixel_signal": stable.get("pixel_signal"),
            "reason": reason,
        }, ensure_ascii=False)
    finally:
        if hwnd is not None:
            _cua_label_remove(hwnd)
            _cua_mutex_release(gate.get("handle"))


@mcp.tool()
def desktop_lease_status() -> str:
    """Who is driving which window. Exclusion itself is a KERNEL named mutex, so this view has two
    parts per window: the label the holder wrote, and a non-blocking probe of the mutex. A label
    whose mutex is free is reported as `stale_label` - the mutex decides, never the file."""
    entries = []
    try:
        names = sorted(os.listdir(_CUA_LEASE_DIR))
    except FileNotFoundError:
        names = []
    except OSError as exc:  # noqa: BLE001
        return json.dumps({"ok": False, "reason": _cua_clip(exc, 120)}, ensure_ascii=False)
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(_CUA_LEASE_DIR, name)
        try:
            with open(path, encoding="utf-8") as label_file:
                label = json.load(label_file)
        except Exception as exc:  # noqa: BLE001
            entries.append({"key": name[:-5], "unreadable": _cua_clip(exc, 80)})
            continue
        hwnd = label.get("hwnd")
        held = None
        if isinstance(hwnd, int):
            probe = _cua_mutex_acquire(hwnd)
            if probe.get("ok"):
                held = False
                _cua_mutex_release(probe.get("handle"))
            else:
                held = bool(probe.get("busy"))
        entries.append({"key": label.get("key") or name[:-5],
                        "label": label.get("label"), "pid": label.get("pid"),
                        "held_for_s": round(time.time() - float(label.get("at") or 0.0), 1),
                        "held": held, "stale_label": held is False})
    return json.dumps({"ok": True, "mechanism": "kernel named mutex",
                       "mutex_prefix": _CUA_MUTEX_PREFIX, "label_dir": _CUA_LEASE_DIR,
                       "count": len(entries), "leases": entries}, ensure_ascii=False)
# ───────────────────── end computer-use contract layer (c021) ─────────────────────




# ─────────────────── computer-use first-contact probe (c022) ───────────────────
# Route an app you have never driven before. Three probes, cheapest first, READ-ONLY by
# default; steps 2 and 3 need an explicit confirmation and are undone afterwards.
# The rule the source kit learned the hard way is kept: the verdict depends on the element
# you pick, so the element is named by the caller, never auto-chosen.
#
# Windows routes (not the macOS ones):
#   uia-name   tree readable and a click moves the content -> address controls by UIA name,
#              window-local pixels as the fallback
#   keyboard   tree readable but the click is inert -> drive by keyboard and verify by readback
#   dom        no tree, or a Chromium/Electron surface that ignores synthetic input ->
#              drive the renderer through Playwright, verify by DOM text
#   vision     no tree and no input evidence -> pixels only: capture, click, verify by delta

_CUA_CHROMIUM_EXES = {
    "chrome.exe", "msedge.exe", "brave.exe", "opera.exe", "vivaldi.exe",
    "chromium.exe", "thorium.exe", "arc.exe", "yandex.exe",
}
_CUA_ELECTRON_MARKERS = ("resources\\app.asar", "libegl.dll", "v8_context_snapshot.bin", "icudtl.dat")
_CUA_CHROMIUM_MARKERS = ("chrome_100_percent.pak", "chrome_200_percent.pak", "chrome_elf.dll")


def _cua_window_pid(hwnd):
    pid = wt.DWORD()
    try:
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return int(pid.value)
    except Exception:  # noqa: BLE001
        return 0


def _cua_process_exe(pid):
    """Full image path of a pid, or None. Evidence, not a guess from the window title."""
    if not pid:
        return None
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.restype = wt.HANDLE
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        size = wt.DWORD(2048)
        buffer = ctypes.create_unicode_buffer(2048)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return buffer.value
        return None
    finally:
        kernel32.CloseHandle(handle)


def _cua_child_pid_different_from(hwnd, owner_pid):
    """A packaged (UWP) app's window belongs to the frame host; the app itself owns a child window."""
    candidates = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def callback(child, lparam):
        try:
            if not user32.IsWindowVisible(child):
                return True
            pid = wt.DWORD()
            user32.GetWindowThreadProcessId(child, ctypes.byref(pid))
            if pid.value and int(pid.value) != owner_pid:
                candidates.append(int(pid.value))
        except Exception:  # noqa: BLE001
            pass
        return True

    try:
        user32.EnumChildWindows(hwnd, callback, 0)
    except Exception:  # noqa: BLE001
        return None
    return candidates[0] if candidates else None


def _cua_app_profile(hwnd):
    """Classify an app from evidence its own files carry - never from its name."""
    owner_pid = _cua_window_pid(hwnd)
    pid = owner_pid
    exe = _cua_process_exe(pid)
    evidence = []
    exe_name = ""
    if exe and os.path.basename(exe).lower() in ("applicationframehost.exe", "runtimebroker.exe"):
        child_pid = _cua_child_pid_different_from(hwnd, owner_pid)
        if child_pid:
            child_exe = _cua_process_exe(child_pid)
            evidence.append("window owner is {} (packaged app); the app itself is pid {}"
                            .format(os.path.basename(exe), child_pid))
            if child_exe:
                pid, exe = child_pid, child_exe
        else:
            evidence.append("window owner is {} and no other process owns a visible child window, "
                            "so the app process could not be identified".format(os.path.basename(exe)))
    if exe:
        exe_name = os.path.basename(exe).lower()
        evidence.append("process image {}".format(os.path.basename(exe)))
    directory = os.path.dirname(exe) if exe else ""
    lowered = directory.lower()
    has_electron = False
    has_chromium_files = False
    if directory:
        for marker in _CUA_ELECTRON_MARKERS:
            if os.path.exists(os.path.join(directory, marker)):
                has_electron = True
                evidence.append("ships {}".format(marker))
                break
        for marker in _CUA_CHROMIUM_MARKERS:
            if os.path.exists(os.path.join(directory, marker)):
                has_chromium_files = True
                evidence.append("ships {}".format(marker))
                break
    is_chromium_exe = exe_name in _CUA_CHROMIUM_EXES
    if is_chromium_exe:
        evidence.append("{} is a Chromium-family browser".format(exe_name))
    if "\\windowsapps\\" in lowered:
        evidence.append("packaged app (WindowsApps)")
    if not exe:
        evidence.append("the process image could not be queried")
    return {
        "pid": pid,
        "window_owner_pid": owner_pid,
        "exe": exe,
        "exe_name": exe_name,
        "is_chromium_browser": is_chromium_exe,
        "ships_electron": has_electron,
        "ships_chromium_files": has_chromium_files,
        "chromium_surface": is_chromium_exe or has_electron or has_chromium_files,
        "evidence": evidence,
    }


def _cua_route_verdict(tree_readable, click_changed, key_landed, chromium):
    """Pick an input route from evidence. Never invents a verdict it has not probed."""
    if tree_readable and click_changed is True:
        return {"route": "uia-name", "confidence": "high",
                "reason": "the tree is readable and a click moved the content",
                "next": "address controls by UIA name, fall back to window-local pixel coordinates"}
    if tree_readable and click_changed is False and chromium:
        return {"route": "dom", "confidence": "high",
                "reason": "the tree is readable but a synthetic click did not move a Chromium surface",
                "next": "drive the renderer through Playwright and verify by DOM text"}
    if tree_readable and click_changed is False:
        return {"route": "keyboard", "confidence": "low",
                "reason": "the tree is readable but the click was inert; this control likely wants keyboard input",
                "next": "use keyboard or a ValuePattern write, then verify by reading the value back"}
    if not tree_readable and chromium:
        return {"route": "dom", "confidence": "high",
                "reason": "no readable accessibility tree on a Chromium/Electron surface",
                "next": "drive it through Playwright, verify by DOM text"}
    if not tree_readable and key_landed is True:
        return {"route": "keyboard", "confidence": "low",
                "reason": "no tree, but a keystroke landed",
                "next": "drive it by keyboard and verify every step by reading text back"}
    if not tree_readable:
        return {"route": "vision", "confidence": "low",
                "reason": "no tree and no input evidence: only pixels are left",
                "next": "capture, read coordinates off the image, click, verify by pixel delta plus a text read"}
    return {"route": "unknown", "confidence": "low",
            "reason": "no click probe result yet, so no route can be justified",
            "next": "re-run with confirm=True and element_name=<a representative element>"}


@mcp.tool()
def desktop_probe_app(title_substring: str, confirm: bool = False, element_name: str = "",
                      control_type: str = "", key_probe: str = "~", depth: int = 6,
                      max_items: int = 400) -> str:
    """First-contact probe for an app you have never driven: read the tree, optionally click one
    element you name, optionally type one probe character and undo it, then print a route card
    (uia-name / keyboard / dom / vision) with the evidence behind it.

    READ-ONLY unless confirm=True. Steps 2 and 3 need confirm=True, and the typed probe is
    reverted and read back afterwards. Pass element_name yourself: the verdict depends on which
    element you probe, so a probe on an unrepresentative element yields a correct-but-useless
    answer.
    """
    observation = _cua_observe(title_substring, depth, max_items)
    if not observation.get("ok"):
        return json.dumps({"ok": False, "reason": observation.get("reason")}, ensure_ascii=False)
    hwnd = observation["hwnd"]
    profile = _cua_app_profile(hwnd)
    tree_readable = observation["elements"] > 0

    card = {
        "ok": True,
        "window": observation["window"],
        "app": {"exe": profile["exe"], "chromium_surface": profile["chromium_surface"],
                "is_chromium_browser": profile["is_chromium_browser"],
                "ships_electron": profile["ships_electron"], "evidence": profile["evidence"]},
        "step1_tree": {"readable": tree_readable, "elements": observation["elements"],
                       "revision": observation["revision"], "pixel_signal": observation["pixel_state"]},
        "step2_click": {"ran": False, "reason": "read-only unless confirm=True and element_name is given"},
        "step3_key": {"ran": False, "reason": "read-only unless confirm=True"},
    }

    click_changed = None
    key_landed = None

    if confirm and element_name:
        target = _uia({"action": "find", "title": title_substring, "name": element_name,
                       "control_type": control_type})
        try:
            located = json.loads(target)
        except Exception:  # noqa: BLE001
            located = {"ok": False, "msg": "find reply was not JSON"}
        if not located.get("ok"):
            card["step2_click"] = {"ran": False, "reason": "element not found: " + str(located.get("msg"))}
        else:
            rect = [int(float(part)) for part in located["element"]["rect"].split(",")]
            centre = (rect[0] + rect[2] // 2, rect[1] + rect[3] // 2)
            before = observation
            delivered = desktop_click(centre[0], centre[1])
            settled = _cua_wait_stable(title_substring, 250, 3000, 150, depth, max_items)
            after = settled.pop("_observation", None) or _cua_observe(title_substring, depth, max_items)
            delta = _cua_pixel_delta(before.get("cells"), after.get("cells"))
            click_changed = before["revision"] != after["revision"] or (delta is not None and delta > _CUA_PIXEL_TOLERANCE)
            card["step2_click"] = {
                "ran": True, "element": located["element"].get("name"), "at": centre,
                "delivered": delivered, "changed": click_changed,
                "revision": {"before": before["revision"], "after": after["revision"]},
                "pixel_delta": delta, "settled": settled.get("settled"),
                "caveat": "a change here can be a caret or selection move, not a value change",
            }

    if confirm:
        control = None
        for item in observation.get("items") or []:
            types = (item.get("type") or "").lower()
            if control_type and types != control_type.lower():
                continue
            if types in ("edit", "document", "textbox", "combobox") and item.get("name"):
                control = item["name"]
                break
        if control is None:
            card["step3_key"] = {"ran": False,
                                 "reason": "no text-input control in the tree; a keystroke probe would land somewhere unobserved"}
        else:
            source_before, text_before = _cua_read_text(title_substring, control)
            desktop_activate_window(title_substring)
            time.sleep(0.3)
            located = json.loads(_uia({"action": "find", "title": title_substring, "name": control,
                                       "control_type": control_type}))
            if located.get("ok"):
                rect = [int(float(part)) for part in located["element"]["rect"].split(",")]
                desktop_click(rect[0] + rect[2] // 2, rect[1] + rect[3] // 2)
                time.sleep(0.2)
            desktop_type(key_probe)
            time.sleep(0.4)
            source_after, text_after = _cua_read_text(title_substring, control)
            key_landed = text_after is not None and text_before is not None and text_after != text_before
            restored = None
            if key_landed:
                desktop_hotkey("ctrl+z")
                time.sleep(0.4)
                source_undo, text_undo = _cua_read_text(title_substring, control)
                restored = text_undo is not None and text_undo == text_before
                if not restored:
                    desktop_key("backspace")  # second attempt: one probe char
                    time.sleep(0.3)
                    source_undo2, text_undo2 = _cua_read_text(title_substring, control)
                    restored = text_undo2 is not None and text_undo2 == text_before
            card["step3_key"] = {
                "ran": True, "control": control, "probe": key_probe,
                "readback_channel": source_after or source_before,
                "before": _cua_clip(text_before, 60), "after": _cua_clip(text_after, 60),
                "key_landed": key_landed, "restored": restored,
                "warning": None if restored in (True, None) else "the probe character may remain in the control",
            }

    verdict = _cua_route_verdict(tree_readable, click_changed, key_landed, profile["chromium_surface"])
    card["route"] = verdict
    card["measure"] = "read-only: tree elements, pixel signature; steps 2/3 only with confirm=True"
    return json.dumps(card, ensure_ascii=False, indent=2)
# ──────────────── end computer-use first-contact probe (c022) ────────────────


if __name__ == "__main__":
    mcp.run(transport="stdio")
