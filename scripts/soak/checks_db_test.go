package main

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// TestFinalChecks_CountWhatTheyLookFor plants one of each problem the new
// final checks look for and checks each is counted (and that a clean
// database counts nothing).
func TestFinalChecks_CountWhatTheyLookFor(t *testing.T) {
	pool := tangenttest.OpenFeatures(t, tangent.FeatureSearch, tangent.FeatureMemory)
	ctx := tangenttest.Context(t)
	counts, problems := runFinalChecks(ctx, pool)
	for name, n := range counts {
		if n != 0 {
			t.Errorf("a clean database: %s = %d", name, n)
		}
	}
	if len(problems) != 0 || len(counts) != len(finalChecks) {
		t.Fatalf("checks %d of %d, problems %v", len(counts), len(finalChecks), problems)
	}
	plantProblems(t, ctx, pool)
	counts, problems = runFinalChecks(ctx, pool)
	want := map[string]int{
		"overlappingFolds": 1, "draftingFolds": 1, "suggestionsOnDeletedObjects": 1, "memorySupersedeCycles": 2,
		"tagsOnUntaggableMessages": 1, "pendingReplies": 1, "activeMemoriesWithoutEmbedding": 0,
	}
	for name, n := range want {
		if counts[name] != n {
			t.Errorf("%s = %d, want %d", name, counts[name], n)
		}
	}
	if len(problems) != 0 {
		t.Fatal(problems)
	}
}

// plantProblems writes one of each problem: overlapping folds, a drafting
// fold, a suggestion about a message that is gone, two memories that
// supersede each other, a tag on a pending reply.
func plantProblems(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	var line, pending string
	plant := []string{
		`INSERT INTO tangent_line (tenant_id, title) VALUES ('t', 'planted') RETURNING id`,
		`INSERT INTO tangent_message (line_id, tenant_id, role, status) SELECT id, 't', 'assistant', 'pending' FROM tangent_line RETURNING id`,
	}
	if err := pool.QueryRow(ctx, plant[0]).Scan(&line); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, plant[1]).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		// Two drafting / active folds of one line that overlap.
		`INSERT INTO tangent_fold (tenant_id, line_id, from_message_id, to_message_id, from_seq, to_seq, status)
			VALUES ('t', $1, gen_random_uuid(), gen_random_uuid(), 1, 5, 'active'), ('t', $1, gen_random_uuid(), gen_random_uuid(), 5, 9, 'drafting')`,
		// An open suggestion about a message that is gone.
		`INSERT INTO tangent_suggestion (tenant_id, root_line_id, line_id, feature, kind, target_key, payload)
			VALUES ('t', $1, $1, 'fold', 'fold', 'fold:x', jsonb_build_object('fromMessageId', gen_random_uuid()::text))`,
	} {
		if _, err := pool.Exec(ctx, statement, line); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
	// Two memories that supersede each other.
	var a, b string
	memory := `INSERT INTO tangent_memory (tenant_id, kind, text, importance) VALUES ('t', 'fact', $1, 5) RETURNING id`
	if pool.QueryRow(ctx, memory, "a").Scan(&a) != nil || pool.QueryRow(ctx, memory, "b").Scan(&b) != nil {
		t.Fatal("insert memories")
	}
	for _, pair := range [][2]string{{a, b}, {b, a}} {
		if _, err := pool.Exec(ctx, `UPDATE tangent_memory SET status = 'superseded', superseded_by = $2 WHERE id = $1`, pair[0], pair[1]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tangent_message_tag (message_id, tenant_id, kind, source) VALUES ($1, 't', 'idea', 'user')`, pending); err != nil {
		t.Fatal(err)
	}
}
