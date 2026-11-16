#!/usr/bin/env bash
# Starts the reference server for the real-API e2e run (F1): a fresh
# database `tangent_e2e_<port>` in the tangent-postgres container (one per
# run, so parallel runs never share one), the fake runner with a visible
# streaming pace, and the tokens the Playwright config made. Never touches
# the dev database or the dev ports 8120 / 8121.
set -euo pipefail
: "${TANGENT_E2E_API_PORT:?set by playwright.config.ts}"
: "${TANGENT_TOKEN:?set by playwright.config.ts}"

container="${TANGENT_E2E_PG_CONTAINER:-tangent-postgres}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
# One binary per server: two servers (api, api-core) build at the same time.
bin="$here/../.cache/tangent-server-${TANGENT_E2E_API_PORT}"
db="tangent_e2e_${TANGENT_E2E_API_PORT}"
psql() { docker exec "$container" psql -U tangent -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

# Earlier runs' databases that nothing is connected to any more are dropped (no FORCE: a parallel run keeps its own).
# This run's other server may not have connected yet, so its database (TANGENT_E2E_KEEP_PORTS) is kept.
keep=" ${TANGENT_E2E_KEEP_PORTS:-} "
for old in $(psql -c "SELECT datname FROM pg_database WHERE datname LIKE 'tangent\_e2e\_%'"); do
  [[ "$keep" == *" ${old#tangent_e2e_} "* ]] && continue
  psql -c "DROP DATABASE IF EXISTS \"$old\"" >/dev/null 2>&1 || true
done
psql -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" -c "CREATE DATABASE \"$db\""

mkdir -p "$(dirname "$bin")"
# Earlier runs' binaries go too (ports are random), except this run's.
for old in "$(dirname "$bin")"/tangent-server*; do
  [[ -e "$old" && "$keep" != *" ${old##*tangent-server-} "* ]] && rm -f "$old"
done
# TANGENT_E2E_SRC builds from another copy of the Go code (e.g. `git archive HEAD` while someone edits the working tree).
(cd "${TANGENT_E2E_SRC:-$root}" && go build -o "$bin" ./cmd/tangent-server)

export TANGENT_DATABASE_URL="postgres://tangent:tangent@localhost:5444/${db}?sslmode=disable"
export TANGENT_ADDR="127.0.0.1:${TANGENT_E2E_API_PORT}"
export TANGENT_PROVIDER=fake
export TANGENT_FAKE_CHUNK_DELAY="${TANGENT_FAKE_CHUNK_DELAY:-60ms}"
export TANGENT_PRICING='{"fake-1":{"input":3,"output":15}}'
export TANGENT_RATE_LIMIT=100000
export TANGENT_RATE_BURST=10000
export TANGENT_LOG_LEVEL="${TANGENT_LOG_LEVEL:-warn}"
exec "$bin"
