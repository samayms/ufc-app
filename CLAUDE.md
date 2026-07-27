# UFC Live Dashboard — project rules

Private, personal-use dashboard for watching UFC events live. One user only.
Never public, never shared, never redistributed — several data sources are
licensed for personal non-commercial use only, and that restriction is
load-bearing.

## Non-negotiable rules

- **No attribution ever.** Never add "Co-Authored-By," "Generated with,"
  or any AI attribution to commits, PR descriptions, or git metadata.
  This applies to both Claude and Codex — Codex has no equivalent setting,
  so this instruction is the only enforcement for it.
- **Commit periodically and frequently — this is not optional.** Commit
  after every unit of work, not just at milestones: each finished API
  client, each UI pass, each schema change, each passing test suite = its
  own commit. If you're ever mid-task for more than a short stretch with
  nothing committed, that's a signal to find a smaller checkpoint to land,
  not to keep pushing toward one big commit later.
- **Never retry into a wall.** If a usage/spend limit error occurs, stop
  that work item immediately and log it. Do not retry. Do not keep
  dispatching subagents into a known-exhausted limit.
- **Never block on missing input.** If something needs credentials or a
  decision only the owner can make, write it to `PROGRESS.md` under
  "Blocked" and move to the next task. Do not stop and wait.

## Data sources

No live credentials exist yet. All external sources (Kalshi, Polymarket,
The Odds API, ESPN/Cito/Sherdog) are mocked with fixtures until credentials
are set up. Do not attempt real API calls. Keep the fixture/live boundary
isolated so swapping in live clients is a small change.

## Codex invocation

Non-interactive only, always:

```
codex exec -s workspace-write "<task>"
```

(Verified 2026-07-27: current `codex exec` has no `-a` flag — it is
non-interactive by default; `-s workspace-write` is correct.) Never invoke
interactive `codex`.
