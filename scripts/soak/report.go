package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// report is the soak's result, written as JSON.
type report struct {
	mu          sync.Mutex
	Started     time.Time                 `json:"started"`
	Ended       time.Time                 `json:"ended"`
	Options     string                    `json:"options"`
	Samples     []sample                  `json:"samples"`
	Settled     string                    `json:"settledIn"`
	Checks      map[string]int            `json:"finalChecks"`
	CheckErrors []string                  `json:"checkErrors,omitempty"`
	Features    features                  `json:"features"`
	Operations  map[string]map[string]int `json:"operations"`
	Missing     []string                  `json:"missingOperations"`
	Requests    map[string]int            `json:"requests"`
	P95ms       map[string]int64          `json:"p95ms"`
	Refusals    map[string]int            `json:"refusals"`
	Outcomes    map[string]int            `json:"outcomes"`
	Events      map[string]int            `json:"events"`
	Reconnects  int                       `json:"eventReconnects"`
	Violations  []string                  `json:"violations"`
	Failures    []string                  `json:"failures"`
	Passed      bool                      `json:"passed"`
}

// sample is the server's stats and the database's connections at a time.
type sample struct {
	Label       string          `json:"label"`
	At          time.Time       `json:"at"`
	Server      json.RawMessage `json:"server"`
	DBBackends  int             `json:"dbBackends"`
	StatsFailed string          `json:"statsFailed,omitempty"`
}

