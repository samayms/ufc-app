"""Interaction pass: select other bouts from the rail and verify their
states (final result, upcoming markets) render without errors."""

import sys

from playwright.sync_api import sync_playwright

URL = "http://localhost:5173"
errors: list[str] = []
problems: list[str] = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)

    # Finished co-main: result line + settled markets
    page.click("text=Marisol Castillo")
    page.wait_for_timeout(300)
    body = page.inner_text("body").lower()
    for needle in ["okafor wins", "sub · r2 3:17", "market settled"]:
        if needle not in body:
            problems.append(f"co-main missing: {needle}")
    page.screenshot(path="/tmp/ufc-walk-comain.png", full_page=True)

    # Upcoming bout-3: honest upcoming state + live markets
    page.click("text=Cole Hendricks")
    page.wait_for_timeout(300)
    body = page.inner_text("body").lower()
    for needle in ["not started", "kalshi", "draftkings", "round-by-round scoring appears"]:
        if needle not in body:
            problems.append(f"bout-3 missing: {needle}")
    page.screenshot(path="/tmp/ufc-walk-upcoming.png", full_page=True)

    # Keyboard: tab reaches the rail buttons
    page.keyboard.press("Tab")
    focused = page.evaluate("document.activeElement.className")
    if "rail-bout" not in str(focused):
        problems.append(f"first tab stop is {focused!r}, expected a rail bout")

    browser.close()

print("CONSOLE ERRORS:", errors if errors else "none")
print("PROBLEMS:", problems if problems else "none")
sys.exit(1 if errors or problems else 0)
