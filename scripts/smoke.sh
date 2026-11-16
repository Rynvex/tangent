#!/usr/bin/env bash
# Smoke test of the reference server with the fake runner, over curl:
# main line -> two turns -> branch preview -> branch -> rename -> draft (with a
# note proposal) -> merge -> next turn carries the card -> promote -> retry ->
# move -> leaves, seeds, the suggestion inbox, spinoff and rebalance (B8) ->
# goal, drift, relations, pins and open loops (B9) -> the shared budget and
# the fisheye context (B9 part B) -> groups, combine (open children re-hung,
# B9.1), a relation's label (B9 part C) -> argument tags and folds (B10
# part A) -> diverge, converge, decide (B10 part B) -> memories (B10 part
# C, the fake Embedder) -> search -> B14 (search one tree, diverge across
# models, a batch of seeds, export) -> B15 (relation kinds, a tag put back
# as a draft, the tree's tag drafts) -> B16 ([TOPIC] and [CHAPTER] reply
# lines) -> B17 -> B18 (import, folders and tags, organization, decompose, extract with
# and without a card) -> B19 (an import with dates, chapter cuts and a merged
# branch) -> B20 (attach another conversation as a branch, open and merged)
# -> B22 (the import analysis) -> B23 (keep an aside, continue it as a
# branch, delete a discarded branch) -> B24 (the glossary) -> B25 (an
# import batch undone, a pinned conversation) -> delete,
# and the matching events on /events.
#
# Needs: docker (the tangent-postgres container, `make db-up`), go, curl, jq.
# The database tangent_smoke is dropped and created fresh on every run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${TANGENT_SMOKE_CONTAINER:-tangent-postgres}"
DB="tangent_smoke"
PORT="${TANGENT_SMOKE_PORT:-8121}"
BASE="http://127.0.0.1:${PORT}"
TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
WORK="$(mktemp -d)"
# The token goes to curl through a header file, never on the command line.
AUTH="$WORK/auth.header"
(umask 077 && printf 'Authorization: Bearer %s\n' "$TOKEN" >"$AUTH")
SERVER_PID=""
EVENTS_PID=""

cleanup() {
  [[ -n "$EVENTS_PID" ]] && kill "$EVENTS_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "SMOKE FAILED: $*" >&2
  [[ -f "$WORK/server.log" ]] && { echo "--- server log (tail)" >&2; tail -n 30 "$WORK/server.log" >&2; }
  exit 1
}
step() { echo "== $*"; }

for tool in docker go curl jq; do
  command -v "$tool" >/dev/null || fail "$tool is required"
done

step "fresh database $DB"
docker exec "$CONTAINER" psql -q -U tangent -d tangent -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null ||
  fail "cannot reach $CONTAINER (run make db-up)"
docker exec "$CONTAINER" psql -q -U tangent -d tangent -c "CREATE DATABASE $DB OWNER tangent" >/dev/null

step "build and start the reference server on :$PORT"
(cd "$ROOT" && go build -o "$WORK/tangent-server" ./cmd/tangent-server)
TANGENT_DATABASE_URL="postgres://tangent:tangent@localhost:5444/${DB}?sslmode=disable" \
  TANGENT_ADDR="127.0.0.1:${PORT}" TANGENT_TOKEN="$TOKEN" TANGENT_PROVIDER=fake \
  TANGENT_FAKE_CHUNK_DELAY=5ms TANGENT_RATE_BURST=1000 TANGENT_FEATURES="notes,chapters,aside,summary:suggest,card_draft,branch_suggest:suggest,search,leaf:suggest,parking,suggestion_probe,spinoff,rebalance:suggest,goal:suggest,relations:suggest,open_loops,fisheye,group:suggest,ibis:suggest,fold:suggest,diverge:manual,memory:suggest,glossary" \
  "$WORK/tangent-server" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 100); do
  curl -sf "$BASE/health" >/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || fail "the server exited"
  sleep 0.1
done
curl -sf "$BASE/health" | jq -e '.status == "ok"' >/dev/null || fail "health"

# api METHOD PATH [BODY] -> prints the body; fails unless the status is 2xx.
api() {
  local method=$1 path=$2 body=${3:-}
  local out status
  out="$(curl -sS -X "$method" -H @"$AUTH" -H 'Content-Type: application/json' \
    ${body:+--data "$body"} -w '\n%{http_code}' "$BASE/api$path")"
  status="${out##*$'\n'}"
  out="${out%$'\n'*}"
  [[ "$status" == 2* ]] || fail "$method $path -> $status $out"
  printf '%s' "$out"
}

# wait_turn LINE TURN: until the reply is no longer pending; prints it.
wait_turn() {
  local line=$1 turn=$2 msg
  for _ in $(seq 1 100); do
    msg="$(api GET "/lines/$line/messages?limit=500" | jq -c --arg id "$turn" '.messages[] | select(.id == $id)')"
    if [[ "$(jq -r .status <<<"$msg")" != "pending" ]]; then
      [[ "$(jq -r .status <<<"$msg")" == "done" ]] || fail "turn $turn ended as $(jq -c '{status, meta}' <<<"$msg")"
      printf '%s' "$msg"
      return
    fi
    sleep 0.1
  done
  fail "turn $turn did not finish"
}

# turn LINE CONTENT: sends a message and waits; prints the reply id.
turn() {
  local id
  id="$(api POST "/lines/$1/messages" "$(jq -nc --arg c "$2" '{content: $c}')" | jq -r .turnId)"
  wait_turn "$1" "$id" >/dev/null
  printf '%s' "$id"
}

step "subscribe to /events"
curl -sN -H @"$AUTH" "$BASE/api/events" >"$WORK/events.log" &
EVENTS_PID=$!
for _ in $(seq 1 50); do grep -q ': connected' "$WORK/events.log" 2>/dev/null && break; sleep 0.1; done

step "main line and two turns"
MAIN="$(api POST /lines '{"title":"Smoke trip","provider":"fake"}' | jq -r .id)"
turn "$MAIN" "When should I visit Kyoto?" >/dev/null
REPLY="$(turn "$MAIN" "Where should I stay?")"

step "preview a branch's background, open it, rename it"
api POST "/lines/$MAIN/branches/preview" "$(jq -nc --arg a "$REPLY" '{anchorMessageId: $a, kind: "investigate", includeLater: true}')" |
  jq -e '.tokenEstimate > 0 and .text == .pack.rendered' >/dev/null || fail "branch preview"
BRANCH="$(api POST "/lines/$MAIN/branches" "$(jq -nc --arg a "$REPLY" '{anchorMessageId: $a, purpose: "Compare ryokan and hotels", kind: "investigate"}')" | jq -r .line.id)"
api PATCH "/lines/$BRANCH/branch" '{"purpose":"Compare ryokan and business hotels"}' |
  jq -e '.branch.purpose == "Compare ryokan and business hotels"' >/dev/null || fail "rename"

step "a turn in the branch, draft (with a note proposal)"
turn "$BRANCH" "Is a ryokan worth it?" >/dev/null
api POST "/lines/$BRANCH/branch/draft" | jq -e '.jobId != "" and .provider == "fake"' >/dev/null || fail "draft 202"
for _ in $(seq 1 100); do
  DETAIL="$(api GET "/lines/$BRANCH/branch")"
  [[ "$(jq -r .draft.status <<<"$DETAIL")" != "drafting" ]] && break
  sleep 0.1
done
[[ "$(jq -r .draft.status <<<"$DETAIL")" == "ready" ]] || fail "draft: $(jq -c .draft <<<"$DETAIL")"
jq -e '.draft.noteChanges | length == 1' <<<"$DETAIL" >/dev/null || fail "the draft proposes a note: $(jq -c .draft <<<"$DETAIL")"

step "merge the card, the next turn carries it"
api POST "/lines/$BRANCH/branch/merge" "$(jq -c '{card: .draft.card, parentTipMessageId: .parentTipMessageId, noteChanges: .draft.noteChanges}' <<<"$DETAIL")" |
  jq -e '.branch.status == "merged" and .message.kind == "branch_card" and (.notes.created | length == 1)' >/dev/null || fail "merge"
turn "$MAIN" "Great, what next?" >/dev/null
api GET "/lines/$MAIN/messages?limit=500" | jq -e '[.messages[] | select(.kind == "branch_card" and .meta.delivered == true)] | length == 1' >/dev/null ||
  fail "the card was not delivered"

step "promote a branch"
ALT="$(api POST "/lines/$MAIN/branches" "$(jq -nc --arg a "$REPLY" '{anchorMessageId: $a, purpose: "Go in spring instead", kind: "alternative"}')" | jq -r .line.id)"
turn "$ALT" "Cherry blossoms?" >/dev/null
PROMOTED="$(api POST "/lines/$ALT/branch/promote" '{"confirm":true}')"
jq -e '.branch.status == "promoted" and .line.id == "'"$MAIN"'"' <<<"$PROMOTED" >/dev/null || fail "promote"
PREV="$(jq -r .previousMainLine.lineId <<<"$PROMOTED")"

step "a failed turn, retried"
FAILED="$(api POST "/lines/$MAIN/messages" '{"content":"[fake:error] please fail"}' | jq -r .turnId)"
for _ in $(seq 1 100); do
  [[ "$(api GET "/lines/$MAIN/messages?limit=500" | jq -r --arg id "$FAILED" '.messages[] | select(.id == $id) | .status')" == "error" ]] && break
  sleep 0.1
done
api POST "/lines/$MAIN/retry" | jq -e '.userMessage.content | contains("please fail")' >/dev/null || fail "retry"
sleep 0.5

