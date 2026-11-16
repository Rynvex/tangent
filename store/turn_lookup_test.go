package store_test

import (
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestTurnLookup_GetTurnNamesThePendingTurnsLineAndTree(t *testing.T) {
	f := newFixture(t)
	line, anchor := f.mainLine()
	branch, err := f.store.CreateBranch(f.ctx, store.CreateBranchInput{
		Tenant: tenant, ParentLineID: line.ID, AnchorMessageID: anchor.ID, Purpose: "dig", Kind: domain.BranchKindInvestigate,
	})
	if err != nil {
		t.Fatal(err)
	}
	begun, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: branch.Line.ID, Content: "q"})
	if err != nil {
		t.Fatal(err)
	}

	ref, err := f.store.GetTurn(f.ctx, begun.Pending.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ref.Tenant != tenant || ref.LineID != branch.Line.ID || ref.RootLineID != line.ID || ref.TurnID != begun.Pending.ID {
		t.Fatalf("ref = %+v", ref)
	}

	pending, ok, err := f.store.PendingTurn(f.ctx, tenant, branch.Line.ID)
	if err != nil || !ok || pending.ID != begun.Pending.ID {
		t.Fatalf("pending = %+v %v %v", pending, ok, err)
	}
}

func TestTurnLookup_FinishedUnknownAndMalformedTurnsAreNotPending(t *testing.T) {
	f := newFixture(t)
	line, anchor := f.mainLine()
	for _, id := range []string{anchor.ID, uuid.NewString(), "nope"} {
		if _, err := f.store.GetTurn(f.ctx, id); !errors.Is(err, domain.ErrTurnNotPending) {
			t.Fatalf("GetTurn(%q) err = %v", id, err)
		}
	}
	if _, ok, err := f.store.PendingTurn(f.ctx, tenant, line.ID); err != nil || ok {
		t.Fatalf("no pending turn expected: ok=%v err=%v", ok, err)
	}
	if _, _, err := f.store.PendingTurn(f.ctx, otherTenant, line.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("other tenant err = %v", err)
	}
}
