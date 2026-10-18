#!/usr/bin/env python3
"""computer-use acceptance runner (Windows).

One command, rerunnable, against the INSTALLED driver:

    python acceptance.py                       # default: ~/.dsh/mcp/desktop
    python acceptance.py --module-dir <dir> --json report.json

Every case is PASS / FAIL / SKIP. SKIP never counts as a pass and must carry a reason; any FAIL
makes the exit code non-zero. The negative cases are the point: a lease must refuse delivery, a
stale frame must be refused, an expectation already on screen must not become a pass, and a click
that changes nothing must not verify.

Fixtures are windows this script starts itself and kills afterwards. They are selected as "the
window that appeared because we started it", never by a title substring: a substring once picked a
Notepad window that already held user tabs, and another time a browser whose page text contained
the word being searched for.
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import time

RESULTS = []
user32 = ctypes.windll.user32
VK_LWIN, VK_R, VK_ESCAPE = 0x5B, 0x52, 0x1B
HERE = os.path.dirname(os.path.abspath(__file__))


def record(case, state, detail=""):
    RESULTS.append({"case": case, "state": state, "detail": detail})
    print("{:5} {:58} {}".format(state, case, detail))


def check(case, ok, detail=""):
    record(case, "PASS" if ok else "FAIL", detail)


def skip(case, why):
    record(case, "SKIP", why)


def load_driver(module_dir, uia_helper):
    module_dir = os.path.abspath(module_dir)
    if uia_helper:
        os.environ["DSH_UIA_HELPER"] = uia_helper
    elif os.path.exists(os.path.join(module_dir, "uia_helper.ps1")):
        os.environ["DSH_UIA_HELPER"] = os.path.join(module_dir, "uia_helper.ps1")
    sys.path.insert(0, module_dir)
    import desktop_server  # noqa: PLC0415
    return desktop_server


def main():
    parser = argparse.ArgumentParser(description="computer-use acceptance runner")
    parser.add_argument("--module-dir", default=os.path.join(os.path.expanduser("~"), ".dsh", "mcp", "desktop"))
    parser.add_argument("--uia-helper", default="")
    parser.add_argument("--json", default="")
    parser.add_argument("--keep-fixtures", action="store_true")
    args = parser.parse_args()

    d = load_driver(args.module_dir, args.uia_helper)
    print("module:", d.__file__)
    print("tools:", len([name for name in dir(d) if name.startswith("desktop_")]))

    def titles():
        out = d.desktop_list_windows(True)
        found = []
        for line in str(out).splitlines():
            if " | " in line:
                found.append(line.split(" | ")[0].strip())
        return [title for title in found if title]

    def new_window(before, needles=(), exact=(), timeout=20.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for title in titles():
                if title in before:
                    continue
                if exact and title in exact:
                    return title
                if needles and any(needle.lower() in title.lower() for needle in needles):
                    return title
            time.sleep(0.4)
        return None

    def cursor():
        point = wt.POINT()
        user32.GetCursorPos(ctypes.byref(point))
        return point.x, point.y

    def center_of(name, title, control_type="Button"):
        reply = json.loads(d._uia({"action": "find", "title": title, "name": name,
                                   "control_type": control_type}))
        if not reply.get("ok"):
            return None
        x, y, w, h = (int(float(part)) for part in reply["element"]["rect"].split(","))
        return x + w // 2, y + h // 2

    fixtures = []
    subprocess.run(["taskkill", "/IM", "CalculatorApp.exe", "/F"], capture_output=True)
    time.sleep(0.6)
    before_titles = set(titles())
    subprocess.Popen(["calc.exe"])
    fixtures.append("CalculatorApp.exe")
    calc = new_window(before_titles, ("计算器", "Calculator"))
    if calc is None:
        record("precondition", "FAIL", "the calculator fixture did not start")
        return finish(args)
    time.sleep(1.5)
    d.desktop_activate_window(calc)
    time.sleep(0.8)

    # ---- contract layer ----------------------------------------------------
    first = d._cua_observe(calc)
    check("observe returns revision + frame_id + pixel_id",
          first.get("ok") and len(first.get("revision", "")) == 16
          and len(first.get("frame_id", "")) == 16 and first.get("pixel_state") == "ok",
          "elements={} revision={} frame={}".format(first.get("elements"), first.get("revision"),
                                                    first.get("frame_id")))

    d.desktop_observe(calc)
    diff = json.loads(d.desktop_diff_window(calc))
    check("diff on a quiet window says changed=false",
          diff.get("ok") and diff.get("changed") is False,
          "structure={} pixel_delta={}".format(diff.get("structure"), diff.get("pixels", {}).get("delta")))

    stable = json.loads(d.desktop_wait_stable(calc, stable_ms=300, timeout_ms=8000))
    check("wait_stable settles with >=2 samples on an idle window",
          stable.get("settled") is True and int(stable.get("samples", 0)) >= 2,
          "samples={} waited={}ms last_moving={} tolerance={}".format(
              stable.get("samples"), stable.get("waited_ms"), stable.get("last_moving_signal"),
              stable.get("pixel_tolerance")))

    hwnd = first["hwnd"]
    lease_path = d._cua_lease_path(d._cua_lease_key(hwnd))
    os.makedirs(os.path.dirname(lease_path), exist_ok=True)
    with open(lease_path, "w", encoding="utf-8") as lease_file:
        json.dump({"key": d._cua_lease_key(hwnd), "owner": "acceptance-simulated-other",
                   "at": time.time()}, lease_file)
    before_cursor = cursor()
    refused = json.loads(d.desktop_click_verified(*center_of("七", calc), title_substring=calc,
                                                  expect_text="ZZZ-never-2026"))
    after_cursor = cursor()
    check("foreign lease refuses the click and delivers nothing",
          refused.get("busy") is True and refused.get("effect") == "not-delivered"
          and before_cursor == after_cursor,
          "effect={} holder={}".format(refused.get("effect"), refused.get("holder")))
    try:
        os.remove(lease_path)
    except OSError:
        pass
    status = json.loads(d.desktop_lease_status())
    check("lease released after the action", status.get("count") == 0,
          "leases={}".format(status.get("count")))

    before_cursor = cursor()
    stale = json.loads(d.desktop_click_verified(*center_of("七", calc), title_substring=calc,
                                                expect_text="ZZZ-never-2026",
                                                screenshot_id="deadbeefdeadbeef"))
    after_cursor = cursor()
    check("stale screenshot_id refuses the click",
          stale.get("stale_capture") is True and before_cursor == after_cursor,
          "reason={}".format(str(stale.get("reason"))[:60]))

    for label in ("七", "加", "八"):
        d.desktop_click(*center_of(label, calc))
        time.sleep(0.3)
    fresh = d._cua_observe(calc)
    verdict = json.loads(d.desktop_click_verified(*center_of("等于", calc), title_substring=calc,
                                                  expect_text="15", screenshot_id=fresh["frame_id"],
                                                  stable_ms=300, timeout_ms=6000))
    check("native click verified: 7+8= expects 15 newly appearing",
          verdict.get("verified") is True,
          "effect={} samples={}".format(verdict.get("effect"), verdict.get("samples")))

    again = json.loads(d.desktop_click_verified(*center_of("等于", calc), title_substring=calc,
                                                expect_text="15", stable_ms=300, timeout_ms=4000))
    check("expectation already present is invalid-expectation (not a pass)",
          again.get("effect") == "invalid-expectation" and again.get("verified") is False,
          "effect={}".format(again.get("effect")))

    display = next((item for item in fresh.get("items", [])
                    if item.get("type") in ("Text", "Edit") and item.get("rect")), None)
    if display is None:
        skip("click without the expected text reports not-met", "no display control located")
    else:
        x, y, w, h = (int(float(part)) for part in display["rect"].split(","))
        not_met = json.loads(d.desktop_click_verified(x + w // 2, y + h // 2, title_substring=calc,
                                                      expect_text="999999",
                                                      stable_ms=250, timeout_ms=3000))
        check("click without the expected text reports not-met (not a pass)",
              not_met.get("effect") == "not-met" and not_met.get("verified") is False
              and not_met.get("verification_required") is True,
              "effect={} delivered={}".format(not_met.get("effect"), str(not_met.get("delivered"))[:30]))

    # ---- verified text entry, on a fixture this script owns ---------------
    before_titles = set(titles())
    fixture = subprocess.Popen(["pwsh", "-NoProfile", "-File", os.path.join(HERE, "fixture_dialog.ps1")])
    fixtures.append("C021-FIXTURE")
    dialog = new_window(before_titles, exact=("C021-FIXTURE",), timeout=20.0)
    if dialog is None:
        skip("type_verified verified through a ValuePattern readback", "the fixture dialog did not open")
    else:
        d.desktop_activate_window(dialog)
        time.sleep(1.0)
        observation = d._cua_observe(dialog)
        names = [item.get("name") for item in observation.get("items", []) if item.get("name")]
        control = "c021box" if "c021box" in names else None
        if control is None:
            skip("type_verified verified through a ValuePattern readback",
                 "the fixture's Edit control was not addressable")
        else:
            typed = json.loads(d.desktop_type_verified("CUU-42", title_substring=dialog,
                                                       control_name=control, expect_text="CUU-42"))
            check("type_verified verified through a ValuePattern readback",
                  typed.get("verified") is True and typed.get("readback_source") == "ValuePattern",
                  "effect={} source={} readback={}".format(typed.get("effect"),
                                                           typed.get("readback_source"),
                                                           str(typed.get("readback"))[:20]))
            second = json.loads(d.desktop_type_verified("CUU-42", title_substring=dialog,
                                                        control_name=control, expect_text="CUU-42"))
            check("a second identical expectation is invalid, not a second pass",
                  second.get("effect") == "invalid-expectation", "effect={}".format(second.get("effect")))
        try:
            fixture.terminate()
        except Exception:  # noqa: BLE001
            pass

    # ---- first-contact probe ---------------------------------------------
    if not hasattr(d, "desktop_probe_app"):
        skip("probe_app read-only route card", "desktop_probe_app is not registered in this driver")
        skip("probe_app click probe changes the verdict", "desktop_probe_app is not registered")
        skip("probe_app classifies a Chromium surface from evidence", "desktop_probe_app is not registered")
    else:
        before_revision = d._cua_observe(calc)["revision"]
        card = json.loads(d.desktop_probe_app(calc))
        after_revision = d._cua_observe(calc)["revision"]
        check("probe_app read-only route card (no side effect)",
              card.get("ok") is True and card["step2_click"]["ran"] is False
              and card["step3_key"]["ran"] is False and before_revision == after_revision
              and card.get("route", {}).get("route") in ("uia-name", "keyboard", "dom", "vision", "unknown"),
              "route={} revision stable={}".format(card.get("route", {}).get("route"),
                                                   before_revision == after_revision))

        clicked = json.loads(d.desktop_probe_app(calc, confirm=True, element_name="七"))
        check("probe_app click probe changes the verdict",
              clicked["step2_click"]["ran"] is True and clicked["step2_click"]["changed"] is True
              and clicked["route"]["route"] == "uia-name",
              "route={} changed={}".format(clicked["route"]["route"],
                                           clicked["step2_click"]["changed"]))

        def chromium_browser_window():
            """Select the target by an INDEPENDENT signal: the owning process image is a Chromium
            browser. Selecting by window title skipped here for weeks - the only Chromium window
            open was a `chrome --app` window titled "... - DeepSeek Harness" - and selecting with
            probe_app's own classifier would let a broken classifier fail open into SKIP."""
            chromium_exes = {"chrome.exe", "msedge.exe", "brave.exe", "opera.exe",
                             "vivaldi.exe", "chromium.exe"}
            for title in titles():
                found = d._find_window(title)
                if not found:
                    continue
                exe = d._cua_process_exe(d._cua_window_pid(found[0])) or ""
                if os.path.basename(exe).lower() in chromium_exes:
                    return title
            return None

        chrome = chromium_browser_window()
        if chrome is None:
            skip("probe_app classifies a Chromium surface from evidence",
                 "no window is owned by a Chromium-family browser process")
        else:
            chrome_card = json.loads(d.desktop_probe_app(chrome))
            check("probe_app classifies a Chromium surface from evidence",
                  chrome_card["app"]["chromium_surface"] is True
                  and chrome_card["app"]["evidence"],
                  "evidence={}".format(str(chrome_card["app"]["evidence"])[:70]))

    # ---- a window that keeps moving must NOT be reported as settled ----
    before_titles = set(titles())
    animated_process = subprocess.Popen(["pwsh", "-NoProfile", "-File",
                                        os.path.join(HERE, "fixture_animated.ps1")])
    animated = new_window(before_titles, exact=("C024-ANIMATED",), timeout=20.0)
    try:
        if animated is None:
            skip("a moving window reports not-settled and names the moving signal",
                 "the animated fixture did not open")
        else:
            moving = json.loads(d.desktop_wait_stable(animated, stable_ms=300, timeout_ms=3000))
            check("a moving window reports not-settled and names the moving signal",
                  moving.get("settled") is False and int(moving.get("samples", 0)) >= 2
                  and "pixels" in str(moving.get("last_moving_signal") or ""),
                  "settled={} samples={} last_moving={} waited={}ms".format(
                      moving.get("settled"), moving.get("samples"),
                      moving.get("last_moving_signal"), moving.get("waited_ms")))
    finally:
        try:
            animated_process.terminate()
        except Exception:  # noqa: BLE001
            pass

    if not args.keep_fixtures:
        for image in fixtures:
            subprocess.run(["taskkill", "/IM", image, "/F"], capture_output=True)
    return finish(args)


def finish(args):
    fails = [r for r in RESULTS if r["state"] == "FAIL"]
    summary = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "pass": len([r for r in RESULTS if r["state"] == "PASS"]),
        "fail": len(fails),
        "skip": len([r for r in RESULTS if r["state"] == "SKIP"]),
        "total": len(RESULTS),
        "results": RESULTS,
    }
    print("\nSUMMARY pass={pass} fail={fail} skip={skip} total={total}".format(**summary))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as report:
            json.dump(summary, report, indent=2, ensure_ascii=False)
        print("report:", args.json)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