step "move the last exchange into a branch"
turn "$MAIN" "Which week in spring?" >/dev/null
api POST "/lines/$MAIN/branches/move" '{"count":2,"purpose":"Pick the week"}' | jq -e '.movedMessageIds | length == 2' >/dev/null || fail "move"

step "B8: leaves (merge, dead end, draft for the previous main line, edit, delete)"
api GET "/lines/$BRANCH/leaf" | jq -e '.leaf.kind == "conclusion" and .leaf.status == "confirmed"' >/dev/null || fail "the merge left no leaf"
for _ in $(seq 1 100); do
  [[ "$(api GET "/lines/$PREV/leaf" | jq -r '.leaf.status // "none"')" == "draft" ]] && break
  sleep 0.1
done
api GET "/lines/$PREV/leaf" | jq -e '.leaf.status == "draft" and .leaf.aiDrafted == true' >/dev/null || fail "no leaf draft for the previous main line"
api PUT "/lines/$PREV/leaf" '{"kind":"decision","line":"Autumn was the old plan"}' | jq -e '.leaf.status == "confirmed" and .leaf.aiDrafted == false' >/dev/null ||
  fail "leaf put"
DEAD="$(api POST "/lines/$MAIN/branches" "$(jq -nc --arg a "$(api GET "/lines/$MAIN/messages?limit=500" | jq -r '[.messages[] | select(.role == "assistant" and .status == "done")][0].id')" \
  '{anchorMessageId: $a, purpose: "Look at Osaka", kind: "investigate"}')" | jq -r .line.id)"
turn "$DEAD" "Is Osaka close?" >/dev/null
api POST "/lines/$DEAD/branch/discard" '{"leaf":{"line":"Too far for this trip"}}' | jq -e '.branch.status == "discarded" and .branch.leaf.kind == "dead_end"' >/dev/null ||
  fail "discard with a dead end"
api DELETE "/lines/$DEAD/leaf" >/dev/null
api GET "/lines/$DEAD/leaf" | jq -e '.leaf == null' >/dev/null || fail "leaf delete"
api POST "/lines/$DEAD/leaf/draft" | jq -e '.kind == "leaf_draft" and .jobId != ""' >/dev/null || fail "leaf draft 202"
for _ in $(seq 1 100); do
  [[ "$(api GET "/lines/$DEAD/leaf" | jq -r '.leaf.status // "none"')" == "draft" ]] && break
  sleep 0.1
done
api GET "/lines/$DEAD/leaf" | jq -e '.leaf.aiDrafted == true' >/dev/null || fail "the asked-for leaf draft"

step "B8: seeds (park, expand, note, drop)"
SEED="$(api POST "/lines/$MAIN/seeds" '{"text":"Is a rail pass worth it?"}' | jq -r .seed.id)"
NOTE_SEED="$(api POST "/lines/$MAIN/seeds" '{"text":"Check the visa rules"}' | jq -r .seed.id)"
DROP_SEED="$(api POST "/lines/$MAIN/seeds" '{"text":"Maybe Kobe too"}' | jq -r .seed.id)"
api GET "/lines/$MAIN" | jq -e '.openSeeds == 3' >/dev/null || fail "open seed count"
api POST "/seeds/$SEED/expand" '{}' | jq -e '.branch.origin == "seed" and .seed.status == "expanded"' >/dev/null || fail "expand"
api POST "/seeds/$NOTE_SEED/to-note" '{}' | jq -e '.note.section == "to_confirm" and .seed.status == "noted"' >/dev/null || fail "to-note"
api POST "/seeds/$DROP_SEED/drop" | jq -e '.seed.status == "dropped"' >/dev/null || fail "drop"
api GET "/lines/$MAIN/seeds?status=all" | jq -e '(.seeds | length == 3) and ([.seeds[] | select(.status == "open")] | length == 0)' >/dev/null ||
  fail "seed list"

step "B8: the suggestion inbox (raised by the probe; goal and relations raise their own)"
turn "$MAIN" "Any structural advice? [probe:suggest]" >/dev/null
PROBE='[.suggestions[] | select(.kind == "probe")]'
SUGGESTION="$(api GET "/lines/$MAIN/suggestions" | jq -r "$PROBE[0].id")"
api POST "/suggestions/$SUGGESTION/accept" '{}' | jq -e '.suggestion.status == "accepted" and .result.accepted == true' >/dev/null || fail "accept"
turn "$MAIN" "Again? [probe:suggest]" >/dev/null
SUGGESTION="$(api GET "/lines/$MAIN/suggestions" | jq -r "$PROBE[0].id")"
for _ in $(seq 1 20); do
  OPEN="$(api GET "/lines/$MAIN/suggestions" | jq '.suggestions | length')"
  api GET "/lines/$MAIN" | jq -e --argjson n "$OPEN" '.openSuggestions == $n and $n >= 1' >/dev/null && break
  sleep 0.1
done
api GET "/lines/$MAIN" | jq -e --argjson n "$OPEN" '.openSuggestions == $n' >/dev/null || fail "open suggestion count"
api POST "/suggestions/$SUGGESTION/dismiss" | jq -e '.suggestion.status == "dismissed"' >/dev/null || fail "dismiss"
api GET "/lines/$MAIN/suggestions?status=all" | jq -e "$PROBE | length == 2" >/dev/null || fail "suggestion list"
api GET /capabilities | jq -e '[.features[] | select((.name == "suggestions" or .name == "parking" or .name == "leaf") and .enabled)] | length == 3' >/dev/null ||
  fail "B8 capabilities"

step "B8: spin off (fresh with notes, detach), links"
FIRST="$(api GET "/lines/$MAIN/messages?limit=500" | jq -r '[.messages[] | select(.role == "assistant" and .status == "done")][0].id')"
FRESH="$(api POST "/lines/$MAIN/spinoff" "$(jq -nc --arg a "$FIRST" '{mode: "fresh", atMessageId: $a, title: "Kyoto, short", copyNotes: true}')")"
jq -e '.line.spunOffFrom.lineId == "'"$MAIN"'" and .marker.meta.spunOffTo.lineId == .line.id and (.notes.created | length >= 1)' <<<"$FRESH" >/dev/null ||
  fail "fresh spinoff: $FRESH"
FRESH_ID="$(jq -r .line.id <<<"$FRESH")"
api POST "/lines/$FRESH_ID/preview" '{"content":"go on"}' | jq -e '[.blocks[] | select(.key == "origin_capsule")] | length == 1' >/dev/null ||
  fail "the new conversation's prompt carries its capsule"
SPLIT="$(api POST "/lines/$MAIN/branches" "$(jq -nc --arg a "$FIRST" '{anchorMessageId: $a, purpose: "Day trips", kind: "investigate"}')" | jq -r .line.id)"
turn "$SPLIT" "Nara or Uji?" >/dev/null
api POST "/lines/$SPLIT/spinoff" '{"mode":"detach"}' | jq -e '.line.id == "'"$SPLIT"'" and .line.conversationBranch == null and .branch.lineId == "'"$SPLIT"'"' >/dev/null ||
  fail "detach"
api GET "/lines/$MAIN/links" | jq -e '.links | length == 2' >/dev/null || fail "links"

step "B8: rebalance (a branch that takes over, accepted as a spinoff)"
REB="$(api POST "/lines/$MAIN/branches" "$(jq -nc --arg a "$FIRST" '{anchorMessageId: $a, purpose: "Rail route", kind: "investigate"}')" | jq -r .line.id)"
for q in "Shinkansen?" "Which pass?" "Reserved seats?" "Luggage?" "Night trains?"; do turn "$REB" "$q" >/dev/null; done
REB_SUGGESTION="$(api GET "/lines/$MAIN/suggestions" | jq -r '[.suggestions[] | select(.kind == "promote_or_spinoff")][0].id')"
[[ "$REB_SUGGESTION" != "null" ]] || fail "no rebalance suggestion"
api POST "/suggestions/$REB_SUGGESTION/accept" '{"action":"spinoff"}' | jq -e '.suggestion.status == "accepted" and .result.action == "spinoff" and .result.line.id == "'"$REB"'"' >/dev/null ||
  fail "accept the rebalance as a spinoff"
for spun in "$FRESH_ID" "$SPLIT" "$REB"; do api DELETE "/lines/$spun" >/dev/null; done

# wait_suggestion LINE KIND: until an open suggestion of the kind is in the
# line's inbox; prints its id.
wait_suggestion() {
  local id
  for _ in $(seq 1 100); do
    id="$(api GET "/lines/$1/suggestions" | jq -r --arg k "$2" '[.suggestions[] | select(.kind == $k)][0].id')"
    [[ "$id" != "null" ]] && { printf '%s' "$id"; return; }
    sleep 0.1
  done
  fail "no $2 suggestion"
}

step "B9: the goal (proposed after two replies, accepted, in the prompt), drift"
P2="$(api POST /lines '{"title":"Smoke goals","provider":"fake"}' | jq -r .id)"
P2_FIRST="$(turn "$P2" "I want to plan a trip to Kyoto.")"
turn "$P2" "Which month is best?" >/dev/null
GOAL_SUGGESTION="$(wait_suggestion "$P2" goal_propose)"
api POST "/suggestions/$GOAL_SUGGESTION/accept" '{"text":"Plan a Kyoto trip"}' | jq -e '.result.goal.source == "manual" and .result.goal.text == "Plan a Kyoto trip"' >/dev/null ||
  fail "accept the goal"
