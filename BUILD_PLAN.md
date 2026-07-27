# UFC Live Dashboard — Overnight Build Plan

**Read this whole file before doing anything. Then start with Phase 0.**

## What we're building

A private, personal-use dashboard for watching UFC events live. It is for
one user (me) only. It is never to be made public, shared, or redistributed
— several of the data sources below are licensed for personal non-commercial
use only, and that restriction is load-bearing, not optional.

### Feature set (final, do not expand scope)
1. Round-by-round fight data — updated **between rounds**, not continuous/live-in-round
2. Kalshi odds
3. Polymarket odds
4. Sportsbook odds (moneyline, from major US books)
5. Journalist/scorecard commentary (via embed, not paid API search)
6. Fighter history/records (cached, rarely changes)

Nutrition, biological age, sleep data, or anything health-related is **not**
part of this project — if that ever comes up, it's a mix-up with an
unrelated project.

---

## Phase 0 — Verify environment before writing any code

- [ ] Confirm `.agents/skills/` contains all installed skills, and that
      `.claude/skills` and `.codex/skills` both resolve as **relative**
      symlinks to it (not absolute paths tied to this machine)
- [ ] Confirm `/plugin list` shows `code-simplifier`, `example-skills`,
      `superpowers`, `ui-ux-pro-max`, and `impeccable` all enabled
- [ ] Confirm `.claude/settings.json` has the attribution block (below)
- [ ] Confirm this file, `CLAUDE.md`, and `PROGRESS.md` all exist
- [ ] Run `codex --help` and confirm the exact current flags for
      non-interactive, no-prompt, workspace-scoped execution before using
      Codex for anything — flag names have changed across recent releases,
      do not assume `-a never -s workspace-write` is still correct
- [ ] Report status before proceeding to Phase 1

## Required config files

### `.claude/settings.json`
```json
{
  "attribution": { "commit": "", "pr": "" }
}
```

### `CLAUDE.md` — must include
- **No attribution ever.** Never add "Co-Authored-By," "Generated with,"
  or any AI attribution to commits, PR descriptions, or git metadata.
  This applies to both Claude and Codex — Codex has no equivalent setting,
  so this instruction is the only enforcement for it.
- **Commit periodically and frequently — this is not optional.** Commit
  after every unit of work, not just at milestones: each finished API
  client, each UI pass, each schema change, each passing test suite = its
  own commit. If you're ever mid-task for more than a short stretch with
  nothing committed, that's a signal to find a smaller checkpoint to land,
  not to keep pushing toward one big commit later. This is what makes an
  overnight run reviewable and reversible in the morning — I need to be
  able to see what happened and when, and roll back to any point, not just
  see one giant diff at the end.
- **Never retry into a wall.** If a usage/spend limit error occurs, stop
  that work item immediately and log it. Do not retry. Do not keep
  dispatching subagents into a known-exhausted limit.
- **Never block on missing input.** If something needs credentials or a
  decision only I can make, write it to `PROGRESS.md` under "Blocked" and
  move to the next task. Do not stop and wait.

---

## Model delegation — guidance, not a rigid rulebook

These are **suggestions**, not hard requirements. The underlying priority
order is:

1. **Fable 5 (you) — only if absolutely necessary.** You are the most
   expensive and most credit-constrained option tonight. Reach for
   yourself only when a task genuinely can't be done well any other way.
2. **Codex — otherwise, default.** For anything that doesn't require you
   specifically, this is the workhorse tonight.
3. **Sonnet subagent — if context is necessary.** If a task needs shared
   session context that would be lost or degraded crossing the vendor
   boundary to Codex, use a Sonnet subagent instead of Codex for that task.

Rough mapping of tonight's actual work onto that priority order:

| Task type | Suggested | Why |
|---|---|---|
| Architecture & data schema design | Fable 5 | Needs to stay coherent across the whole build |
| Kalshi RSA-PSS auth implementation | Fable 5 | Known-fiddly |
| Final UI judgment calls | Fable 5 | Taste/judgment, not boilerplate |
| API client wrappers (Polymarket, Odds API, ESPN, Cito, Sherdog scraper) | Codex | Mechanical, well-specified |
| Tests for the above | Codex | |
| Odds-normalization logic (reconciling Kalshi/Polymarket/sportsbook math) | Sonnet subagent | Needs more care than a plain wrapper, and benefits from staying in-context |
| Opus | Not planned for tonight | Reserved only if something genuinely exceeds what Codex or Sonnet can do and truly can't wait until morning |

**You can override this.** If, when you actually look at a task, your own
judgment disagrees with where this table puts it — you think something
listed for Codex actually needs you, or something listed for yourself is
fine on Codex — trust your own assessment at that point and use whatever
you think is right. This table is a starting heuristic, not a constraint
you have to justify departing from. The one thing that isn't negotiable:
stay mindful that you're the scarce, capped resource tonight, so when it's
genuinely a close call, prefer not spending yourself.

**Codex invocation — non-interactive only, always:**
```
codex -a never -s workspace-write exec "<task>"
```
(confirm exact flags via `codex --help` first — see Phase 0). Never invoke
interactive `codex`. An approval prompt with nothing to answer it is a
silent overnight hang, not a bug you'll see.

