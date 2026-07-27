# PROGRESS — UFC Live Dashboard overnight build

Last updated: 2026-07-27 ~03:55 — **all five phases complete.** Run
`npm run dev` and open http://localhost:5173 for the dashboard on
synthetic fixture data. 32 tests green (`npm test`), zero console errors
in Playwright checks (`scripts/screenshot.py`, `scripts/walkthrough.py`).

## Task list

### Phase 0 — Environment verification
- [x] `.agents/skills/` contains all installed skills
- [x] `.codex/skills` is a relative symlink to `../.agents/skills`
- [ ] `.claude/skills` as relative symlink — **BLOCKED** (see below); it is
      currently a real directory whose contents are byte-identical to
      `.agents/skills`, so functionally equivalent tonight
- [x] All five plugins enabled (verified in `.claude/settings.local.json`
      `enabledPlugins`: code-simplifier, example-skills, superpowers,
      ui-ux-pro-max, impeccable)
- [ ] `.claude/settings.json` attribution block — **BLOCKED** (see below);
      no-attribution rule enforced via CLAUDE.md + manual commit discipline
- [x] `CLAUDE.md` created with required rules
- [x] `PROGRESS.md` created (this file)
- [x] Codex flags verified: `codex exec` has **no `-a` flag** anymore
      (non-interactive by default). Correct invocation:
      `codex exec -s workspace-write "<task>"`

### Phase 1 — Unified data schema (Fable)
- [x] Unified data model (src/schema/types.ts): canonical ids +
      externalRefs, native-price-preserving odds, honest provenance
- [x] Source client contracts (src/sources/contract.ts) + canonical
      synthetic fixture event (src/fixtures/event.json)

### Phase 2 — UI shell against mock data
- [x] `/impeccable init` — PRODUCT.md written (inferred from BUILD_PLAN.md;
      no interview possible in unattended run, assumptions labeled inline)
- [x] Vite scaffold with hot reload (React 19 + TS strict + Vitest)
- [x] ui-ux-pro-max design system (persisted to
      design-system/ufc-live-dashboard/; dark dense terminal, Fira
      Sans/Fira Code, corner-color grammar validated with the dataviz
      palette checker; direction contract in index.html)
- [x] Dashboard shell: top bar, card rail, tale of the tape, per-source
      round grid + prose, odds comparison (Polymarket + sportsbooks),
      scorecard roster with honest empty state
- [ ] impeccable polish/audit pass on each finished piece
- [x] webapp-testing (Playwright) render verification — desktop + mobile
      screenshots clean, zero console errors, fixture content asserted
      (scripts/screenshot.py; rerun via
      `python3 .agents/skills/webapp-testing/scripts/with_server.py
       --server "npm run dev" --port 5173 -- python3 scripts/screenshot.py`)

### Phase 3 — Client wrappers (Codex, parallel, mock-backed)
- [x] Polymarket client + tests (Codex)
- [x] The Odds API client + tests (Codex)
- [x] ESPN client + tests (Codex)
- [x] Cito client + tests (Codex)
- [x] Sherdog live-blog scraper + tests (Codex)
- All five verified (tsc strict, 17 vitest tests, no-network grep) and
  committed individually. Wired into the UI store (Cito round-stats
  wiring pending an externalRef fix — see notes).

### Phase 4 — Kalshi client + auth scaffold (Fable)
- [x] Kalshi client (fixture markets in cents, mid of bid/ask) +
      RSA-PSS request signer on WebCrypto (src/sources/kalshiAuth.ts),
      tested with a generated PKCS#8 key sign→verify round trip

### Phase 5 — Integration
- [x] Odds-normalization module src/lib/oddsMath.ts (Sonnet subagent):
      American↔prob conversion, multiplicative de-vig, per-market
      probabilities, cross-market consensus with spread — 10 tests
- [x] All six sources wired into the UI store; vig-free consensus strip
      atop the markets panel; Playwright check after each integration
- [x] code-simplifier milestone pass (also surfaced a real prose-source
      bug in RoundGrid, fixed)
- [x] impeccable finish review (subagent) — material fixes applied:
      amber reservation enforced (kicker recolored), structural red/blue
      corner tints, mobile tale-of-the-tape + stat-row reflow, freshness
      stamps on Rounds and Recent Form
- [x] DESIGN.md + .impeccable/design.json recorded by the impeccable
      documenter from the shipped system

## Morning follow-ups (deliberately deferred, not blocked)

- **Odds movement (amber's reserved job).** The finish reviewer's one
  unapplied fix: showing per-market deltas needs odds *history* (multiple
  snapshots), which means extending the OddsSource contract with a
  history method + multi-tick fixtures across three clients. Right scope
  for tomorrow, wrong scope for 4am.
- **Live-mode transports** for all six clients behind the existing
  factories (each currently throws on `mode: "live"`); credentials due
  today. The parse layers are transport-ready.
- **X embed rendering** in ScorecardFeed (widget script + real post ids);
  fixture mode intentionally shows an empty state, no invented posts.
- Verify which journalist accounts are consistently active; flip
  `active: false` in useDashboard's roster for dead ones.
- Test Cito free tier live during a real event (per plan).
- Unused-but-defined tokens `--border-strong` and Fira Sans 300 — drop or
  use (documenter deliberately left them out of DESIGN.md).

## Blocked

- **`.claude/skills` symlink conversion**: writes inside `.claude/` are
  permission-gated and this run is non-interactive (prompts auto-deny).
  Needs one manual step in the morning:
  `rm -rf .claude/skills && ln -s ../.agents/skills .claude/skills`
- **`.claude/settings.json` attribution block**: same permission gate.
  Needs manual creation of `.claude/settings.json` with
  `{"attribution": {"commit": "", "pr": ""}}`. Until then, no-attribution
  is enforced by commit-message discipline (no attribution lines have been
  or will be added).
- **Live API credentials** (Kalshi, Polymarket, Odds API): being set up
  tomorrow, per plan. Everything tonight is fixture-backed.

## Notes / decisions

- Codex delegation worked as planned: all five Phase-3 clients built by
  `codex exec -s workspace-write` in parallel (note the `-a` flag no
  longer exists), each verified and committed individually by Fable.
- Odds schema keeps native prices (Kalshi cents / Polymarket dollars /
  American lines) beside implied probability; de-vig only happens in
  src/lib/oddsMath.ts, and the UI labels vigged vs vig-free numbers.
- Cross-source identity = canonical ids + per-source externalRefs on
  every entity (one real bug tonight — Cito refs missing from bouts —
  confirmed this is the right seam).
- Design direction: "corner-colored fight terminal" (contract in
  index.html head comment; system recorded in DESIGN.md). Corner palette
  validated CVD-safe with the dataviz checker.
- impeccable init interview was impossible unattended; PRODUCT.md was
  inferred from BUILD_PLAN.md with assumptions labeled — worth a skim to
  correct anything mis-assumed.
- No AI attribution anywhere in git history (checked); no live API calls
  attempted; no credentials touched.
