#!/usr/bin/env bash
# Stability soak of the reference server with the fake runner: concurrent
# conversations (random waits, failures, cancels, retries, branches and
# every way they end, searches, and every P1-P3 feature: the inbox, leaves,
# seeds, spinoffs, rebalance, goals, relations, open loops, groups, pins,
# the fisheye, tags, folds, diverge / converge / decide, memories) for
# SOAK_DURATION, then checks that nothing is stuck (pending turns, jobs of
# every kind, drafts, thinking lines), that nothing dangles, that the
# invariants held, and that goroutines, memory and connections came back.
# See scripts/soak/main.go for what the driver does.
#
#   SOAK_DURATION=1h scripts/soak.sh          (default 1h)
#   SOAK_WORKERS=8 SOAK_SEED=1 TANGENT_SOAK_PORT=8122
#   SOAK_FEATURES=full     every feature, auto wherever auto changes what the
#                          AI does (default; memory with the fake Embedder);
#                          the run fails unless every operation succeeded once
#   SOAK_FEATURES=default  the reference server's default features
#   SOAK_FEATURES=<list>   a TANGENT_FEATURES value of your own
#
# Needs: docker (the tangent-postgres container, `make db-up`), go.
# The database tangent_soak is dropped and created fresh on every run; the
# report and the server log are kept in SOAK_OUT (default $TMPDIR/tangent-soak).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${TANGENT_SOAK_CONTAINER:-tangent-postgres}"
DB="tangent_soak"
PORT="${TANGENT_SOAK_PORT:-8122}"
BASE="http://127.0.0.1:${PORT}"
DURATION="${SOAK_DURATION:-1h}"
WORKERS="${SOAK_WORKERS:-8}"
SEED="${SOAK_SEED:-1}"
OUT="${SOAK_OUT:-${TMPDIR:-/tmp}/tangent-soak}"
FEATURES="${SOAK_FEATURES:-full}"
DATABASE_URL="postgres://tangent:tangent@localhost:5444/${DB}?sslmode=disable"
# FULL_FEATURES: auto for summary, branch_suggest, leaf, rebalance, goal,
# relations, group and fold (background jobs run on their own); ibis stays
# suggest (auto writes confirmed tags, so the AI's drafts could not be
# confirmed); diverge is manual in every mode; memory:suggest as the work
# order asks (its suggestions go through the inbox).
FULL_FEATURES="notes,chapters,aside,summary:auto,card_draft,branch_suggest:auto,search,leaf:auto,parking,spinoff,rebalance:auto,\
goal:auto,relations:auto,open_loops,fisheye,group:auto,ibis:suggest,fold:auto,diverge:manual,memory:suggest"
REQUIRE_OPS=()
case "$FEATURES" in
  full) FEATURES="$FULL_FEATURES"; REQUIRE_OPS=(-require-ops) ;;
  default) FEATURES="" ;;
esac
WORK="$(mktemp -d)"
TOKEN_FILE="$WORK/token"
(umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$TOKEN_FILE")
SERVER_PID=""

cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "SOAK FAILED: $*" >&2
  [[ -f "$OUT/server.log" ]] && { echo "--- server log (tail)" >&2; tail -n 30 "$OUT/server.log" >&2; }
  exit 1
}
step() { echo "== $(date +%T) $*"; }

for tool in docker go; do
  command -v "$tool" >/dev/null || fail "$tool is required"
done
mkdir -p "$OUT"

step "fresh database $DB"
docker exec "$CONTAINER" psql -q -U tangent -d tangent -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null ||
  fail "cannot reach $CONTAINER (run make db-up)"
docker exec "$CONTAINER" psql -q -U tangent -d tangent -c "CREATE DATABASE $DB OWNER tangent" >/dev/null

step "build the server and the driver"
(cd "$ROOT" && go build -o "$WORK/tangent-server" ./cmd/tangent-server && go build -o "$WORK/soak" ./scripts/soak)

step "start the server on :$PORT"
TANGENT_DATABASE_URL="$DATABASE_URL" TANGENT_ADDR="127.0.0.1:${PORT}" TANGENT_TOKEN="$(cat "$TOKEN_FILE")" \
  TANGENT_PROVIDER=fake TANGENT_FAKE_CHUNK_DELAY=10ms TANGENT_DEBUG_STATS=1 TANGENT_MAINTAIN_INTERVAL=10s \
  TANGENT_RATE_LIMIT=1000000 TANGENT_RATE_BURST=100000 TANGENT_LOG_LEVEL=warn \
  TANGENT_FEATURES="$FEATURES" TANGENT_EMBEDDER=fake \
  "$WORK/tangent-server" >"$OUT/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 100); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || fail "the server exited"
  sleep 0.1
done

step "drive $WORKERS workers for $DURATION (features: ${FEATURES:-the server default})"
set +e
"$WORK/soak" -base "$BASE" -token-file "$TOKEN_FILE" -database "$DATABASE_URL" -duration "$DURATION" \
  -workers "$WORKERS" -seed "$SEED" -report "$OUT/report.json" "${REQUIRE_OPS[@]}"
DRIVER=$?
set -e

step "graceful shutdown"
kill -TERM "$SERVER_PID"
wait "$SERVER_PID" || fail "the server exited with $?"
SERVER_PID=""
[[ "$DRIVER" == 0 ]] || fail "the driver reported problems (exit $DRIVER); see $OUT/report.json"
# The server logs ERROR only for what should never happen; the fake
# runner's scripted failures are warnings.
ERRORS="$(grep -c 'level=ERROR' "$OUT/server.log" || true)"
if [[ "$ERRORS" != 0 ]]; then
  grep 'level=ERROR' "$OUT/server.log" | head -n 20 >&2
  fail "the server logged $ERRORS ERROR lines"
fi
echo "SOAK PASSED ($OUT/report.json)"
