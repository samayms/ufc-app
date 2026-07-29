# Cito UFC Live Round-Stats Validation Plan

**Target test window:** UFC Fight Night: Medić vs. Rodriguez, Saturday, August 1, 2026. Start the test before the first preliminary fight and keep it running through at least two selected bouts.

## 1. Purpose

Determine whether Cito publishes complete, isolated round statistics **while a UFC fight is still in progress**, and measure how long after a round ends those statistics become available.

The key unanswered question is:

> After Round `N` ends but before the fight itself ends, when do Cito's exact-round endpoints begin returning complete statistics for both fighters?

This test must distinguish among:

1. No round data during the live fight.
2. Partial or provisional round data during the live fight.
3. Complete round data during the live fight.
4. Data that appears during the fight but changes after the fight ends.
5. Data that does not appear until the fight is final.

## 2. Officially documented facts

Cito currently documents:

- Base URL: `https://api.citoapi.com/api/v1`
- Authentication through the `x-api-key` request header.
- `GET /ufc/live` for active-card state, clocks, lag, and recommended polling intervals.
- `GET /ufc/live/{boutId}` for one live bout.
- `GET /ufc/live/stream` for an SSE feed.
- `GET /ufc/bouts/{boutId}/stats?round=N` for bout statistics filtered to one selected round.
- `GET /ufc/bouts/{boutId}/rounds?round=N` for round-by-round fighter rows filtered to one selected round.
- Exact-round data can include knockdowns, significant strikes, total strikes, takedowns, submission attempts, reversals, control time, head/body/leg splits, and distance/clinch/ground splits.

Cito does **not** document how quickly the two exact-round endpoints update during an ongoing fight. That is what this test measures.

Official references:

