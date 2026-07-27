"""Batched visual verification for the dashboard's supported viewport range."""

import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5173"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ufc-dash"

errors: list[str] = []
problems: list[str] = []

VIEWPORTS = [
    ("iphone15", 393, 852, 3),
    ("phone375", 375, 812, 2),
    ("phone390", 390, 844, 3),
    ("prototype402", 402, 874, 3),
    ("phone430", 430, 932, 3),
    ("tablet", 768, 1024, 2),
    ("desktop", 1440, 900, 1),
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for name, width, height, dpr in VIEWPORTS:
        context = browser.new_context(
            viewport={"width": width, "height": height},
            device_scale_factor=dpr,
            is_mobile=width < 768,
            has_touch=width < 768,
        )
        page = context.new_page()
        page.on(
            "console",
            lambda message, label=name: errors.append(f"{label}: {message.text}")
            if message.type == "error"
            else None,
        )
        page.on(
            "pageerror",
            lambda error, label=name: errors.append(f"{label}: {error}"),
        )
        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_selector(".fight-screen")

        metrics = page.evaluate(
            """() => ({
              viewportWidth: window.innerWidth,
              docWidth: document.documentElement.scrollWidth,
              bodyWidth: document.body.scrollWidth,
              contentWidth: document.querySelector('.app-content')?.scrollWidth ?? 0,
              contentClientWidth: document.querySelector('.app-content')?.clientWidth ?? 0,
              summaryTop: document.querySelector('.round-summary')?.getBoundingClientRect().top ?? -1,
              summaryBottom: document.querySelector('.round-summary')?.getBoundingClientRect().bottom ?? -1,
              navBottom: document.querySelector('.mobile-nav')?.getBoundingClientRect().bottom ?? -1,
            })"""
        )
        if (
            metrics["docWidth"] > metrics["viewportWidth"]
            or metrics["bodyWidth"] > metrics["viewportWidth"]
            or metrics["contentWidth"] > metrics["contentClientWidth"] + 1
        ):
            problems.append(f"{name}: horizontal overflow {metrics}")
        if width == 393:
            if not (0 < metrics["summaryTop"] < height):
                problems.append(
                    f"{name}: round summary does not begin in first viewport {metrics}"
                )
            if abs(metrics["navBottom"] - height) > 1:
                problems.append(f"{name}: bottom navigation is not viewport-safe {metrics}")
        if name in {"iphone15", "desktop"}:
            page.screenshot(path=f"{OUT}-{name}.png", full_page=False)
        context.close()
    browser.close()

print("CONSOLE ERRORS:", errors if errors else "none")
print("LAYOUT PROBLEMS:", problems if problems else "none")
print("SCREENSHOTS:", f"{OUT}-iphone15.png", f"{OUT}-desktop.png")
sys.exit(1 if errors or problems else 0)
