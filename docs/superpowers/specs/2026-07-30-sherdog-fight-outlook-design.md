# Sherdog fight-outlook discovery + watcher — design

Date: 2026-07-30

## Purpose

`scripts/findSherdogLiveBlog.mjs` already finds the Sherdog play-by-play
article for the upcoming UFC card via Sherdog's public news RSS feed. This
adds the equivalent for Sherdog's fight-outlook ("Preview") article, plus a
self-scheduling watcher that automates the "check 3 days before the event,
twice daily, until it succeeds" workflow the owner runs by hand today for the
live blog.

Confirmed URL shape (from the owner, verified against
`https://www.sherdog.com/news/articles/1/Preview-UFC-Belgrade-Medic-vs-Rodriguez-202128`):
the leading path segment after `/articles/` is a page number *within one
preview article* (page 1 = main event, page 2 = co-main, etc.) — the slug and
trailing numeric id stay identical across pages. Discovery therefore only
needs to find the one RSS-listed URL (always page 1); walking to later pages
for other bouts is a manual reading action, not part of this feature's scope.

## Components

### 1. `server/sherdogFeed.ts` (new — refactor extraction)

Extracted from `server/sherdogDiscovery.ts` with no behavior change:

- `SherdogNewsItem`, `parseSherdogNewsFeed`
- `normalizeSearchText`, `fighterSurname`, `eventTokenScore` — the fuzzy
  matching helpers, generic across live-blog and outlook matching
- `fetchSherdogNewsFeed(options)` — permission-scope check
  (`SHERDOG_PERMISSION_SCOPE` must include `live-blog-read`, `sherdog-read`,
  or `all`), byte-limited RSS fetch, parse. Options: `baseUrl`, `fetchImpl`,
  `timeoutMs`, `maxBytes`, `userAgent`, `permissionScope`.

`server/sherdogDiscovery.ts` is updated to import these from the new module
instead of defining them locally. Its own exports
(`discoverSherdogLiveBlog`, `findSherdogLiveBlog`, `SHERDOG_NEWS_FEED_PATH`,
etc.) are unchanged, and its existing test file must keep passing unmodified.

### 2. `server/sherdogOutlookDiscovery.ts` (new)

Structural twin of `sherdogDiscovery.ts`, built on `sherdogFeed.ts`:

- `SherdogOutlookTarget` — `{ eventName, redFighter, blueFighter }` (same
  shape as `SherdogLiveBlogTarget`)
- `isSherdogOutlookPreview(item: SherdogNewsItem): boolean` — title matches
  `/\bufc\b/iu` and `/\bpreview\b/iu`; URL host is `sherdog.com` /
  `www.sherdog.com`; path matches `/^\/news\/articles\/\d+\/.+-\d+\/?$/iu`
- `findSherdogOutlookPreview(items, target)` — same surname + event-token
  scoring/threshold (>=100) as `findSherdogLiveBlog`
- `discoverSherdogOutlookPreview(target, options: DiscoverSherdogOutlookOptions)`
  — fetches via `fetchSherdogNewsFeed`, returns the matched item or
  `undefined`

No new permission scope; reuses the existing `SHERDOG_PERMISSION_SCOPE`
values.

### 3. `scripts/findSherdogOutlook.mjs` (new, one-shot CLI)

Structural twin of `findSherdogLiveBlog.mjs`:

- No args: loads ESPN's nearest upcoming card via `loadLiveEventState`, takes
  the lowest-`cardPosition` bout as the main event, builds the target from
  its fighters.
- `--event <name> --red <fighter> --blue <fighter>`: manual override (both
  `--red`/`--blue` required together, same validation as today).
- On match: prints the article title, URL, and `SHERDOG_FIGHT_OUTLOOK_URL=<url>`.
  Never writes `.env`.
- No match: prints a "not published yet" message, exit code 2.
- npm script: `sherdog:outlook:find`.

### 4. `scripts/watchSherdogOutlook.mjs` (new, self-scheduling watcher)

