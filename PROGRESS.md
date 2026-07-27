# PROGRESS — UFC Live Dashboard overnight build

Last updated: 2026-07-27 ~03:15 (Phase 0)

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
- [ ] Kalshi client (public reads, mock-backed; RSA-PSS auth scaffold for
      tomorrow's credentials)

### Phase 5 — Integration
- [ ] Odds-normalization module (Sonnet subagent)
- [ ] Wire clients into UI, Playwright check after each integration point
- [ ] code-simplifier milestone pass

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

- (running log below)