api PUT "/lines/$P2/goal" '{"text":"Plan a week in Kyoto"}' | jq -e '.goal.rootLineId == "'"$P2"'"' >/dev/null || fail "put goal"
api GET "/lines/$P2/goal" | jq -e '.goal.text == "Plan a week in Kyoto"' >/dev/null || fail "get goal"
api POST "/lines/$P2/preview" '{"content":"go on"}' | jq -e '[.blocks[] | select(.key == "goal")] | length == 1' >/dev/null || fail "the prompt carries the goal"
turn "$P2" "Where should we stay?" >/dev/null
DRIFTED="$(turn "$P2" "By the way, the best ramen in Tokyo? [fake:drift]")"
DRIFT="$(wait_suggestion "$P2" drift)"
api POST "/suggestions/$DRIFT/accept" '{}' | jq -e '.result.branch.anchorMessageId == "'"$DRIFTED"'" and .result.branch.parentLineId == "'"$P2"'"' >/dev/null ||
  fail "accept the drift"
api POST "/lines/$P2/goal/propose" | jq -e '.kind == "goal_propose" and .lineId == "'"$P2"'"' >/dev/null || fail "propose goal 202"

step "B9: relations (by hand, suggested after a discard), links, pins"
OTHER="$(api POST /lines '{"title":"Smoke Osaka","provider":"fake"}' | jq -r .id)"
REL="$(api POST "/lines/$P2/relations" "$(jq -nc --arg m "$P2_FIRST" --arg o "$OTHER" '{fromMessageId: $m, toLineId: $o, label: "Same trip"}')")"
jq -e '.relation.kind == "relation" and (.rootLineIds | length == 2)' <<<"$REL" >/dev/null || fail "create relation: $REL"
api GET "/lines/$OTHER/relations" | jq -e '(.relations | length == 1) and .limits.maxPerTree == 200' >/dev/null || fail "relations of the other conversation"
api GET "/lines/$P2/links" | jq -e '[.links[] | select(.kind == "relation")] | length == 1' >/dev/null || fail "links list relations"
api DELETE "/lines/$P2/relations/$(jq -r .relation.id <<<"$REL")" >/dev/null
api GET "/lines/$P2/relations" | jq -e '.relations | length == 0' >/dev/null || fail "delete relation"
HOTELS="$(api POST "/lines/$P2/branches" "$(jq -nc --arg a "$P2_FIRST" '{anchorMessageId: $a, purpose: "Hotel prices", kind: "investigate"}')" | jq -r .line.id)"
RYOKAN="$(api POST "/lines/$P2/branches" "$(jq -nc --arg a "$P2_FIRST" '{anchorMessageId: $a, purpose: "Ryokan prices", kind: "investigate"}')" | jq -r .line.id)"
turn "$RYOKAN" "How much is a night?" >/dev/null
api POST "/lines/$RYOKAN/branch/discard" '{"leaf":{"line":"Too expensive"}}' >/dev/null
RELATION="$(wait_suggestion "$P2" relation)"
api POST "/suggestions/$RELATION/accept" '{}' | jq -e '.result.link.fromLineId == "'"$RYOKAN"'" and .result.link.toLineId == "'"$HOTELS"'"' >/dev/null ||
  fail "accept the relation"
api POST "/messages/$P2_FIRST/pin" | jq -e '.message.pinned == true' >/dev/null || fail "pin"
api GET "/lines/$P2/messages?limit=500" | jq -e '[.messages[] | select(.pinned)] | length == 1' >/dev/null || fail "the transcript shows the pin"
api DELETE "/messages/$P2_FIRST/pin" | jq -e '.message.pinned == false' >/dev/null || fail "unpin"

step "B9: the shared budget and the fisheye context in the preview"
api POST "/lines/$P2/preview" '{"content":"so, the plan?"}' |
  jq -e '.budget.total == 40000 and ([.budget.shares[] | select(.owner == "history")] | length == 1) and
    ([.fisheye.items[] | select(.kind == "message" and .level == "full")] | length >= 1) and
    ([.fisheye.items[] | select(.kind == "branch" and .level == "leaf_only")] | length >= 1) and
    ([.blocks[] | select(.key == "branch_conclusions")] | length == 1)' >/dev/null || fail "fisheye preview"

step "B9: groups (summary in the fisheye), combine, a relation's label"
LABELLED="$(api POST "/lines/$P2/relations" "$(jq -nc --arg o "$OTHER" '{toLineId: $o, label: "first"}')" | jq -r .relation.id)"
api PATCH "/lines/$P2/relations/$LABELLED" '{"label":"renamed"}' | jq -e '.relation.label == "renamed"' >/dev/null || fail "relation label"
DISKS="$(api POST "/lines/$P2/branches" "$(jq -nc --arg a "$P2_FIRST" '{anchorMessageId: $a, purpose: "Disk prices", kind: "investigate"}')" | jq -r .line.id)"
turn "$DISKS" "New or used?" >/dev/null
api POST "/lines/$DISKS/branch/discard" '{"leaf":{"kind":"decision","line":"New 8TB disks"}}' >/dev/null
GROUP="$(api POST "/lines/$P2/groups" "$(jq -nc --arg a "$RYOKAN" --arg b "$DISKS" '{memberLineIds: [$a, $b], title: "Costs"}')")"
jq -e '.group.summaryStatus == "drafting" and .job.kind == "group_summary"' <<<"$GROUP" >/dev/null || fail "create group: $GROUP"
GROUP_ID="$(jq -r .group.id <<<"$GROUP")"
for _ in $(seq 1 100); do
  [[ "$(api GET "/groups/$GROUP_ID" | jq -r .group.summaryStatus)" == "ready" ]] && break
  sleep 0.1
done
api GET "/groups/$GROUP_ID" | jq -e '.group.summaryStatus == "ready" and (.group.summary | length > 0)' >/dev/null || fail "group summary"
api POST "/lines/$P2/preview" '{"content":"and?"}' | jq -e --arg g "$GROUP_ID" '[.fisheye.items[] | select(.kind == "group" and .id == $g)] | length == 1' >/dev/null ||
  fail "the fisheye shows the group"
api GET "/lines/$P2/groups" | jq -e '.groups | length >= 1' >/dev/null || fail "list groups"
api PATCH "/groups/$GROUP_ID" '{"title":"Lodging and disks"}' | jq -e '.group.title == "Lodging and disks"' >/dev/null || fail "rename group"
api POST "/groups/$GROUP_ID/dissolve" | jq -e '.group.status == "dissolved"' >/dev/null || fail "dissolve group"
LEFT="$(api POST "/lines/$P2/branches" "$(jq -nc --arg a "$P2_FIRST" '{anchorMessageId: $a, purpose: "Router A", kind: "investigate"}')" | jq -r .line.id)"
RIGHT="$(api POST "/lines/$P2/branches" "$(jq -nc --arg a "$P2_FIRST" '{anchorMessageId: $a, purpose: "Router B", kind: "investigate"}')" | jq -r .line.id)"
ON_LEFT="$(turn "$LEFT" "Wi-Fi 6?")"
turn "$RIGHT" "Wi-Fi 7?" >/dev/null
MESH="$(api POST "/lines/$LEFT/branches" "$(jq -nc --arg a "$ON_LEFT" '{anchorMessageId: $a, purpose: "Mesh for Router A", kind: "investigate"}')" | jq -r .line.id)"
api POST "/lines/$P2/branches/combine" "$(jq -nc --arg l "$LEFT" --arg r "$RIGHT" '{lineIds: [$l, $r], purpose: "Pick the router",
  conflicts: [{branch: {lineId: $l, claim: "Wi-Fi 6 is enough"}, other: {lineId: $r, claim: "Wi-Fi 7 lasts"}, choice: "keepBoth"}]}')" |
  jq -e --arg m "$MESH" '.branch.origin == "merge" and (.combined | length == 2) and (.combined[0].mergedIntoLineId == .branch.lineId) and (.notes.created | length == 1) and .reparented == [$m]' >/dev/null ||
  fail "combine"
api GET "/lines/$MESH/branch" | jq -e --arg a "$ON_LEFT" '.branch.anchorMessageId == $a and .branch.lineStatus == "idle"' >/dev/null || fail "the re-hung child"
turn "$MESH" "Still here?" >/dev/null

step "B9: open loops"
api POST "/lines/$P2/notes" '{"section":"to_confirm","text":"Is the ryokan refundable?"}' >/dev/null
api GET "/open-loops?root=$P2&staleDays=1" | jq -e '.rootLineId == "'"$P2"'" and .staleDays == 1 and .staleBranches.total == 0 and .toConfirm.total >= 2 and .seeds.total == 0 and (.suggestions.total >= 1)' >/dev/null ||
  fail "open loops of the conversation"
api GET /open-loops | jq -e '.rootLineId == "" and .staleDays == 3 and .toConfirm.total >= 1' >/dev/null || fail "open loops of the tenant"
api GET "/lines/$P2" | jq -e '.staleBranches == 0' >/dev/null || fail "stale branch count"
api GET /capabilities | jq -e '[.features[] | select((.name == "goal" or .name == "relations" or .name == "open_loops" or .name == "fisheye") and .enabled)] | length == 4' >/dev/null ||
  fail "B9 capabilities"
api DELETE "/lines/$P2/goal" >/dev/null
for gone in "$P2" "$OTHER"; do api DELETE "/lines/$gone" >/dev/null; done

step "B10: argument tags (drafted every third reply, the operator's)"
P3="$(api POST /lines '{"title":"Smoke storage","provider":"fake"}' | jq -r .id)"
LONG="$(printf 'Which file system should the home NAS use, and why? %.0s' $(seq 1 30))"
P3_REPLY="$(turn "$P3" "$LONG")"
for i in 2 3; do turn "$P3" "$LONG ($i)" >/dev/null; done # tagged every third reply
for _ in $(seq 1 100); do
  api GET "/lines/$P3/messages?limit=500" | jq -e '.messages[0].tag.kind == "question" and .messages[0].tag.source == "ai" and .messages[0].tag.status == "draft" and .messages[1].tag.kind == "idea"' >/dev/null && break
  sleep 0.1
