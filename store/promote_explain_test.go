package store_test

import (
	"os"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Rynvex/tangent/tangenttest/seed"
)

// TestPromote_Explain prints the plan of moving a promotion's old tail on a
// seeded tree; run with TANGENT_PERF_EXPLAIN=1.
func TestPromote_Explain(t *testing.T) {
	if os.Getenv("TANGENT_PERF_EXPLAIN") != "1" {
		t.Skip("set TANGENT_PERF_EXPLAIN=1 to print the promotion plans")
	}
	f := newSearchFixture(t)
	tree, err := seed.Write(f.ctx, f.pool, seed.Config{Tenant: tenant, Seed: 100, Branches: 199})
	if err != nil {
		t.Fatal(err)
	}
	f.exec("ANALYZE")
	anchor := tree.MainMessages[len(tree.MainMessages)/2]
	target := tree.Branches[0].LineID
	err = pgx.BeginFunc(f.ctx, f.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(f.ctx, `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) UPDATE tangent_message SET line_id = $1
			WHERE line_id = $2 AND seq > (SELECT seq FROM tangent_message WHERE id = $3)`, target, tree.MainID, anchor)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var line string
			_ = rows.Scan(&line)
			t.Log(line)
		}
		return pgx.ErrTxClosed // roll back
	})
	if err != nil && err != pgx.ErrTxClosed {
		t.Fatal(err)
	}
}
