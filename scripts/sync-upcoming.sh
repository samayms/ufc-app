#!/bin/sh
#
# Optional wrapper for a scheduler or a manual run. The resident collector is
# the primary owner of the pre-event schedule; this remains useful, and is the
# only way to get a sync when the collector is not running. Kept separate from
# launchd so the schedule and the work stay independent.
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