done
api GET "/lines/$P3/messages?limit=500" | jq -e '.messages[0].tag.status == "draft"' >/dev/null || fail "the model drafts the tags"
api PUT "/messages/$P3_REPLY/tag" '{"kind":"decision"}' | jq -e '.message.tag.kind == "decision" and .message.tag.source == "user"' >/dev/null || fail "tag"
api DELETE "/messages/$P3_REPLY/tag" | jq -e '.message.tag == null' >/dev/null || fail "untag"
api PUT "/messages/$P3_REPLY/tag" '{"kind":"decision"}' >/dev/null

step "B10: folds (a chapter suggested and accepted, one by hand drafted, edited, removed)"
for i in 4 5; do turn "$P3" "$LONG ($i)" >/dev/null; done
P3_IDS="$(api GET "/lines/$P3/messages?limit=500" | jq -c '[.messages[].id]')"
api POST "/lines/$P3/chapters/milestones" "$(jq -nc --arg m "$(jq -r '.[8]' <<<"$P3_IDS")" '{messageId: $m, title: "Backups"}')" >/dev/null
for i in 6 7 8 9 10; do turn "$P3" "And the backups, part $i?" >/dev/null; done
FOLD_SUGGESTION="$(wait_suggestion "$P3" fold)"
api POST "/suggestions/$FOLD_SUGGESTION/accept" '{}' |
  jq -e --arg f "$(jq -r '.[0]' <<<"$P3_IDS")" '.result.fold.status == "active" and .result.fold.fromMessageId == $f and .result.fold.messageCount == 8 and .result.fold.aiDrafted' >/dev/null ||
  fail "accept the fold"
api POST "/lines/$P3/preview" '{"content":"so?"}' |
  jq -e '(.folds | length == 1) and .folds[0].messages == 8 and ([.fisheye.items[] | select(.kind == "fold")] | length == 1) and
    ([.fisheye.items[] | select(.kind == "message")] | length == 12) and (.prompt.earlier | contains("folded (8 messages)"))' >/dev/null || fail "the preview folds the chapter"
P3_IDS="$(api GET "/lines/$P3/messages?limit=500" | jq -c '[.messages[].id]')"
DRAFTED="$(api POST "/lines/$P3/folds" "$(jq -nc --arg a "$(jq -r '.[10]' <<<"$P3_IDS")" --arg b "$(jq -r '.[13]' <<<"$P3_IDS")" '{fromMessageId: $a, toMessageId: $b}')")"
jq -e '.fold.status == "drafting" and .job.kind == "fold_summary"' <<<"$DRAFTED" >/dev/null || fail "draft a fold: $DRAFTED"
DRAFTED_ID="$(jq -r .fold.id <<<"$DRAFTED")"
for _ in $(seq 1 100); do
  [[ "$(api GET "/lines/$P3/folds" | jq -r --arg f "$DRAFTED_ID" '.folds[] | select(.id == $f) | .status')" == "active" ]] && break
  sleep 0.1
done
api GET "/lines/$P3/folds" | jq -e '(.folds | length == 2) and ([.folds[] | select(.status == "active")] | length == 2)' >/dev/null || fail "the drafted fold"
api PATCH "/folds/$DRAFTED_ID" '{"summary":"Backups, by hand."}' | jq -e '.fold.summary == "Backups, by hand." and (.fold.aiDrafted | not)' >/dev/null || fail "edit the fold"
api DELETE "/folds/$DRAFTED_ID" >/dev/null
api GET "/lines/$P3/folds" | jq -e '.folds | length == 1' >/dev/null || fail "remove the fold"
api GET /capabilities | jq -e '[.features[] | select((.name == "ibis" or .name == "fold") and .enabled and .mode == "suggest")] | length == 2' >/dev/null ||
  fail "B10 capabilities"
api DELETE "/lines/$P3" >/dev/null

step "B10: diverge into three branches, compare two, decide"
DV="$(api POST /lines '{"title":"Smoke lists","provider":"fake"}' | jq -r .id)"
DV_REPLY="$(turn "$DV" "Implement a linked list three ways")"
api POST "/lines/$DV/diverge" "$(jq -nc --arg a "$DV_REPLY" '{anchorMessageId: $a, count: 3}')" | jq -e '.kind == "diverge"' >/dev/null || fail "diverge 202"
for _ in $(seq 1 100); do
  [[ "$(api GET "/lines/$DV/branches" | jq '[.branches[] | select(.origin == "diverge")] | length')" == 3 ]] && break
  sleep 0.1
done
DV_IDS="$(api GET "/lines/$DV/branches" | jq -c '[.branches[] | select(.origin == "diverge" and .kind == "alternative" and .anchorMessageId == "'"$DV_REPLY"'") | .lineId]')"
[[ "$(jq length <<<"$DV_IDS")" == 3 ]] || fail "three diverged branches: $DV_IDS"
for id in $(jq -r '.[]' <<<"$DV_IDS"); do turn "$id" "How does this one look?" >/dev/null; done
CMP="$(api POST "/lines/$DV/converge" "$(jq -c '{lineIds: .[0:2], criteria: ["Safety", "Speed"]}' <<<"$DV_IDS")")"
jq -e '.comparison.status == "drafting" and .job.kind == "converge"' <<<"$CMP" >/dev/null || fail "converge: $CMP"
CMP_ID="$(jq -r .comparison.id <<<"$CMP")"
for _ in $(seq 1 100); do
  [[ "$(api GET "/comparisons/$CMP_ID" | jq -r .comparison.status)" == "ready" ]] && break
  sleep 0.1
done
api GET "/comparisons/$CMP_ID" | jq -e '.comparison.matrix.criteria == ["Safety", "Speed"] and (.comparison.matrix.scores | length == 2) and .comparison.matrix.recommendation.lineId != ""' >/dev/null ||
  fail "the comparison is ready"
api POST "/comparisons/$CMP_ID/decide" "$(jq -c '{lineId: .[0]}' <<<"$DV_IDS")" |
  jq -e '.decision.kind == "decision" and .chosen.status == "open" and (.discarded | length == 1) and .discarded[0].leaf.kind == "dead_end" and .comparison.status == "decided"' >/dev/null ||
  fail "decide"
api GET "/lines/$DV/comparisons" | jq -e '(.comparisons | length == 1) and .comparisons[0].status == "decided"' >/dev/null || fail "list comparisons"
api GET /capabilities | jq -e '[.features[] | select(.name == "diverge" and .enabled and .mode == "manual")] | length == 1' >/dev/null || fail "diverge capability"
api DELETE "/lines/$DV" >/dev/null

step "B10: memories (extracted after a merge, the operator's, search, recall, supersede, pages)"
MEM="$(api POST /lines '{"title":"Smoke NAS","provider":"fake"}' | jq -r .id)"
MEM_REPLY="$(turn "$MEM" "Which file system for the NAS?")"
DISKS_B="$(api POST "/lines/$MEM/branches" "$(jq -nc --arg a "$MEM_REPLY" '{anchorMessageId: $a, purpose: "Disk layout", kind: "investigate"}')" | jq -r .line.id)"
turn "$DISKS_B" "Mirror or RAIDZ?" >/dev/null
TIP="$(api GET "/lines/$DISKS_B/branch" | jq -r .parentTipMessageId)"
api POST "/lines/$DISKS_B/branch/merge" "$(jq -nc --arg t "$TIP" '{card: {question: "Mirror or RAIDZ?", conclusion: "A ZFS mirror of two disks"}, parentTipMessageId: $t}')" >/dev/null
MEM_SUGGESTION="$(wait_suggestion "$MEM" memory)"
api POST "/suggestions/$MEM_SUGGESTION/accept" '{"importance":7}' | jq -e '.result.memory.aiDrafted and .result.memory.importance == 7 and .result.memory.source.leafLineId == "'"$DISKS_B"'"' >/dev/null ||
  fail "accept the extracted memory"
MEMORY="$(api POST /memories "$(jq -nc --arg l "$MEM" '{kind: "decision", text: "The NAS uses a ZFS mirror", importance: 8, sourceLineId: $l}')")"
MEMORY_ID="$(jq -r .memory.id <<<"$MEMORY")"
jq -e '.memory.source.label == "Smoke NAS"' <<<"$MEMORY" >/dev/null || fail "create memory: $MEMORY"
api POST /memories/search '{"query":"Which ZFS layout for the NAS?"}' | jq -e --arg m "$MEMORY_ID" '[.results[] | select(.memory.id == $m)] | length == 1' >/dev/null || fail "search memories"
NEW_LINE="$(api POST /lines '{"title":"Another NAS","provider":"fake"}' | jq -r .id)"
api POST "/lines/$NEW_LINE/preview" '{"content":"Should the NAS use ZFS?"}' |
  jq -e '(.memories | length >= 1) and ([.blocks[] | select(.key == "memory")] | length == 1)' >/dev/null || fail "the turn recalls the memory"
