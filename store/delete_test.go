package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestDeleteTree_RemovesEveryLineAndReturnsTheHostData(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	branch := f.branch(root.ID, anchor.ID)
	outside, _ := f.mainLine()
	rootFile, err := f.store.InsertMessage(f.ctx, tenant, root.ID, store.NewMessage{Role: domain.RoleUser, Content: "x", HostMeta: json.RawMessage(`{"file":"root.png"}`)})
	if err != nil {
		t.Fatal(err)
	}
	branchTurn, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: branch.ID, Content: "y", HostMeta: json.RawMessage(`{"file":"branch.png"}`)})
	if err != nil {
		t.Fatal(err)
	}
	f.answer(branchTurn.Pending.ID, "ok")
	f.addNote(root.ID, domain.NoteSectionFact, "a note")
	if _, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: "summary", LineID: branch.ID}); err != nil {
		t.Fatal(err)
	}

	// The hook runs before the rows go, so a host can still read them.
	var seenInHook int
	hook := func(ctx context.Context, tx store.Tx, _ any) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM tangent_line WHERE id = $1`, branch.ID).Scan(&seenInHook)
	}
	deleted, err := f.store.DeleteTree(f.ctx, tenant, root.ID, hook)
	if err != nil {
		t.Fatal(err)
	}
	if seenInHook != 1 {
		t.Fatal("the hook must run before the rows are deleted")
	}
	if deleted.RootLineID != root.ID || len(deleted.LineIDs) != 2 || deleted.LineIDs[0] != root.ID {
		t.Fatalf("deleted = %+v", deleted)
	}
	if len(deleted.Messages) != 2 || deleted.Messages[0].MessageID != rootFile.ID || deleted.Messages[1].LineID != branch.ID ||
		string(deleted.Messages[1].HostMeta) != `{"file": "branch.png"}` {
		t.Fatalf("host data = %+v", deleted.Messages)
	}
	for _, id := range []string{root.ID, branch.ID} {
		if _, err := f.store.GetLine(f.ctx, tenant, id); !errors.Is(err, domain.ErrLineNotFound) {
			t.Fatalf("line %s still exists: %v", id, err)
		}
	}
	left := f.count(`SELECT (SELECT count(*) FROM tangent_message WHERE line_id = ANY($1::uuid[]))
		+ (SELECT count(*) FROM tangent_branch WHERE root_line_id = $2)
		+ (SELECT count(*) FROM tangent_note WHERE root_line_id = $2)
		+ (SELECT count(*) FROM tangent_job WHERE line_id = ANY($1::uuid[]))`, []string{root.ID, branch.ID}, root.ID)
	if left != 0 {
		t.Fatalf("rows left after the delete = %d", left)
	}
	if _, err := f.store.GetLine(f.ctx, tenant, outside.ID); err != nil {
		t.Fatalf("an unrelated conversation must stay: %v", err)
	}
}

func TestDeleteTree_Refusals(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	branch := f.branch(root.ID, anchor.ID)
	if _, err := f.store.DeleteTree(f.ctx, tenant, branch.ID); !errors.Is(err, domain.ErrDeleteNotMainLine) {
		t.Fatalf("deleting a branch = %v", err)
	}
	if _, err := f.store.DeleteTree(f.ctx, otherTenant, root.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant = %v", err)
	}
	turn := f.busy(branch.ID)
	if _, err := f.store.DeleteTree(f.ctx, tenant, root.ID); !errors.Is(err, domain.ErrDeleteBusy) {
		t.Fatalf("a branch is answering = %v", err)
	}
	if _, err := f.store.GetLine(f.ctx, tenant, root.ID); err != nil {
		t.Fatalf("a refused delete must change nothing: %v", err)
	}
	boom := errors.New("host refused")
	f.answer(turn.Pending.ID, "done")
	if _, err := f.store.DeleteTree(f.ctx, tenant, root.ID, failingHook(boom)); !errors.Is(err, boom) {
		t.Fatalf("a failing hook = %v", err)
	}
	if _, err := f.store.GetLine(f.ctx, tenant, branch.ID); err != nil {
		t.Fatalf("a failing hook must keep the tree: %v", err)
	}
	if _, err := f.store.DeleteTree(f.ctx, tenant, root.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.DeleteTree(f.ctx, tenant, root.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("deleting twice = %v", err)
	}
}
