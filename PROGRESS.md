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
- [ ] Design unified data model all four sources normalize into

### Phase 2 — UI shell against mock data
- [ ] `/impeccable init`
- [ ] Vite scaffold with hot reload
- [ ] ui-ux-pro-max design system pass (per component, before code)
- [ ] Dashboard shell: fight card view, odds comparison, round timeline,
      scorecard commentary, fighter records
- [ ] impeccable polish/audit pass on each finished piece
- [ ] webapp-testing (Playwright) render verification

### Phase 3 — Client wrappers (Codex, parallel, mock-backed)
- [ ] Polymarket client + tests
- [ ] The Odds API client + tests
- [ ] ESPN client + tests
- [ ] Cito client + tests
- [ ] Sherdog live-blog scraper + tests

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