api PATCH "/memories/$MEMORY_ID" '{"importance":9}' | jq -e '.memory.importance == 9' >/dev/null || fail "update memory"
api POST "/memories/$MEMORY_ID/supersede" '{"text":"The NAS uses ZFS RAIDZ1"}' | jq -e '.superseded[0].supersededBy == .memory.id' >/dev/null || fail "supersede memory"
api GET "/memories?status=superseded" | jq -e --arg m "$MEMORY_ID" '[.memories[] | select(.id == $m)] | length == 1' >/dev/null || fail "the superseded memory is kept"
# B10.1: one memory per page, newest first, until nextCursor is empty.
MEM_ALL="$(api GET "/memories?status=all" | jq -c '[.memories[].id]')"
MEM_PAGED='[]'
MEM_CURSOR=""
for _ in $(seq 1 10); do
  MEM_PAGE="$(api GET "/memories?status=all&limit=1${MEM_CURSOR:+&cursor=$MEM_CURSOR}")"
  MEM_PAGED="$(jq -c --argjson page "$MEM_PAGE" '. + [$page.memories[].id]' <<<"$MEM_PAGED")"
  MEM_CURSOR="$(jq -r .nextCursor <<<"$MEM_PAGE")"
  [[ -z "$MEM_CURSOR" ]] && break
done
[[ -z "$MEM_CURSOR" && "$MEM_PAGED" == "$MEM_ALL" ]] && jq -e 'length >= 3' <<<"$MEM_ALL" >/dev/null || fail "memory pages: $MEM_PAGED vs $MEM_ALL"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -H @"$AUTH" "$BASE/api/memories?cursor=garbage")" == 400 ]] || fail "a bad memory cursor is not a 400"
api GET /capabilities | jq -e '[.features[] | select(.name == "memory" and .enabled and .mode == "suggest")] | length == 1' >/dev/null || fail "memory capability"
for gone in "$MEM" "$NEW_LINE"; do api DELETE "/lines/$gone" >/dev/null; done

step "search"
api GET "/search?q=kyoto&limit=5" | jq -e '.hits | length >= 1' >/dev/null || fail "search"
api GET /capabilities | jq -e '(.models | length >= 1) and ([.features[] | select(.name == "search" and .enabled)] | length == 1)' >/dev/null ||
  fail "capabilities"

step "B14: search one tree, diverge across models, park a batch, export"
B14="$(api POST /lines '{"title":"Smoke queues","provider":"fake"}' | jq -r .id)"
B14_REPLY="$(turn "$B14" "Ring buffer or linked list for the event queue?")"
api GET "/search?q=queue&root=$B14" | jq -e '(.hits | length >= 1) and all(.hits[]; .rootLineId == "'"$B14"'")' >/dev/null || fail "search root"
api POST "/lines/$B14/diverge/models" '{"anchorMessageId":"'"$B14_REPLY"'","purpose":"Queue","targets":[{"provider":"fake","model":"fake-1"},{"provider":"fake","model":"fake-2"}]}' |
  jq -e '(.branches | length == 2) and .branches[1].line.model == "fake-2" and .branches[0].branch.purpose == "Queue · fake-1"' >/dev/null || fail "diverge models"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H @"$AUTH" -H 'Content-Type: application/json' \
  --data '{"anchorMessageId":"'"$B14_REPLY"'","targets":[{"provider":"fake","model":"fake-1"}]}' "$BASE/api/lines/$B14/diverge/models")" == 400 ]] ||
  fail "diverge models with one target is not a 400"
api POST "/lines/$B14/seeds/batch" '{"texts":["Benchmark both","Check the allocator"]}' | jq -e '.seeds | length == 2' >/dev/null || fail "seeds batch"
api GET "/lines/$B14/export" | jq -e '(.branches | length == 2) and (.messagesByLine | length == 3) and .truncated == false' >/dev/null || fail "export"
api DELETE "/lines/$B14" >/dev/null

step "B15: relation kinds, a tag back to a draft, the tree's tag drafts"
B15="$(api POST /lines '{"title":"Smoke cache","provider":"fake"}' | jq -r .id)"
B15_REPLY="$(turn "$B15" "Write-through or write-back?")"
B15_A="$(api POST "/lines/$B15/branches" '{"anchorMessageId":"'"$B15_REPLY"'","purpose":"Write-through","kind":"investigate"}' | jq -r .line.id)"
B15_B="$(api POST "/lines/$B15/branches" '{"anchorMessageId":"'"$B15_REPLY"'","purpose":"Write-back","kind":"investigate"}' | jq -r .line.id)"
B15_REL="$(api POST "/lines/$B15/relations" '{"fromLineId":"'"$B15_A"'","toLineId":"'"$B15_B"'","label":"Opposite answers","relationKind":"contradicts"}')"
jq -e '.relation.relationKind == "contradicts"' <<<"$B15_REL" >/dev/null || fail "relation with a kind"
api PATCH "/lines/$B15/relations/$(jq -r .relation.id <<<"$B15_REL")" '{"relationKind":"supports"}' |
  jq -e '.relation.relationKind == "supports" and .relation.label == "Opposite answers"' >/dev/null || fail "relation kind only"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H @"$AUTH" -H 'Content-Type: application/json' \
  --data '{"toLineId":"'"$B15_B"'","relationKind":"rivals"}' "$BASE/api/lines/$B15/relations")" == 400 ]] ||
  fail "an unknown relation kind is not a 400"
api GET "/lines/$B15/links" | jq -e 'all(.links[]; .kind != "relation" or .relationKind != null)' >/dev/null || fail "links carry the relation kind"
B15_A_REPLY="$(turn "$B15_A" "Is the write latency fine?")"
api PUT "/messages/$B15_REPLY/tag" '{"kind":"question"}' | jq -e '.message.tag.status == "confirmed"' >/dev/null || fail "tag confirmed"
api PUT "/messages/$B15_REPLY/tag" '{"kind":"question","status":"draft"}' |
  jq -e '.message.tag.status == "draft" and .message.tag.source == "ai"' >/dev/null || fail "tag back to a draft"
api PUT "/messages/$B15_A_REPLY/tag" '{"kind":"pro","status":"draft"}' >/dev/null
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X PUT -H @"$AUTH" -H 'Content-Type: application/json' \
  --data '{"kind":"idea","status":"pending"}' "$BASE/api/messages/$B15_REPLY/tag")" == 400 ]] ||
  fail "an unknown tag status is not a 400"
api GET "/lines/$B15_A/tag-drafts" | jq -e '.rootLineId == "'"$B15"'" and .truncated == false and
  any(.drafts[]; .messageId == "'"$B15_REPLY"'" and .tag.kind == "question") and any(.drafts[]; .lineId == "'"$B15_A"'" and .messageId == "'"$B15_A_REPLY"'") and
  (.drafts[0].lineId == "'"$B15"'")' >/dev/null || fail "tag drafts"
api DELETE "/lines/$B15" >/dev/null

step "B16: [TOPIC] names a new conversation and a branch, [CHAPTER] cuts a main-line chapter"
B16="$(api POST /lines '{"title":"Smoke NAS","provider":"fake"}' | jq -r .id)"
B16_REPLY="$(turn "$B16" "Which RAID level suits a home NAS? [fake:topic]")"
api GET "/lines/$B16" | jq -e '.title == "Fake topic"' >/dev/null || fail "the first turn's topic names the line"
api GET "/lines/$B16/chapters" | jq -e '(.chapters | length == 1) and .chapters[0].title == "Fake topic" and .chapters[0].titleSource == "topic"' >/dev/null ||
  fail "the topic names the first chapter"
B16_B="$(api POST "/lines/$B16/branches" '{"anchorMessageId":"'"$B16_REPLY"'","purpose":"Compare RAID 1 and RAID 5 for four disks at home","kind":"investigate"}' | jq -r .line.id)"
turn "$B16_B" "Go on [fake:topic]" >/dev/null
api GET "/lines/$B16_B/branch" | jq -e '.branch.purpose == "Fake topic"' >/dev/null || fail "the branch's first turn renames a long purpose"
turn "$B16" "And the disks? [fake:topic]" >/dev/null
api GET "/lines/$B16" | jq -e '.title == "Fake topic"' >/dev/null || fail "a later topic renames nothing"
turn "$B16" "Now about backups [fake:chapter]" >/dev/null
api GET "/lines/$B16/chapters" | jq -e '(.chapters | length == 2) and .chapters[1].title == "Fake chapter" and .chapters[1].kind == "topic"' >/dev/null ||
  fail "the [CHAPTER] line cuts a chapter: $(api GET "/lines/$B16/chapters" | jq -c '[.chapters[] | {title, kind, messageCount}]')"
api GET "/lines/$B16/messages?limit=500" | jq -e 'all(.messages[]; (.content | test("\\[(TOPIC|CHAPTER)\\]")) | not)' >/dev/null ||
  fail "a marker line was stored"
api DELETE "/lines/$B16" >/dev/null

step "B17: dismiss a whole inbox, edit a merged card (the next turn carries it again), a branch on the card"
B17="$(api POST /lines '{"title":"Smoke garden","provider":"fake"}' | jq -r .id)"
B17_REPLY="$(turn "$B17" "Which vegetables first? [probe:suggest]")"
B17_B="$(api POST "/lines/$B17/branches" '{"anchorMessageId":"'"$B17_REPLY"'","purpose":"Tomatoes or peppers","kind":"investigate"}' | jq -r .line.id)"
turn "$B17_B" "Which grows faster? [probe:suggest]" >/dev/null
# Other features in suggest mode may raise suggestions of their own (jobs run
# in the background), so only the two probe ones are counted.
api POST "/lines/$B17_B/suggestions/dismiss-all" |
  jq -e '.rootLineId == "'"$B17"'" and ([.suggestions[] | select(.kind == "probe")] | length == 2) and all(.suggestions[]; .status == "dismissed")' >/dev/null ||
  fail "dismiss-all"
