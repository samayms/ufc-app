"""Render-verification for the dashboard: desktop + narrow screenshots,
console errors, and a sanity check that real fixture data reached the DOM."""

import sys

from playwright.sync_api import sync_playwright

URL = "http://localhost:5173"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ufc-dash"

errors: list[str] = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(500)
    page.screenshot(path=f"{OUT}-desktop.png", full_page=True)

    checks = {
        "event name": "Reyes vs. Volkov",
        "main-event fighter": "Danilo Reyes",
        "market label": "Polymarket",
        "round grid source": "Sherdog",
        "synthetic badge": "Synthetic data",
    }
    body = page.inner_text("body").lower()
    missing = [k for k, v in checks.items() if v.lower() not in body]

    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(400)
    page.screenshot(path=f"{OUT}-mobile.png", full_page=True)
    browser.close()

print("CONSOLE ERRORS:", errors if errors else "none")
print("MISSING CONTENT:", missing if missing else "none")
sys.exit(1 if errors or missing else 0)