func (r *report) sample(ctx context.Context, c *client, pool *pgxpool.Pool, label string) {
	s := sample{Label: label, At: time.Now()}
	var raw json.RawMessage
	if err := c.do(ctx, "GET", "/debug/stats?gc=1", nil, &raw); err != nil {
		s.StatsFailed = err.Error()
	}
	s.Server = raw
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()`).Scan(&s.DBBackends)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Samples = append(r.Samples, s)
}

func (r *report) sampleEvery(ctx context.Context, c *client, pool *pgxpool.Pool, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.sample(ctx, c, pool, "run")
		}
	}
}

// finalCheck is a query that must count 0 once the server is quiet; a
// check with a table runs only when that table exists (memory is a
// feature migration).
type finalCheck struct {
	name, query, table string
}

// finalChecks: nothing stuck (turns, jobs of every kind, drafts, lines),
// nothing dangling (branches, suggestions), the shape of folds, memories
// and decided comparisons.
var finalChecks = []finalCheck{
	{name: "pendingReplies", query: `SELECT count(*) FROM tangent_message WHERE status = 'pending'`},
	{name: "pendingJobs", query: `SELECT count(*) FROM tangent_job WHERE status = 'pending'`},
	{name: "thinkingLines", query: `SELECT count(*) FROM tangent_line WHERE status = 'thinking'`},
	{name: "linesWithTwoPending", query: `SELECT count(*) FROM (SELECT line_id FROM tangent_message WHERE status = 'pending' GROUP BY line_id HAVING count(*) > 1) x`},
	{name: "draftingBranches", query: `SELECT count(*) FROM tangent_branch WHERE draft_status = 'drafting'`},
	{name: "closedWithoutTime", query: `SELECT count(*) FROM tangent_branch WHERE (status = 'open') <> (closed_at IS NULL)`},
	{name: "orphanBranches", query: `SELECT count(*) FROM tangent_branch b LEFT JOIN tangent_line l ON l.id = b.parent_line_id WHERE l.id IS NULL`},
	{name: "mergedWithoutCard", query: `SELECT count(*) FROM tangent_branch WHERE status = 'merged' AND card_message_id IS NULL`},
	{name: "draftingFolds", query: `SELECT count(*) FROM tangent_fold WHERE status = 'drafting'`},
	{name: "draftingComparisons", query: `SELECT count(*) FROM tangent_comparison WHERE status = 'drafting'`},
	{name: "draftingGroups", query: `SELECT count(*) FROM tangent_group WHERE status = 'active' AND summary_status = 'drafting'`},
	{name: "suggestionsOnEndedBranches", query: `SELECT count(*) FROM tangent_suggestion s JOIN tangent_branch b ON b.line_id = s.line_id
		WHERE s.status = 'open' AND b.status <> 'open'`},
	{name: "suggestionsOffTheirTree", query: `SELECT count(*) FROM tangent_suggestion s WHERE s.status = 'open' AND s.line_id <> s.root_line_id
		AND NOT EXISTS (SELECT 1 FROM tangent_branch b WHERE b.line_id = s.line_id AND b.root_line_id = s.root_line_id)`},
	{name: "suggestionsOnDeletedObjects", query: suggestionsOnDeletedObjects},
	{name: "overlappingFolds", query: `SELECT count(*) FROM tangent_fold a JOIN tangent_fold b ON a.line_id = b.line_id AND a.id < b.id
		WHERE a.status IN ('drafting', 'active') AND b.status IN ('drafting', 'active') AND a.from_seq <= b.to_seq AND b.from_seq <= a.to_seq`},
	{name: "decidedSiblingsOpen", query: `SELECT count(*) FROM tangent_comparison c
		JOIN tangent_branch b ON b.line_id = ANY (c.line_ids) AND b.parent_line_id = c.parent_line_id
		WHERE c.status = 'decided' AND b.line_id <> c.decided_line_id AND b.status = 'open'`},
	{name: "decidedWithoutDecisionTime", query: `SELECT count(*) FROM tangent_comparison WHERE (status = 'decided') <> (decided_at IS NOT NULL)`},
	{name: "linesInTwoActiveGroups", query: `SELECT count(*) FROM (SELECT gm.line_id FROM tangent_group_member gm JOIN tangent_group g ON g.id = gm.group_id
		WHERE g.status = 'active' GROUP BY gm.line_id HAVING count(*) > 1) x`},
	{name: "activeGroupsWithOpenMembers", query: `SELECT count(*) FROM tangent_group_member gm JOIN tangent_group g ON g.id = gm.group_id
		JOIN tangent_branch b ON b.line_id = gm.line_id WHERE g.status = 'active' AND b.status = 'open'`},
	{name: "tagsOnUntaggableMessages", query: `SELECT count(*) FROM tangent_message_tag t JOIN tangent_message m ON m.id = t.message_id
		WHERE m.kind <> 'chat' OR m.status <> 'done' OR m.role NOT IN ('user', 'assistant')`},
	{name: "memorySupersedeCycles", table: "tangent_memory", query: memorySupersedeCycles},
	{name: "activeMemoriesWithoutEmbedding", table: "tangent_memory", query: `SELECT count(*) FROM tangent_memory WHERE status = 'active' AND (embedding IS NULL OR embedding_dim = 0)`},
}

// suggestionsOnDeletedObjects counts open suggestions whose payload names a
// message or line that no longer exists (fold ends, drift anchors, relation
// ends, group members).
const suggestionsOnDeletedObjects = `SELECT count(*) FROM tangent_suggestion s WHERE s.status = 'open' AND EXISTS (
	SELECT 1 FROM (
		SELECT s.payload->>'fromMessageId' AS id, 'message' AS what
		UNION ALL SELECT s.payload->>'toMessageId', 'message'
		UNION ALL SELECT s.payload->>'anchorMessageId', 'message'
		UNION ALL SELECT s.payload->>'fromLineId', 'line'
		UNION ALL SELECT s.payload->>'toLineId', 'line'
		UNION ALL SELECT m->>'lineId', 'line' FROM jsonb_array_elements(
			CASE WHEN jsonb_typeof(s.payload->'members') = 'array' THEN s.payload->'members' ELSE '[]'::jsonb END) m
	) ref
	WHERE coalesce(ref.id, '') <> '' AND NOT CASE ref.what
		WHEN 'message' THEN EXISTS (SELECT 1 FROM tangent_message WHERE id::text = ref.id)
		ELSE EXISTS (SELECT 1 FROM tangent_line WHERE id::text = ref.id) END)`

// memorySupersedeCycles counts memories whose superseded_by chain comes back
// to them (the walk is bounded; chains are linear).
const memorySupersedeCycles = `WITH RECURSIVE chain (start_id, next_id, depth) AS (
	SELECT id, superseded_by, 1 FROM tangent_memory WHERE superseded_by IS NOT NULL
	UNION ALL
	SELECT c.start_id, m.superseded_by, c.depth + 1 FROM chain c JOIN tangent_memory m ON m.id = c.next_id
	WHERE m.superseded_by IS NOT NULL AND c.next_id <> c.start_id AND c.depth < 100000)
	SELECT count(DISTINCT start_id) FROM chain WHERE next_id = start_id`

// finish runs the final checks and fills in the counters.
func (r *report) finish(ctx context.Context, pool *pgxpool.Pool, st *counters, inv *invariants, events *eventCounts, settled time.Duration, required []string) {
	r.Ended, r.Settled = time.Now(), settled.Round(time.Second).String()
	r.Checks, r.CheckErrors = runFinalChecks(ctx, pool)
	maps.Copy(r.Checks, resourceChecks(r.Samples))
	st.mu.Lock()
	r.Requests, r.Refusals, r.Outcomes, r.Operations, r.Failures = st.requests, st.refusals, st.outcomes, st.ops, st.failures
	r.P95ms = map[string]int64{}
	for route, ds := range st.latencies {
		sorted := slices.Clone(ds)
		slices.Sort(sorted)
		r.P95ms[route] = sorted[min(len(sorted)-1, len(sorted)*95/100)].Milliseconds()
	}
	st.mu.Unlock()
	r.Missing = missingOperations(r.Operations, required)
	events.mu.Lock()
	r.Events, r.Reconnects = events.byType, events.reconnects
	events.mu.Unlock()
	r.Violations = inv.list()
	failed := false
	for _, n := range r.Checks {
		failed = failed || n != 0
	}
	r.Passed = !failed && len(r.Violations) == 0 && len(r.Failures) == 0 && len(r.Missing) == 0
}

// runFinalChecks runs every final check; a query that fails counts -1
// and its error is returned.
func runFinalChecks(ctx context.Context, pool *pgxpool.Pool) (map[string]int, []string) {
	counts, problems := map[string]int{}, []string{}
	for _, check := range finalChecks {
		if check.table != "" && !tableExists(ctx, pool, check.table) {
			continue
		}
		var n int
		if err := pool.QueryRow(ctx, check.query).Scan(&n); err != nil {
			n = -1
			problems = append(problems, check.name+": "+err.Error())
		}
		counts[check.name] = n
	}
	return counts, problems
}

func tableExists(ctx context.Context, pool *pgxpool.Pool, table string) bool {
	var exists bool
	err := pool.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, table).Scan(&exists)
	return err == nil && exists
}

// missingOperations are the required operations that never succeeded.
func missingOperations(ops map[string]map[string]int, required []string) []string {
	missing := []string{}
	for _, name := range required {
		if ops[name]["ok"] == 0 {
			missing = append(missing, name)
		}
	}
	return missing
}

func (r *report) write(path string) error {
	raw, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		return err
	}
	fmt.Printf("soak: passed=%v requests=%d operations=%d violations=%d failures=%d missing=%v checks=%v settled=%s report=%s\n",
		r.Passed, total(r.Requests), len(r.Operations), len(r.Violations), len(r.Failures), r.Missing, r.Checks, r.Settled, path)
	return nil
}

func total(m map[string]int) int {
	n := 0
	for _, v := range m {
		n += v
	}
	return n
}

// readEvents parses an SSE stream: "event:" names the type, "data:" lines
// the payload, a blank line ends an event, ":" lines are comments.
func readEvents(body io.Reader, onEvent func(eventType string, data []byte)) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64<<10), 8<<20)
	eventType, data := "", []string{}
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "":
			if eventType != "" || len(data) > 0 {
				onEvent(eventType, []byte(strings.Join(data, "\n")))
			}
			eventType, data = "", data[:0]
		case strings.HasPrefix(line, ":"):
		case strings.HasPrefix(line, "event:"):
			eventType = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return io.ErrUnexpectedEOF
}

var uuidInPath = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// routeOf names a path without its ids and query, for the counters.
func routeOf(path string) string {
	path, _, _ = strings.Cut(path, "?")
	return uuidInPath.ReplaceAllString(path, "{id}")
}
