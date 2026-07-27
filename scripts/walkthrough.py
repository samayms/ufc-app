"""Interaction and degraded-state pass at the regular iPhone 15 viewport."""

import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5173"
errors: list[str] = []
problems: list[str] = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(
        viewport={"width": 393, "height": 852},
        device_scale_factor=3,
        is_mobile=True,
        has_touch=True,
    )
    page = context.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)

    # Round switching and all fight sections.
    page.get_by_role("tab", name="R1", exact=True).click()
    if "round 1" not in page.locator(".compact-stats").inner_text().lower():
        problems.append("round switch did not update the compact stats")
    for section in ["Stats", "Odds", "Tale", "Fight"]:
        page.get_by_role("tab", name=section, exact=True).click()
        page.wait_for_timeout(80)

    # Finished co-main: card navigation returns to fight and renders the result.
    page.get_by_role("button", name="Event card").click()
    page.get_by_role("button", name="Marisol Castillo Adaeze Okafor").click()
    body = page.inner_text("body").lower()
    for needle in ["okafor wins", "sub · r2 3:17"]:
        if needle not in body:
            problems.append(f"completed bout missing: {needle}")

    # Upcoming bout: no stats or prose are invented.
    page.get_by_role("button", name="Event card").click()
    page.get_by_role("button", name="Cole Hendricks Kenji Saito").click()
    body = page.inner_text("body").lower()
    for needle in [
        "not started",
        "stats lock in after each completed round",
        "grounded summary will appear",
    ]:
        if needle not in body:
            problems.append(f"upcoming bout missing: {needle}")

    # Source page keeps partial availability visible.
    page.get_by_role("button", name="Source status").click()
    body = page.inner_text("body").lower()
    for needle in ["fixture mode", "unavailable", "personal, non-commercial"]:
        if needle not in body:
            problems.append(f"source page missing: {needle}")

    # Approximate Apple touch-target floor for interactive controls.
    small_targets = page.evaluate(
        """() => [...document.querySelectorAll('button')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (r.width < 40 || r.height < 40);
          })
          .map((el) => ({text: el.textContent?.trim(), box: el.getBoundingClientRect().toJSON()}))"""
    )
    if small_targets:
        problems.append(f"small touch targets: {small_targets}")

    # Explicit live, stale, loading, and error routes.
    for demo, needle in [
        ("live", "live"),
        ("stale", "stale snapshot"),
        ("loading", "loading fight data"),
        ("error", "temporarily unavailable"),
    ]:
        page.goto(f"{URL}?demo={demo}")
        page.wait_for_load_state("networkidle")
        body = page.inner_text("body").lower()
        if needle not in body:
            problems.append(f"{demo} state missing: {needle}")

    context.close()
    browser.close()

print("CONSOLE ERRORS:", errors if errors else "none")
print("PROBLEMS:", problems if problems else "none")
sys.exit(1 if errors or problems else 0)