api GET "/lines/$B17/suggestions" | jq -e '[.suggestions[] | select(.kind == "probe")] | length == 0' >/dev/null || fail "dismiss-all leaves a probe suggestion open"
api POST "/lines/$B17/suggestions/dismiss-all" '{}' | jq -e '(.suggestions | type == "array") and all(.suggestions[]; .kind != "probe")' >/dev/null ||
  fail "dismiss-all with nothing open"
B17_TIP="$(api GET "/lines/$B17_B/branch" | jq -r .parentTipMessageId)"
B17_CARD="$(api POST "/lines/$B17_B/branch/merge" '{"card":{"question":"Tomatoes or peppers?","conclusion":"Tomatoes"},"parentTipMessageId":"'"$B17_TIP"'"}' | jq -r .message.id)"
turn "$B17" "Noted" >/dev/null
api PATCH "/lines/$B17_B/branch/card" '{"card":{"question":"Tomatoes or peppers?","conclusion":"Tomatoes first, peppers in June"}}' |
  jq -e '.message.id == "'"$B17_CARD"'" and .message.meta.card.conclusion == "Tomatoes first, peppers in June" and (.message.meta.delivered // false) == false and
    .branch.conclusionLine == "Tomatoes first, peppers in June" and .branch.leaf.line == "Tomatoes first, peppers in June" and
    (.message.meta.editedAt | type) == "string" and .branch.cardEditedAt == .message.meta.editedAt' >/dev/null || fail "edit the card"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH -H @"$AUTH" -H 'Content-Type: application/json' \
  --data '{"card":{"question":"q"}}' "$BASE/api/lines/$B17_B/branch/card")" == 422 ]] || fail "a card without a conclusion is not a 422"
turn "$B17" "So?" >/dev/null
api GET "/lines/$B17/messages?limit=500" | jq -e '[.messages[] | select(.id == "'"$B17_CARD"'" and .meta.delivered == true and (.meta.editedAt | type) == "string")] | length == 1' >/dev/null ||
  fail "the next turn did not carry the edited card (or lost its edit time)"
api GET "/lines/$B17/branches" | jq -e '[.branches[] | select(.lineId == "'"$B17_B"'" and (.cardEditedAt | type) == "string")] | length == 1' >/dev/null ||
  fail "the outline does not show the card edit time"
api POST "/lines/$B17/branches/preview" '{"anchorMessageId":"'"$B17_CARD"'","purpose":"Ask about peppers","kind":"investigate"}' |
  jq -e '.pack.recent[-1].id == "'"$B17_CARD"'" and (.text | contains("Tomatoes first, peppers in June"))' >/dev/null || fail "preview a branch on the card"
api POST "/lines/$B17/branches" '{"anchorMessageId":"'"$B17_CARD"'","purpose":"Ask about peppers","kind":"investigate"}' |
  jq -e '.branch.anchorMessageId == "'"$B17_CARD"'"' >/dev/null || fail "a branch on the card"
api DELETE "/lines/$B17" >/dev/null

step "B18: import with a branch, folders and tags, decompose, extract a detour with a card and a tail without one; B19 assembled import"
B18_IMPORT='{"title":"Smoke MVCC","provider":"fake","folder":"Smoke DB","tags":["#Postgres","mvcc"],"source":"chatgpt",
 "messages":[
  {"externalId":"m1","role":"user","content":"Explain PostgreSQL MVCC please"},
  {"externalId":"m2","role":"assistant","content":"PostgreSQL MVCC keeps row versions with xmin and xmax."},
  {"externalId":"m3","role":"user","content":"My Docker container shows a connection refused error"},
  {"externalId":"m4","role":"assistant","content":"Use host.docker.internal instead. It reaches the host."},
  {"externalId":"m5","role":"user","content":"Back to MVCC: when does PostgreSQL vacuum run?"},
  {"externalId":"m6","role":"assistant","content":"Autovacuum runs past a threshold.\nDo you want an example?"},
  {"externalId":"m7","role":"user","content":"By the way, how do I reindex?"},
  {"externalId":"m8","role":"assistant","content":"REINDEX CONCURRENTLY."}],
 "branches":[{"anchorExternalId":"m2","purpose":"Table locks instead","messages":[
  {"role":"user","content":"What if we used table locks?"},{"role":"assistant","content":"Readers and writers would block."}]}]}'
B18_OUT="$(api POST /lines/import "$B18_IMPORT")"
jq -e '.messageCount == 8 and .line.folder == "Smoke DB" and .line.tags == ["postgres","mvcc"] and (.branches | length == 1) and
  .branches[0].status == "discarded" and .branches[0].origin == "import" and .line.branchCounts.discarded == 1' <<<"$B18_OUT" >/dev/null || fail "import"
B18="$(jq -r .line.id <<<"$B18_OUT")"
api GET "/lines?folder=Smoke%20DB&tag=%23POSTGRES" | jq -e '[.lines[].id] == ["'"$B18"'"]' >/dev/null || fail "filter by folder and tag"
api GET "/lines?folder=__unfiled__" | jq -e 'all(.lines[]; .folder == "")' >/dev/null || fail "filter the unfiled lines"
api PATCH "/lines/$B18" '{"tags":["postgres","mvcc","vacuum"]}' | jq -e '.tags == ["postgres","mvcc","vacuum"] and .folder == "Smoke DB"' >/dev/null || fail "patch tags"
api POST /lines/folders/rename '{"from":"Smoke DB","to":"Smoke Databases"}' | jq -e '.updated == 1' >/dev/null || fail "rename the folder"
api GET "/lines/$B18" | jq -e '.folder == "Smoke Databases"' >/dev/null || fail "the folder was renamed"
# B18.1: the tenant's folders and tags over every main line, with counts.
api GET /lines/organization | jq -e '(.folders | type == "array") and (.tags | type == "array")
  and any(.folders[]; . == {"folder":"Smoke Databases","active":1,"archived":0})
  and any(.tags[]; .tag == "vacuum" and .count >= 1) and all(.folders[]; .folder != "Smoke DB")' >/dev/null || fail "organization"
B18_PLAN="$(api GET "/lines/$B18/decompose")"
jq -e '(.detourRanges | length) == 1 and (.chapterCuts | length) >= 1 and (.seedCandidates | length) >= 1 and (.relatedLines | type == "array")' <<<"$B18_PLAN" >/dev/null ||
  fail "decompose: $B18_PLAN"
B18_FROM="$(jq -r '.detourRanges[0].fromMessageId' <<<"$B18_PLAN")"
B18_TO="$(jq -r '.detourRanges[0].toMessageId' <<<"$B18_PLAN")"
api POST "/lines/$B18/branches/extract" '{"fromMessageId":"'"$B18_FROM"'","toMessageId":"'"$B18_TO"'","purpose":"Docker connection","kind":"investigate",
  "card":{"question":"Why does the container not reach Postgres?","conclusion":"Use host.docker.internal."}}' |
  jq -e '.marker.kind == "branch_card" and .marker.meta.delivered == true and .branch.status == "merged" and (.movedMessageIds | length == 2)' >/dev/null ||
  fail "extract with a card"
B18_MSGS="$(api GET "/lines/$B18/messages?limit=500")"
B18_TAIL_FROM="$(jq -r '.messages[-2].id' <<<"$B18_MSGS")"
B18_TAIL_TO="$(jq -r '.messages[-1].id' <<<"$B18_MSGS")"
api POST "/lines/$B18/branches/extract" '{"fromMessageId":"'"$B18_TAIL_FROM"'","toMessageId":"'"$B18_TAIL_TO"'","purpose":"Reindexing"}' |
  jq -e '.marker.kind == "branch_marker" and .branch.status == "open"' >/dev/null || fail "extract the tail without a card"
api GET "/lines/$B18/messages?limit=500" | jq -e '[.messages[].kind] == ["chat","chat","branch_card","chat","chat","branch_marker"]' >/dev/null ||
  fail "the card and the marker sit where their ranges were"
api POST "/lines/$B18/preview" '{"content":"next"}' |
  jq -e '([.prompt.sections[]?, .prompt.trailing[]? | select(.key == "branch_cards")] | length == 0) and ([.prompt.history[] | select(.content | contains("Use host.docker.internal."))] | length == 1)' >/dev/null ||
  fail "the delivered card stands in the history, with no notice"
turn "$B18" "And what about indexes?" >/dev/null
api DELETE "/lines/$B18" >/dev/null
api GET /lines/organization | jq -e 'all(.folders[]; .folder != "Smoke Databases")' >/dev/null || fail "organization after the delete"
# B19: an assembled import keeps the source's dates, writes milestone chapter
# cuts and a merged branch whose card sits right after its anchor.
B19_IMPORT='{"title":"Smoke assembled","provider":"fake","createdAt":"2025-03-01T09:00:00Z",
 "messages":[
  {"externalId":"s1","role":"user","content":"Explain PostgreSQL MVCC please","createdAt":"2025-03-01T09:00:00Z"},
  {"externalId":"s2","role":"assistant","content":"Row versions with xmin and xmax.","createdAt":"2025-03-01T09:01:00Z"},
  {"externalId":"s3","role":"user","content":"How do I reindex?","createdAt":"2025-03-01T19:00:00+09:00"},
  {"externalId":"s4","role":"assistant","content":"REINDEX CONCURRENTLY."}],
 "branches":[{"anchorExternalId":"s2","purpose":"Table locks instead","status":"merged","createdAt":"2025-03-01T09:02:00Z",
  "card":{"conclusion":"Readers and writers would block."},
  "messages":[{"role":"user","content":"What if we used table locks?"},{"role":"assistant","content":"They would block.","createdAt":"2025-03-01T09:05:00Z"}]}],
 "chapterCuts":[{"anchorExternalId":"s1","title":"§1 MVCC"},{"anchorExternalId":"s3","title":"§2 Indexes"}]}'