- [Cito UFC API documentation](https://citoapi.com/docs/api/ufc/)
- [Cito UFC Live API documentation](https://citoapi.com/docs/api/ufc/live/)
- [Cito authentication](https://citoapi.com/docs/authentication/)
- [Cito rate limits](https://citoapi.com/docs/rate-limits/)

## 3. Rate-limit constraints

The current documented free tier provides:

- 500 requests per month
- 10 requests per minute
- Burst limit of 20

Do **not** poll Cito every one or two seconds with a free key for the entire card. That would exhaust the monthly allowance quickly.

This plan instead uses:

- One long-running SSE connection when possible.
- Infrequent health and discovery requests.
- Controlled round probes at `T+0`, `T+5`, `T+15`, `T+30`, `T+60`, and `T+120` seconds.
- Only two or three selected fights for the first validation run.

Testing both exact-round endpoints uses 12 requests per round. A three-round fight therefore uses up to 36 round-probe requests, plus a small number of discovery and reconciliation requests.

## 4. Required tools

The commands below assume macOS or Linux with:

```bash
curl --version
jq --version
git --version
```

Install `jq` on macOS when needed:

```bash
brew install jq
```

## 5. Set up the test environment

Run these commands from the repository root:

```bash
mkdir -p test-results/cito-live

export CITO_BASE="https://api.citoapi.com/api/v1"
read -s -p "Cito API key: " CITO_API_KEY
echo
export CITO_API_KEY

export TEST_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
export TEST_DIR="test-results/cito-live/${TEST_RUN_ID}"
mkdir -p "$TEST_DIR"

printf 'test_run_id=%s\nstarted_at_utc=%s\n' \
  "$TEST_RUN_ID" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  | tee "$TEST_DIR/run.env"
```

Never place the actual API key in `run.env`, the repository, command output, screenshots, or committed logs.

Add the results directory to `.gitignore` unless sanitized results will intentionally be committed:

```bash
grep -qxF 'test-results/cito-live/' .gitignore 2>/dev/null || \
  echo 'test-results/cito-live/' >> .gitignore
```

## 6. Verify authentication and worker health

```bash
curl -sS \
  --connect-timeout 10 \
  --max-time 20 \
  -D "$TEST_DIR/health.headers" \
  -o "$TEST_DIR/health.json" \
  "$CITO_BASE/ufc/live/health" \
  -H "x-api-key: $CITO_API_KEY"

jq . "$TEST_DIR/health.json"
```

Check the HTTP response and rate-limit headers:

```bash
grep -Ei '^(HTTP/|x-ratelimit-|retry-after:)' "$TEST_DIR/health.headers" || true
```

Expected result:

- HTTP `200`
- Valid JSON
- No `401`, `403`, or `429`

Stop and fix authentication if this step fails.

## 7. Discover the weekend event

Fetch upcoming events:

```bash
curl -sS \
  --connect-timeout 10 \
  --max-time 20 \
  -D "$TEST_DIR/upcoming.headers" \
  -o "$TEST_DIR/upcoming.json" \
  "$CITO_BASE/ufc/events/upcoming" \
  -H "x-api-key: $CITO_API_KEY"

jq . "$TEST_DIR/upcoming.json" | less
```

Print likely event identifiers without assuming an exact response wrapper:

```bash
jq -r '
  .. | objects |
  select(
    has("eventSlug") or has("slug") or
    has("eventName") or has("name") or has("title")
  ) |
  {
    slug: (.eventSlug // .slug // empty),
    name: (.eventName // .name // .title // empty),
    date: (.startDate // .date // .startTime // .scheduledAt // empty)
  } |
  select(.slug != "" or .name != "")
' "$TEST_DIR/upcoming.json"
```

Select the August 1, 2026 card and export its actual Cito slug:

```bash
export EVENT_SLUG="REPLACE_WITH_ACTUAL_CITO_EVENT_SLUG"
printf 'event_slug=%s\n' "$EVENT_SLUG" | tee -a "$TEST_DIR/run.env"
```

Do not guess the slug from the UFC website URL. Use the value returned by Cito.

## 8. Fetch the event and bout list

```bash
curl -sS \
  --connect-timeout 10 \
  --max-time 20 \
  -D "$TEST_DIR/event.headers" \
  -o "$TEST_DIR/event.json" \
  "$CITO_BASE/ufc/events/$EVENT_SLUG" \
  -H "x-api-key: $CITO_API_KEY"

curl -sS \
  --connect-timeout 10 \
  --max-time 20 \
  -D "$TEST_DIR/bouts.headers" \
  -o "$TEST_DIR/bouts.json" \
  "$CITO_BASE/ufc/events/$EVENT_SLUG/bouts" \
  -H "x-api-key: $CITO_API_KEY"

jq . "$TEST_DIR/bouts.json" | less
```

Print candidate bout IDs and fighter names:

```bash
jq -r '
  .. | objects |
  select(has("boutId") or has("fightMetricId")) |
  {
    boutId: (.boutId // empty),
    fightMetricId: (.fightMetricId // empty),
    red: (
      .red.fighterName // .red.name //
      .redFighter.name // .fighter1.name // empty
    ),
    blue: (
      .blue.fighterName // .blue.name //
      .blueFighter.name // .fighter2.name // empty
    )
  } |
  select(.boutId != "" or .fightMetricId != "")
' "$TEST_DIR/bouts.json"
```

The agent must inspect the actual JSON and record the correct identifier expected by the exact-round endpoints. Do not blindly use an unrelated generic `id` field.

## 9. Start a raw SSE capture

Cito documents the SSE endpoint as available now. Capture the unmodified event stream so later conclusions do not depend on a guessed schema.

```bash
export SSE_LOG="$TEST_DIR/sse-${EVENT_SLUG}.log"

nohup bash -lc '
  curl -sS -N --no-buffer \
    --connect-timeout 15 \
    --max-time 28800 \
    "'"$CITO_BASE"'/ufc/live/stream?eventSlug='"$EVENT_SLUG"'" \
    -H "x-api-key: '"$CITO_API_KEY"'" \
    -H "Accept: text/event-stream" \
  | while IFS= read -r line; do
      printf "%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line"
    done
' > "$SSE_LOG" 2>&1 &

export SSE_PID=$!
printf 'sse_pid=%s\nsse_log=%s\n' "$SSE_PID" "$SSE_LOG" | tee -a "$TEST_DIR/run.env"
```

Confirm it is running:

```bash
ps -p "$SSE_PID" -o pid,etime,command
tail -f "$SSE_LOG"
```

Use `Ctrl+C` to stop following the file; that does not stop the background SSE process.

To stop the SSE process after the card:

```bash
kill "$SSE_PID" 2>/dev/null || true
```

### SSE usage uncertainty

The documentation does not clearly state how a long-running SSE connection is counted against the monthly request allowance. Record the API dashboard usage before and after the event when possible.

## 10. Optional low-frequency live overview capture

Use this only if SSE fails. One request every 60 seconds remains below the per-minute limit but can still consume hundreds of monthly requests over a long card.

```bash
export OVERVIEW_DIR="$TEST_DIR/live-overview"
mkdir -p "$OVERVIEW_DIR"

nohup bash -lc '
  while true; do
    ts=$(date -u +%Y%m%dT%H%M%SZ)
    curl -sS \
      --connect-timeout 10 \
      --max-time 20 \
      "'"$CITO_BASE"'/ufc/live" \
      -H "x-api-key: '"$CITO_API_KEY"'" \
      -o "'"$OVERVIEW_DIR"'/${ts}.json" || true
    sleep 60
  done
' > "$TEST_DIR/live-overview.log" 2>&1 &

export OVERVIEW_PID=$!
printf 'overview_pid=%s\n' "$OVERVIEW_PID" | tee -a "$TEST_DIR/run.env"
```

Stop it after the selected test fights:

```bash
kill "$OVERVIEW_PID" 2>/dev/null || true
```

## 11. Create the exact-round probing script

The following command creates a local test helper. It queries both documented exact-round endpoints at controlled delays and saves response bodies, headers, HTTP status, request duration, timestamps, and SHA-256 hashes.

```bash
cat > "$TEST_DIR/probe-cito-round.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

: "${CITO_API_KEY:?CITO_API_KEY is required}"
: "${CITO_BASE:=https://api.citoapi.com/api/v1}"
: "${TEST_DIR:?TEST_DIR is required}"

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 BOUT_ID ROUND_NUMBER" >&2
  exit 64
fi

BOUT_ID="$1"
ROUND="$2"

if ! [[ "$ROUND" =~ ^[1-5]$ ]]; then
  echo "ROUND_NUMBER must be an integer from 1 through 5" >&2
  exit 64
fi

ROUND_DIR="$TEST_DIR/bouts/$BOUT_ID/round-$ROUND"
mkdir -p "$ROUND_DIR"

probe_endpoint() {
  local endpoint_path="$1"
  local endpoint_name="$2"
  local elapsed="$3"
  local ts prefix http_code duration body_hash

  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  prefix="$ROUND_DIR/tplus-${elapsed}s-${endpoint_name}-${ts}"

  read -r http_code duration < <(
    curl -sS \
      --connect-timeout 10 \
      --max-time 25 \
      -D "${prefix}.headers" \
      -o "${prefix}.json" \
      -w '%{http_code} %{time_total}\n' \
      "$CITO_BASE$endpoint_path" \
      -H "x-api-key: $CITO_API_KEY" \
      -H "Accept: application/json"
  )

  if command -v shasum >/dev/null 2>&1; then
    body_hash="$(shasum -a 256 "${prefix}.json" | awk '{print $1}')"
  else
    body_hash="$(sha256sum "${prefix}.json" | awk '{print $1}')"
  fi

  jq -S . "${prefix}.json" > "${prefix}.pretty.json" 2>/dev/null || \
    cp "${prefix}.json" "${prefix}.pretty.json"

  jq -r 'paths(scalars) | map(tostring) | join(".")' \
    "${prefix}.json" > "${prefix}.paths.txt" 2>/dev/null || true

  jq -r '
    .. | objects | to_entries[]? |
    select(
      .key | test(
        "knock|significant|sig_str|total|takedown|submission|sub_att|reversal|control|head|body|leg|distance|clinch|ground";
        "i"
      )
    ) |
    "\(.key)=\(.value | @json)"
  ' "${prefix}.json" > "${prefix}.stat-fields.txt" 2>/dev/null || true

  {
    printf 'observed_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'elapsed_after_round_end_seconds=%s\n' "$elapsed"
    printf 'bout_id=%s\n' "$BOUT_ID"
    printf 'round=%s\n' "$ROUND"
    printf 'endpoint=%s\n' "$endpoint_path"
    printf 'http_code=%s\n' "$http_code"
    printf 'duration_seconds=%s\n' "$duration"
    printf 'sha256=%s\n' "$body_hash"
    grep -Ei '^(x-ratelimit-|retry-after:)' "${prefix}.headers" || true
  } | tee "${prefix}.metadata.txt"
}

# Delays are measured from the moment this script is launched.
# Launch it as close as possible to the observed round-ending horn or stoppage.
delays=(0 5 15 30 60 120)
previous=0

printf 'probe_started_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  | tee "$ROUND_DIR/probe-start.txt"

for elapsed in "${delays[@]}"; do
  sleep_for=$((elapsed - previous))
  if (( sleep_for > 0 )); then
    sleep "$sleep_for"
  fi

  probe_endpoint \
    "/ufc/bouts/$BOUT_ID/stats?round=$ROUND" \
    "stats" \
    "$elapsed"

  probe_endpoint \
    "/ufc/bouts/$BOUT_ID/rounds?round=$ROUND" \
    "rounds" \
    "$elapsed"

  previous="$elapsed"
done

printf 'probe_finished_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  | tee "$ROUND_DIR/probe-finish.txt"
SCRIPT

chmod +x "$TEST_DIR/probe-cito-round.sh"
```

## 12. Run a probe immediately after a round ends

First export the actual Cito bout identifier for the selected fight:

```bash
export BOUT_ID="REPLACE_WITH_ACTUAL_CITO_BOUT_ID"
```

At the Round 1 horn, or immediately after a stoppage ending Round 1, run:

```bash
"$TEST_DIR/probe-cito-round.sh" "$BOUT_ID" 1 \
  | tee "$TEST_DIR/bouts/${BOUT_ID}-round-1-console.log"
```

At the Round 2 horn:

```bash
"$TEST_DIR/probe-cito-round.sh" "$BOUT_ID" 2 \
  | tee "$TEST_DIR/bouts/${BOUT_ID}-round-2-console.log"
```

Run probes for later rounds in the same way:

```bash
"$TEST_DIR/probe-cito-round.sh" "$BOUT_ID" 3
"$TEST_DIR/probe-cito-round.sh" "$BOUT_ID" 4
"$TEST_DIR/probe-cito-round.sh" "$BOUT_ID" 5
```

Only run a probe for a round that actually occurred.

### Important concurrency note

The probe runs for about two minutes. Start each round probe in the background so the terminal remains available:

```bash
"$TEST_DIR/probe-cito-round.sh" "$BOUT_ID" 1 \
  > "$TEST_DIR/bouts/${BOUT_ID}-round-1-console.log" 2>&1 &

echo $! > "$TEST_DIR/bouts/${BOUT_ID}-round-1.pid"
```

This also permits the Round 2 probe to begin even if a delayed Round 1 probe is finishing.

## 13. Detect the exact moment a new Cito live round appears

While the fight is active, inspect the SSE log:

```bash
tail -f "$SSE_LOG"
```

Search it afterward for round, clock, status, and bout identifiers:

```bash
grep -Ei 'currentRound|currentTime|status|boutId|fightMetricId|winner|method' \
  "$SSE_LOG" \
  | tail -n 200
```

Record three distinct timestamps when possible:

1. The real-world round-ending horn or stoppage.
2. The first Cito live update indicating the next round or final state.
3. The first complete exact-round response.

Do not treat the live clock or `currentRound` transition as proof that the full round-stat row is already available.

## 14. Define a complete round response

A response counts as **complete** only when all of the following are true:

- HTTP status is `200`.
- The response represents the requested bout.
- The response represents exactly the requested round.
- Both fighters have stat rows.
- The response is not merely an empty success wrapper.
- The core expected fields are present for each fighter.

Expected round-level categories:

- Knockdowns
- Significant strikes landed and attempted
- Total strikes landed and attempted
- Takedowns landed and attempted
- Submission attempts
- Reversals
- Control time
- Head strikes landed and attempted
- Body strikes landed and attempted
- Leg strikes landed and attempted
- Distance strikes landed and attempted
- Clinch strikes landed and attempted
- Ground strikes landed and attempted

The actual JSON property names may differ. The agent must document the real schema rather than forcing guessed names.

## 15. Inspect one captured response

List captured files:

```bash
find "$TEST_DIR/bouts/$BOUT_ID" -type f | sort
```

Open the formatted JSON files:

```bash
find "$TEST_DIR/bouts/$BOUT_ID" \
  -name '*.pretty.json' \
  -print \
  -exec jq . {} \;
```

List every scalar JSON path to discover the actual schema:

```bash
find "$TEST_DIR/bouts/$BOUT_ID" \
  -name '*.paths.txt' \
  -print \
  -exec cat {} \;
```

List only likely stat fields:

```bash
find "$TEST_DIR/bouts/$BOUT_ID" \
  -name '*.stat-fields.txt' \
  -print \
  -exec cat {} \;
```

## 16. Find the first nonempty response

A schema-agnostic first pass is to compare body sizes and hashes:

```bash
find "$TEST_DIR/bouts/$BOUT_ID" \
  -name '*.json' ! -name '*.pretty.json' \
  -exec sh -c 'printf "%8s bytes  %s\n" "$(wc -c < "$1")" "$1"' _ {} \; \
  | sort -n
```

Review each response in chronological order. Record the earliest delay at which both fighter rows and the complete expected field set are present.

## 17. Post-fight reconciliation

Five to ten minutes after the fight ends, fetch every completed round again.

```bash
export FINAL_DIR="$TEST_DIR/bouts/$BOUT_ID/final-reconciliation"
mkdir -p "$FINAL_DIR"

for round in 1 2 3; do
  ts="$(date -u +%Y%m%dT%H%M%SZ)"

  curl -sS \
    --connect-timeout 10 \
    --max-time 25 \
    "$CITO_BASE/ufc/bouts/$BOUT_ID/stats?round=$round" \
    -H "x-api-key: $CITO_API_KEY" \
    -o "$FINAL_DIR/round-${round}-stats-${ts}.json"

  curl -sS \
    --connect-timeout 10 \
    --max-time 25 \
    "$CITO_BASE/ufc/bouts/$BOUT_ID/rounds?round=$round" \
    -H "x-api-key: $CITO_API_KEY" \
    -o "$FINAL_DIR/round-${round}-rounds-${ts}.json"

done
```

Adjust the round list for a five-round fight or an early finish. Do not request rounds that never happened.

## 18. Compare live-round data with final data

Choose the earliest apparently complete live response and the matching final response:

```bash
export LIVE_FILE="REPLACE_WITH_EARLIEST_COMPLETE_LIVE_JSON"
export FINAL_FILE="REPLACE_WITH_MATCHING_FINAL_JSON"

jq -S . "$LIVE_FILE" > "$TEST_DIR/live-sorted.json"
jq -S . "$FINAL_FILE" > "$TEST_DIR/final-sorted.json"

diff -u "$TEST_DIR/live-sorted.json" "$TEST_DIR/final-sorted.json" \
  | tee "$TEST_DIR/live-vs-final.diff" || true
```

Interpretation:

- Empty diff: the live round data matched the later final response.
- Numeric changes: Cito published provisional data and later revised it.
- Structural changes: fields or rows were added later.
- No live response: exact-round data was unavailable before fight completion.

## 19. Optional compact timeline report command

Print probe metadata in chronological order:

```bash
find "$TEST_DIR/bouts/$BOUT_ID" \
  -name '*.metadata.txt' \
  -print0 \
  | xargs -0 grep -H -E \
      'observed_at_utc=|elapsed_after_round_end_seconds=|endpoint=|http_code=|duration_seconds=|sha256=' \
  | sort \
  | tee "$TEST_DIR/bouts/$BOUT_ID/timeline.txt"
```

## 20. Pass/fail classifications

Classify each tested round as one of these:

### A. Complete during fight

Both fighters and all expected round categories appeared before the fight ended.

Record:

- First complete delay
- Endpoint that became complete first
- Whether later values changed

### B. Partial during fight

Some data appeared during the fight, but rows or categories were missing.

Record:

- First partial delay
- Missing fields
- First complete delay, if one occurred

### C. Available only after fight

No usable exact-round data appeared until the bout became final.

Record:

- All live probe results
- First post-fight availability time

### D. Endpoint or identifier mismatch

The endpoint returned `404`, a different bout, an error wrapper, or a permanently empty result.

Before concluding that Cito lacks live round data, verify:

- Correct event slug
- Correct Cito bout ID
- Correct round number
- Correct endpoint family
- Valid API authorization

### E. Rate-limited or infrastructure failure

The test could not determine availability because of `429`, `5xx`, timeout, SSE outage, or worker degradation.

Record exact headers and bodies and do not treat this as evidence about round publication behavior.

## 21. Required agent report

After the event, create:

```text
test-results/cito-live/<TEST_RUN_ID>/REPORT.md
```

Use this structure:

```markdown
# Cito Live Round-Stats Test Report

## Event
- Event:
- Date:
- Cito event slug:
- Test start/end UTC:
- API plan:

## Environment
- OS:
- curl version:
- jq version:
- Git commit:

## Tested bouts
| Bout ID | Red fighter | Blue fighter | Scheduled rounds | Finish |
|---|---|---|---:|---|

## Round availability
| Bout | Round | Endpoint | T+0 | T+5 | T+15 | T+30 | T+60 | T+120 | First complete | Before fight end? |
|---|---:|---|---|---|---|---|---|---|---|---|

Use `empty`, `partial`, `complete`, `error`, or `not tested` in each timing column.

## Fields observed
List the exact JSON paths returned for:
- Knockdowns
- Significant strikes
- Total strikes
- Takedowns
- Submission attempts
- Reversals
- Control time
- Head/body/leg
- Distance/clinch/ground

## Live versus final revisions
For every changed value, report:
- Bout
- Round
- Fighter
- Field
- Earliest live value
- Final value
- Time of revision

## SSE findings
- Did the stream connect?
- Event types observed:
- Heartbeat interval:
- First active-bout signal:
- Round-transition behavior:
- Final-state behavior:
- Disconnects/reconnects:
- Apparent request-quota effect:

## Errors and rate limits
Include status codes, `Retry-After`, and rate-limit headers without exposing the API key.

## Conclusion
Answer explicitly:
1. Are exact individual-round stats available before a live fight ends?
2. Which endpoint is better: `/stats?round=N` or `/rounds?round=N`?
3. What is the median and worst observed publication delay?
4. Are live values revised later?
5. Which fields are reliably present?
6. What retry schedule should the production application use?
7. Should ESPN remain the round-end trigger?

## Recommended production policy
Provide the exact retry schedule, provisional/final state rules, and reconciliation behavior supported by the evidence.
```

## 22. Recommended initial production policy pending the test

Until this experiment produces evidence, implement the conservative workflow:

```text
ESPN detects Round N ended
        ↓
Cito request at T+5 seconds
        ↓
Retry at T+15, T+30, T+60, and T+120 only if missing or incomplete
        ↓
Store available data as provisional
        ↓
Re-fetch every completed round 5–10 minutes after the fight ends
        ↓
Mark final only after reconciliation
```

Do not assume that Cito's live endpoint and exact-round endpoint update simultaneously.

## 23. Agent execution instructions

The testing agent must:

1. Read this entire file before the event.
2. Confirm the API key works without printing it.
3. Discover the actual Cito event slug and bout IDs from API responses.
4. Start raw SSE capture before the card.
5. Select at least two fights, preferably:
   - One decision or multi-round fight.
   - One fight that ends early, if available.
6. Launch exact-round probes immediately after each observed round end.
7. Preserve raw bodies and headers before interpreting them.
8. Stay within documented rate limits.
9. Perform post-fight reconciliation.
10. Produce `REPORT.md` with evidence-backed conclusions.
11. Never claim success based only on HTTP `200`; inspect both fighter rows and all expected fields.
12. Never commit the Cito API key or unsanitized secret-bearing logs.

## 24. Final decision this test should enable

After this weekend, the project should be able to choose one of these evidence-based designs:

- **Immediate live import:** full exact-round stats are consistently available within a short delay.
- **Provisional live import:** stats appear during the fight but require later correction.
- **Post-fight-only import:** full exact-round stats should not be expected until completion.
- **Hybrid:** a subset comes from Cito live data during the round, while the full exact-round row is imported later.

The implementation must follow the observed behavior rather than assumptions from abbreviated documentation.

## 25. Copy-paste instruction for the testing agent

```text
Execute the live Cito validation plan in cito-live-round-stats-weekend-test.md during this weekend's UFC card. Read the entire file before acting. Prepare the environment and scripts before the event, discover the real Cito event slug and bout IDs from the API, start raw SSE capture, and test at least two bouts. For every completed round, run both exact-round endpoints at the specified T+0, T+5, T+15, T+30, T+60, and T+120 checkpoints without exceeding the documented rate limits. Preserve raw JSON bodies, response headers, timestamps, hashes, and errors. Re-fetch every tested round after the fight for reconciliation. Produce the required REPORT.md with the first partial and complete availability times, exact field paths, live-versus-final revisions, SSE behavior, rate-limit impact, and an evidence-based production retry policy. Never print or commit the Cito API key. Do not infer success from HTTP 200 alone. If an endpoint shape differs from the plan, inspect the returned JSON, adapt safely, document the change, and continue.
```
