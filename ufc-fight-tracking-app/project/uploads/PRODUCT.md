# Product

<!-- impeccable:product-schema 1 -->

> Written during an unattended overnight build, inferred from the explicit
> brief in BUILD_PLAN.md per the owner's standing instruction to proceed
> without interviews. Items marked *(assumed)* are inferences, not
> confirmed answers.

## Platform

web

## Users

Exactly one user: the owner (Samay), watching UFC events live at home,
typically with the fight on a TV and this dashboard on a laptop or second
screen. The job: during and between rounds, see at a glance how the fight
is going, how three different betting markets (Kalshi, Polymarket,
sportsbooks) are pricing each fighter, and what credible journalists are
scoring the round. Private and personal-use only — never public, shared,
or redistributed; several data sources are licensed personal
non-commercial only, and that restriction is load-bearing.

## Product Purpose

A live-event companion dashboard that consolidates round-by-round fight
state, three odds sources, journalist scorecards, and fighter records into
one screen, so the owner never tab-switches between five sites mid-event.
Success: during a real UFC card, the dashboard is genuinely the second
screen — updated between rounds, readable at a glance from couch distance
*(assumed)*.

## Positioning

Not a product; a personal tool. Its only "position" is that no public
site legally can combine these specific sources in one view — the
personal-use licensing is what makes the combination possible at all.

## Operating Context

- Used live during UFC events (evenings/weekends), between rounds — data
  updates are round-granular, deliberately not continuous in-round.
- Data sources: Kalshi (public market reads), Polymarket (Gamma/CLOB/Data
  APIs), The Odds API free tier (~40 sportsbooks, 500 credits/month, so
  periodic polling only), ESPN free API + Sherdog live blog + Cito free
  tier for round data, X embed widgets for journalist scorecards (Ariel
  Helwani, Din Thomas, Kevin Iole, Luke Thomas, MMA Junkie).
- No live credentials exist yet (arriving 2026-07-28); everything runs on
  fixtures until then, with a deliberately thin fixture/live boundary.

## Capabilities and Constraints

Final feature set, scope frozen: (1) round-by-round fight data updated
between rounds, (2) Kalshi odds, (3) Polymarket odds, (4) sportsbook
moneylines, (5) journalist scorecard commentary via embeds, (6) cached
fighter history/records. Nothing health-related belongs to this project.
Terminology: UFC/MMA standard — card, bout, round, moneyline, scorecard
(10-9 etc.), finish (KO/TKO/SUB/DEC).
Constraints: The Odds API credit budget caps polling frequency; Sherdog
data is scraped text; Cito free-tier live behavior unverified until tested
during a real event. Undecided: which journalist accounts prove
consistently active enough to rely on.

## Brand Commitments

None. No name, logo, or brand assets exist; visual identity is entirely
open *(no constraint volunteered)*.

## Evidence on Hand

No real API responses captured yet — fixtures must be clearly labeled as
synthetic and must not be presented as real fight data. No testimonials,
customers, or metrics exist or should ever be fabricated; this is a
single-user tool.

## Product Principles

1. **Glanceable over exhaustive** — between-rounds reading in seconds
   beats dense completeness.
2. **Round-granular by design** — no fake liveness; show data freshness
   honestly.
3. **Sources stay distinguishable** — Kalshi vs Polymarket vs sportsbook
   numbers are different markets with different math; never blur them
   into one number without showing the parts.
4. **Fixture/live boundary stays thin** — swapping in real clients must
   never require touching the UI.
5. **Private by construction** — nothing about the build should drift
   toward publishability.

## Accessibility & Inclusion

No product-specific requirement established. Baseline: readable at
distance (large numerals for odds/scores) *(assumed)*.