---

## Data sources — what's confirmed, what's mocked tonight

**No live credentials exist yet.** Kalshi, Polymarket, and any other API
keys are being set up tomorrow. **Build and test everything tonight
against mock/fixture data for all four external sources.** Do not attempt
real API calls. Structure the code so swapping fixtures for live clients
tomorrow is a small, isolated change — not a rewrite.

| Source | Status | Notes |
|---|---|---|
| Kalshi | Free, public market data, no auth for reads | Personal use only — never display/redistribute publicly (ToS) |
| Polymarket | Free, no auth (Gamma/CLOB/Data APIs) | Data viewing is unrestricted regardless of jurisdiction; only trading is restricted for US persons — not relevant, we're only reading |
| Sportsbook odds | The Odds API, free tier, 500 credits/month | ~40 books incl. DraftKings/FanDuel; fine for periodic polling, not continuous streaming |
| Round-by-round data | No single clean free+live+granular source exists | Combine: ESPN free API (results/rounds, no live strikes) + Sherdog live blog (free, live, text-based round scoring) + test Cito API's free tier live during an actual event to see if it updates in real time |
| Journalist scorecards | Free X embed widget for specific known accounts (not paid search API) | Ariel Helwani, Din Thomas, Kevin Iole, Luke Thomas, MMA Junkie — confirm which are consistently active before relying on any one |
| Fighter history | ESPN free API + Cito API free tier | Changes rarely — fetch once, cache locally, don't re-poll every load |

---

## Build sequence

1. **Schema first.** Design the unified data model that all four sources
   normalize into. This is Fable's job, done before any client code.
2. **UI shell against mock data.** Scaffold with a hot-reload dev server
   (Vite or equivalent) from the start — every visual change should appear
   in-browser in under a second. Use `ui-ux-pro-max` for the design system
   and dashboard/chart structure, `impeccable` as the taste/anti-slop layer
   on top. Run `/impeccable init` if not already done.
3. **Parallel client wrappers**, dispatched to Codex: Polymarket, Odds API,
   ESPN, Cito, Sherdog scraper — each against mock data initially, each its
   own commit.
4. **Kalshi client + auth** — Fable, not delegated.
5. **Wire mock clients into the UI**, verify rendering with `webapp-testing`
   (Playwright) after each integration point.
6. **`code-simplifier`** — run at milestones only, not after every small
   edit. Reprocessing is expensive; use it deliberately.
7. **`PROGRESS.md`** — keep it updated as a running checklist. This is
   the primary thing to review in the morning.

---

## Skills — use them deliberately, at these specific points

Installed skills are not optional extras. Some may auto-trigger based on
task description, but don't rely on that alone during an unattended run —
invoke these explicitly at the following points as a matter of course:

- **`ui-ux-pro-max`** — invoke before writing any UI component, page, or
  dashboard section, not after. Tell it specifically what you're building
  ("fight card view," "odds comparison table," "round-by-round timeline")
  and let it generate the design system for that piece before you write
  code. This is its named strength — use it for every chart and table,
  not just the overall shell.
- **`impeccable`** — run `/impeccable init` once, first thing in Phase 0,
  if not already done (later commands depend on it). Then use it as the
  taste pass *after* `ui-ux-pro-max` produces something and it's
  functional: `/impeccable polish` or `/impeccable audit` on the file
  before considering that piece done — not instead of ui-ux-pro-max, on
  top of it.
- **`webapp-testing`** (inside `example-skills`) — use after every UI
  milestone, anytime a component or page is wired up and should render.
  Drive it with Playwright to confirm it actually renders correctly, not
  just that it compiles. This is the only way you can visually self-check
  during a run I'm not watching — treat it as mandatory before marking
  UI work done, not a nice-to-have.
- **`superpowers`** — use for overall workflow discipline: brainstorm/plan
  before starting any non-trivial feature, dispatch subagents per task via
  its subagent-driven-development skill, reach for its systematic-debugging
  skill the moment something breaks rather than guessing at a fix, and use
  its git-worktree skill if working on more than one thing in parallel.
- **`code-simplifier`** — milestone-only, as already noted: after a piece
  is done and tested, before moving to the next task. Not after every
  small edit — it's expensive enough that using it continuously defeats
  the point of pairing it with a cheap-model-heavy delegation strategy.

If you're unsure whether a moment qualifies as a trigger point, err toward
using the skill — the cost of an unnecessary invocation is smaller than
the cost of shipping UI or a workflow decision without the judgment these
were installed to provide.

---

- `/usage-credits` cap is set manually by me, with auto-top-up off — this
  is intentional and should not be reconfigured by you at any point.
- `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` is set to limit subagent fan-out.
- Sleep/keep-awake is handled on my end.

If you hit the usage cap, stop cleanly, log where you stopped in
`PROGRESS.md`, and do not attempt to continue or work around it.

---

## What "done" looks like by morning

- A readable git history, one commit per unit of work, no attribution lines
- `PROGRESS.md` showing what was completed, what's blocked, and why
- A running UI on mock data I can react to over coffee
- Nothing attempted against real credentials or live APIs
- No silent hangs, no runaway retries, no exhausted budget spent on
  doomed repeated attempts