B19_OUT="$(api POST /lines/import "$B19_IMPORT")"
jq -e '.messageCount == 4 and .line.createdAt == "2025-03-01T09:00:00Z" and .line.lastActivityAt == "2025-03-01T10:00:00Z" and .line.branchCounts.merged == 1
  and .branches[0].status == "merged" and .branches[0].createdAt == "2025-03-01T09:02:00Z" and .branches[0].closedAt == "2025-03-01T09:05:00Z"' <<<"$B19_OUT" >/dev/null ||
  fail "assembled import: $B19_OUT"
B19="$(jq -r .line.id <<<"$B19_OUT")"
B19_CARD="$(jq -r '.branches[0].cardMessageId' <<<"$B19_OUT")"
B19_MSGS="$(api GET "/lines/$B19/messages?limit=500")"
jq -e '[.messages[].kind] == ["chat","chat","branch_card","chat","chat"] and .messages[2].id == "'"$B19_CARD"'" and .messages[2].meta.delivered == true
  and .messages[2].meta.card.question == "Table locks instead" and .messages[2].createdAt == "2025-03-01T09:01:00Z"
  and [.messages[].createdAt] == ["2025-03-01T09:00:00Z","2025-03-01T09:01:00Z","2025-03-01T09:01:00Z","2025-03-01T10:00:00Z","2025-03-01T10:00:00Z"]' <<<"$B19_MSGS" >/dev/null ||
  fail "the card sits right after its anchor and the dates are kept: $B19_MSGS"
api GET "/lines/$B19/chapters" | jq -e '([.milestones[].title] | sort) == ["§1 MVCC","§2 Indexes"]
  and [.chapters[].startMessageId] == ['"$(jq -c '.messages[0].id, .messages[3].id' <<<"$B19_MSGS" | paste -sd, -)"']' >/dev/null ||
  fail "the chapter cuts were written"
api POST "/lines/$B19/preview" '{"content":"next"}' |
  jq -e '[.prompt.sections[]?, .prompt.trailing[]? | select(.key == "branch_cards")] | length == 0' >/dev/null || fail "the imported card is already delivered"
api DELETE "/lines/$B19" >/dev/null

step "B20: attach another conversation as a branch (open with its own branch, then merged with a card)"
# The target ran 09:00-09:03; the source started at 09:01:30, so it hangs on
# the 09:01 reply (the newest anchorable message not after its start).
B20="$(api POST /lines/import '{"title":"Smoke pool tuning","provider":"fake","messages":[
  {"role":"user","content":"How big should the PG pool be?","createdAt":"2025-03-01T09:00:00Z"},
  {"role":"assistant","content":"Start with 20.","createdAt":"2025-03-01T09:01:00Z"},
  {"role":"user","content":"And the timeouts?","createdAt":"2025-03-01T09:02:00Z"},
  {"role":"assistant","content":"30 seconds.","createdAt":"2025-03-01T09:03:00Z"}]}' | jq -r .line.id)"
B20_SRC_OUT="$(api POST /lines/import '{"title":"Smoke PgBouncer","provider":"fake","folder":"Smoke DB","tags":["pgbouncer"],"createdAt":"2025-03-01T09:01:30Z",
 "messages":[{"externalId":"p1","role":"user","content":"Which pool_mode?"},{"externalId":"p2","role":"assistant","content":"transaction"}],
 "branches":[{"anchorExternalId":"p2","purpose":"Session mode","messages":[{"role":"user","content":"And session mode?"},{"role":"assistant","content":"Only for prepared statements."}]}]}')"
B20_SRC="$(jq -r .line.id <<<"$B20_SRC_OUT")"
B20_SRC_CHILD="$(jq -r '.branches[0].lineId' <<<"$B20_SRC_OUT")"
B20_FIRST="$(api GET "/lines/$B20/messages?limit=500" | jq -r '.messages[1].id')"
B20_OUT="$(api POST "/lines/$B20/attach" '{"sourceLineId":"'"$B20_SRC"'"}')"
jq -e '.branch.parentLineId == "'"$B20"'" and .branch.status == "open" and .branch.depth == 1 and .branch.anchorMessageId == "'"$B20_FIRST"'"
  and .branch.purpose == "Smoke PgBouncer" and .branchLine.folder == "" and .branchLine.tags == [] and .branchLine.conversationBranch.rootLineId == "'"$B20"'"
  and .cardMessage == null and .reparented == ["'"$B20_SRC_CHILD"'"]' <<<"$B20_OUT" >/dev/null ||
  fail "attach a conversation: it hangs on the reply before it started: $B20_OUT"
api GET "/lines/$B20/branches" | jq -e '[.branches[] | select(.lineId == "'"$B20_SRC_CHILD"'")][0] | .depth == 2 and .rootLineId == "'"$B20"'"' >/dev/null ||
  fail "the source's branch came along one level deeper"
api GET /lines | jq -e '[.lines[].id] | index("'"$B20_SRC"'") == null' >/dev/null || fail "the attached line left the main line list"
api GET "/lines/$B20_SRC/messages?limit=500" | jq -e '[.messages[].content] == ["Which pool_mode?","transaction"]' >/dev/null || fail "the source kept its messages"
B20_SECOND="$(api POST /lines '{"title":"Smoke timeouts","provider":"fake"}' | jq -r .id)"
turn "$B20_SECOND" "statement_timeout?" >/dev/null
api POST "/lines/$B20/attach" '{"sourceLineId":"'"$B20_SECOND"'","status":"merged","card":{"conclusion":"30 seconds."}}' |
  jq -e '.cardMessage.kind == "branch_card" and .cardMessage.meta.delivered == true and .cardMessage.meta.card.question == "Smoke timeouts"
    and .branch.status == "merged" and .branch.cardMessageId == .cardMessage.id' >/dev/null || fail "attach merged with a card"
api POST "/lines/$B20/preview" '{"content":"next"}' |
  jq -e '[.prompt.sections[]?, .prompt.trailing[]? | select(.key == "branch_cards")] | length == 0' >/dev/null || fail "the attached card is already delivered"
api DELETE "/lines/$B20" | jq -e '(.lineIds | length) == 4' >/dev/null || fail "the attached lines go with their new conversation"

step "B22: analyze an interleaved import (the fake runner's reply is no plan: the heuristic answers)"
B22_UNITS='[{"key":"t1","question":"Docker 容器怎麼裝?","answer":"先裝 Docker Engine。","messageCount":2},
 {"key":"t2","question":"Redis 快取要設多久?","answer":"看資料多久會變。","messageCount":2},
 {"key":"t3","question":"Docker 映像檔太大怎麼辦?","answer":"用多階段建置。","messageCount":2}]'
api POST /lines/import-analyze '{"units":'"$B22_UNITS"'}' |
  jq -e '.source == "heuristic" and .mode == "tree" and (.nodes | length) == 2 and .nodes[0].unitKeys == ["t1","t3"]
    and .nodes[0].role == "chapter" and .nodes[1].role == "merged_branch" and .nodes[1].attachToKey == "t1" and .nodes[1].attachAfterUnitKey == "t1"' >/dev/null ||
  fail "the import analysis threads t1 and t3 and hangs t2 on them"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H @"$AUTH" -H 'Content-Type: application/json' --data '{"units":[]}' "$BASE/api/lines/import-analyze")" == 400 ]] || fail "an analysis without units is 400"

step "B23: keep an answered aside, continue it as a branch, delete the branch once it is discarded"
B23="$(api POST /lines '{"title":"Smoke asides","provider":"fake"}' | jq -r .id)"
B23_REPLY="$(turn "$B23" "Which pool mode?")"
B23_ASIDE="$(api POST "/lines/$B23/branches" '{"anchorMessageId":"'"$B23_REPLY"'","purpose":"what is a pool","kind":"aside"}' | jq -r .line.id)"
turn "$B23_ASIDE" "What is a pool?" >/dev/null
api GET "/lines/$B23_ASIDE/branch" | jq -e '.branch.status == "discarded" and (.branch | has("keptAt") | not)' >/dev/null || fail "an answered aside ends and is not kept"
api PUT "/lines/$B23_ASIDE/branch/keep" '{"keep":true}' | jq -e '.branch.keptAt != null and .branch.kind == "aside" and .branch.status == "discarded"' >/dev/null ||
  fail "keep the aside"
api GET "/lines/$B23/branches?includeAside=true" | jq -e '[.branches[] | select(.lineId == "'"$B23_ASIDE"'")][0].keptAt != null' >/dev/null || fail "the outline shows the kept aside"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X PUT -H @"$AUTH" -H 'Content-Type: application/json' --data '{"keep":true}' "$BASE/api/lines/$B23/branch/keep")" == 404 ]] ||
  fail "keeping a main line is 404"
B23_BEFORE="$(api GET "/lines/$B23_ASIDE/messages?limit=500" | jq -c '[.messages[] | {id, seq}]')"
B23_OUT="$(api POST "/lines/$B23_ASIDE/branch/continue" '{"purpose":"pool sizing"}')"
B23_BRANCH="$(jq -r .line.id <<<"$B23_OUT")"
jq -e '.replacedLineId == "'"$B23_ASIDE"'" and .line.id != "'"$B23_ASIDE"'" and .branch.status == "open" and .branch.kind == "investigate"
  and .branch.purpose == "pool sizing" and .branch.parentLineId == "'"$B23"'" and .branch.anchorMessageId == "'"$B23_REPLY"'"
  and (.branch | has("keptAt") | not)' <<<"$B23_OUT" >/dev/null || fail "continue the aside as a branch: $B23_OUT"