Long-running process, started manually (e.g. left running in a terminal
during fight week):

- Resolves the target event the same way as `findSherdogOutlook.mjs`
  (ESPN nearest card, or `--event/--red/--blue` override), and reads
  `event.startsAt` (ISO 8601).
- State file: `data/sherdog-outlook-state.json` (`/data/` is already
  gitignored). Shape: `{ eventName, url, foundAt }`. On startup, if this
  file exists and its `eventName` matches the resolved target's event name,
  print the stored URL and exit 0 immediately — no network call.
- Eligibility window opens at `startsAt` minus 3 days. If the current time
  (`options.now()`, defaults to `() => new Date()`) is before that, sleep
  (`options.sleep()`, defaults to real `setTimeout`-based sleep) until the
  window opens — one sleep, not a poll loop.
- Once eligible: run one discovery attempt.
  - Found: write the state file, print
    `SHERDOG_FIGHT_OUTLOOK_URL=<url>`, exit 0.
  - Not found and `now() < startsAt`: sleep 12 hours, retry.
  - Not found and `now() >= startsAt`: log that the event has started
    without a discovered preview, exit 1. (Per the project's "never retry
    into a wall" rule — stop rather than loop forever past the event.)
- HTTP 403 from Sherdog is not treated as "not published yet": it aborts the
  watcher immediately with a non-zero exit, matching
  `WEEKEND_RUNBOOK.md`'s existing rule ("Sherdog HTTP 403 → Stop. Do not
  rotate proxies, identities, or user agents").
- `now` and `sleep` are constructor-injectable so tests can drive the
  schedule without real waiting.
- npm script: `sherdog:outlook:watch`.

## Data flow

```
ESPN nearest-card lookup (loadLiveEventState)
  -> target { eventName, redFighter, blueFighter, startsAt }
  -> fetchSherdogNewsFeed (RSS, permission-gated)
  -> findSherdogOutlookPreview (fuzzy match on title/url)
  -> found: URL string | undefined
```

The watcher wraps this same flow in a schedule loop plus a state file for
idempotency across restarts.

## Error handling

- Missing/invalid `SHERDOG_PERMISSION_SCOPE`: `fetchSherdogNewsFeed` throws
  synchronously, same as today — surfaces as a non-zero exit with a clear
  message in both new scripts.
- Network/timeout errors during a single attempt: the one-shot script fails
  immediately (matches existing `findSherdogLiveBlog.mjs` behavior); the
  watcher logs and treats it the same as "not found yet" *except* for HTTP
  403, which always aborts the watcher (see above).
- Malformed `data/sherdog-outlook-state.json` (unreadable/corrupt): watcher
  logs a warning, ignores the file, proceeds as if no cached state exists.

## Testing

- `server/sherdogFeed.test.ts` (new, or fold into existing) — covers the
  extracted fetch/permission/parse behavior; existing
  `server/sherdogDiscovery.test.ts` must keep passing unchanged against the
  refactored module.
- `server/sherdogOutlookDiscovery.test.ts` (new) — mirrors
  `sherdogDiscovery.test.ts`: parses a fixture RSS feed containing a
  `Preview` item at an `/articles/1/...` URL, matches it by fighter surnames,
  respects the permission-scope gate, rejects non-preview / non-`articles`
  URLs.
- `scripts/watchSherdogOutlook.test.ts` (new, if scripts are practically
  testable in this repo's setup — otherwise the scheduling math is tested by
  extracting a small pure helper, e.g. `nextCheckDelayMs(now, startsAt)`,
  into a testable module and unit-testing that) — covers: window not yet
  open (long sleep computed correctly), window open + not found (12h retry),
  found (state written, exits 0), event passed without a find (exits 1).

## Manual run

Since Belgrade (`2026-08-01`) is inside the 3-day window as of `2026-07-30`,
after building this the owner will run `npm run sherdog:outlook:find` once by
hand to populate this weekend's URL (falling back to starting the watcher if
Sherdog hasn't published the preview yet).
