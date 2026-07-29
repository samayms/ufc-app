#!/bin/sh
#
# Wrapper the scheduler invokes. Kept separate from the launchd job so the
# schedule and the work stay independent: this script is what you run by hand
# to check the job does what you think, and nothing in it knows about launchd.
#
# Exits 0 when a document was produced, including when individual providers
# failed — a provider outage is something the dashboard displays, not something
# the scheduler should alert on. Only an unusable ESPN schedule exits non-zero.
set -eu

cd "$(dirname "$0")/.."

# node is not on launchd's default PATH.
if [ -n "${UFC_NODE_BIN:-}" ]; then
  NODE="$UFC_NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE=node
else
  echo "sync-upcoming: node not found; set UFC_NODE_BIN to its absolute path" >&2
  exit 1
fi

echo "=== upcoming odds sync $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
DATA_MODE=live exec "$NODE" --env-file-if-exists=.env server/syncUpcoming.ts