[[ "$(api GET "/lines/$B23_BRANCH/messages?limit=500" | jq -c '[.messages[] | {id, seq}]')" == "$B23_BEFORE" ]] || fail "the aside's messages moved with their ids and seq"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -H @"$AUTH" "$BASE/api/lines/$B23_ASIDE")" == 404 ]] || fail "the continued aside is gone"
turn "$B23_BRANCH" "And how big?" >/dev/null
api GET "/lines/$B23_BRANCH/messages?limit=500" | jq -e '.messages | length == 4' >/dev/null || fail "the new branch takes another turn"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H @"$AUTH" "$BASE/api/lines/$B23_BRANCH/branch")" == 409 ]] || fail "an open branch is not deleted"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H @"$AUTH" "$BASE/api/lines/$B23/branch")" == 400 ]] || fail "DELETE /branch on a main line is 400"
api POST "/lines/$B23_BRANCH/branch/discard" >/dev/null
api DELETE "/lines/$B23_BRANCH/branch" | jq -e '.rootLineId == "'"$B23"'" and .lineIds == ["'"$B23_BRANCH"'"]' >/dev/null || fail "delete the discarded branch"
api GET "/lines/$B23/branches?includeAside=true" | jq -e '.branches | length == 0' >/dev/null || fail "the deleted branch left the outline"
api GET "/lines/$B23/messages?limit=500" | jq -e '.messages | length == 2' >/dev/null || fail "the main line kept its messages"
api DELETE "/lines/$B23" >/dev/null

step "B24: the glossary (saved from an aside keeps it, only the terms reach the prompt, search, edit, delete, export)"
B24="$(api POST /lines '{"title":"Smoke glossary","provider":"fake"}' | jq -r .id)"
B24_REPLY="$(turn "$B24" "What is MVCC?")"
B24_ASIDE="$(api POST "/lines/$B24/branches" '{"anchorMessageId":"'"$B24_REPLY"'","purpose":"what is a row version","kind":"aside"}' | jq -r .line.id)"
turn "$B24_ASIDE" "What is a row version?" >/dev/null
B24_SAVED="$(api POST "/lines/$B24_ASIDE/terms" '{"term":" MVCC ","explanation":"row versions"}')"
jq -e '.change == "created" and .term.term == "MVCC" and .term.termKey == "mvcc" and .term.sourceLineId == "'"$B24_ASIDE"'"
  and .keptBranch.lineId == "'"$B24_ASIDE"'" and .keptBranch.keptAt != null' <<<"$B24_SAVED" >/dev/null || fail "save a term from the aside: $B24_SAVED"
B24_TERM="$(jq -r .term.id <<<"$B24_SAVED")"
api GET "/lines/$B24_ASIDE/branch" | jq -e '.branch.keptAt != null' >/dev/null || fail "the aside a term was saved from is kept"
B24_CLASH="$(curl -sS -X POST -H @"$AUTH" -H 'Content-Type: application/json' --data '{"term":"m v c c","explanation":"again"}' -w '\n%{http_code}' "$BASE/api/lines/$B24/terms")"
[[ "${B24_CLASH##*$'\n'}" == 409 ]] && jq -e '.code == "term_exists" and .term.id == "'"$B24_TERM"'"' <<<"${B24_CLASH%$'\n'*}" >/dev/null ||
  fail "the same term again is 409 term_exists: $B24_CLASH"
api POST "/lines/$B24/terms" '{"term":"mvcc","explanation":"multi-version concurrency control","replace":true}' |
  jq -e '.change == "updated" and .term.id == "'"$B24_TERM"'" and .term.term == "MVCC" and .term.sourceLineId == "'"$B24"'"' >/dev/null || fail "replace a term"
api POST "/lines/$B24/terms" '{"term":"WAL","explanation":"SMOKE-EXPLANATION-ONLY","sourceMessageId":"'"$B24_REPLY"'"}' |
  jq -e '.term.sourceMessageId == "'"$B24_REPLY"'" and (has("keptBranch") | not)' >/dev/null || fail "save a term from the main line"
api GET "/lines/$B24_ASIDE/terms" | jq -e '.rootLineId == "'"$B24"'" and ([.terms[].term] == ["MVCC","WAL"]) and .limits.maxTotal == 300' >/dev/null ||
  fail "the tree's glossary, in key order"
api POST "/lines/$B24/preview" '{"content":"and then?"}' |
  jq -e '([.prompt.trailing[] | select(.key == "glossary")][0].body | contains("Terms the user has already asked about: MVCC, WAL"))
    and ([.prompt.sections[] | select(.key == "glossary")] | length == 0) and ([.budget.shares[] | select(.owner == "glossary")] | length == 1)
    and (tostring | contains("SMOKE-EXPLANATION-ONLY") | not)' >/dev/null || fail "the preview carries only the terms, in the trailing block"
api GET "/terms?q=Mv" | jq -e '.nextCursor == "" and ([.terms[] | select(.rootLineId == "'"$B24"'")] | length == 1) and .terms[0].rootTitle == "Smoke glossary"' >/dev/null ||
  fail "search the tenant's terms"
api PATCH "/terms/$B24_TERM" '{"explanation":"edited"}' | jq -e '.term.explanation == "edited" and .term.term == "MVCC"' >/dev/null || fail "edit a term"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H @"$AUTH" "$BASE/api/terms/$B24_TERM")" == 204 ]] || fail "delete a term is 204"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H @"$AUTH" "$BASE/api/terms/$B24_TERM")" == 404 ]] || fail "a deleted term is 404"
api GET "/lines/$B24/export" | jq -e '[.terms[].term] == ["WAL"]' >/dev/null || fail "the export carries the terms"
api DELETE "/lines/$B24" >/dev/null

step "B25: an import batch (listed, undone: the used conversation is kept, then forced), a pinned conversation"
B25_HEX="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
B25_BATCH="${B25_HEX:0:8}-${B25_HEX:8:4}-4${B25_HEX:13:3}-a${B25_HEX:17:3}-${B25_HEX:20:12}"
b25_import() {
  jq -nc --arg t "$1" --arg b "$B25_BATCH" --arg l "$2" \
    '{title: $t, batchId: $b, batchLabel: $l, messages: [{role: "user", content: ("about " + $t)}, {role: "assistant", content: "noted"}]}'
}
B25_A="$(api POST /lines/import "$(b25_import "Smoke batch A" "smoke.json")" | jq -er --arg b "$B25_BATCH" 'select(.line.importBatchId == $b) | .line.id')" ||
  fail "an import names its batch"
B25_B="$(api POST /lines/import "$(b25_import "Smoke batch B" "ignored")" | jq -er --arg b "$B25_BATCH" 'select(.line.importBatchId == $b) | .line.id')" ||
  fail "a second import joins the batch"
api GET "/imports?limit=50" | jq -e --arg b "$B25_BATCH" '[.imports[] | select(.id == $b)][0] | .label == "smoke.json" and .lineCount == 2 and .standaloneCount == 2' >/dev/null ||
  fail "the batch is listed with its first label and two lines"
turn "$B25_B" "one more question after the import" >/dev/null
api DELETE "/imports/$B25_BATCH" | jq -e --arg a "$B25_A" --arg b "$B25_B" '.deleted == [$a] and .kept == [{lineId: $b, reason: "changed"}]' >/dev/null ||
  fail "undo deletes the untouched import and keeps the used one"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -H @"$AUTH" "$BASE/api/lines/$B25_A")" == 404 ]] || fail "the undone import is gone"
api PATCH "/lines/$B25_B" '{"pinned":true}' | jq -e '.pinnedAt != null' >/dev/null || fail "pin a conversation"
api GET "/lines?pinned=true" | jq -e --arg b "$B25_B" '[.lines[].id] == [$b] and .nextCursor == ""' >/dev/null || fail "the pinned list"
api GET "/lines?limit=200" | jq -e --arg b "$B25_B" '[.lines[].id][0] == $b' >/dev/null || fail "the list keeps its order (newest activity first)"
api PATCH "/lines/$B25_B" '{"pinned":false}' | jq -e 'has("pinnedAt") | not' >/dev/null || fail "unpin"
api DELETE "/imports/$B25_BATCH?force=true" | jq -e --arg b "$B25_B" '.deleted == [$b] and .kept == []' >/dev/null || fail "force deletes the used one"
api GET "/imports?limit=50" | jq -e --arg b "$B25_BATCH" '[.imports[] | select(.id == $b)] | length == 0' >/dev/null || fail "the undone batch is gone"

step "delete the conversation"
api DELETE "/lines/$MAIN" | jq -e '.rootLineId == "'"$MAIN"'"' >/dev/null || fail "delete"
api GET /lines | jq -e '.lines | length == 0' >/dev/null || fail "the line list is not empty"

step "events seen on /events"
sleep 0.3
for want in line.created message.created message.delta message.updated line.updated line.deleted suggestion.changed leaf.changed seeds.changed link.changed goal.changed group.changed fold.changed comparison.changed memory.changed chapters.changed terms.changed; do
  grep -q "^event: $want\$" "$WORK/events.log" || fail "no $want event"
done
for change in created renamed draft merged promoted moved detached kept; do
  # No pipe into grep -q: with pipefail, the early exit of grep -q can fail the
  # pipeline (SIGPIPE) once the log is long.
  grep -q "^data: .*\"change\":\"$change\"" "$WORK/events.log" || fail "no branch.changed $change event"
done

step "graceful shutdown"
kill -TERM "$SERVER_PID"
wait "$SERVER_PID" || fail "the server exited with $?"
SERVER_PID=""
echo "SMOKE PASSED ($(grep -c '^event: ' "$WORK/events.log") events)"
