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
        save_path = f"C:\\Users\\PC\\.dsh\\mcp\\desktop\\screenshots\\screen-{int(time.time())}.png"
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
    if not save_path:
        save_path = f"C:\\Users\\PC\\.dsh\\mcp\\desktop\\screenshots\\window-{int(time.time())}.png"
    import os

    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    with open(save_path, "wb") as f:
        f.write(png)
    b64 = base64.b64encode(png).decode("ascii")
    return [
        TextContent(type="text", text=f"window screenshot saved: {save_path}"),
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


if __name__ == "__main__":
    mcp.run(transport="stdio")
