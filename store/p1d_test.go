package store_test

import (
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestSpinoff_AvailableFollowsTheOtherSide(t *testing.T) {
	f := newFixture(t)
	main, branch := f.openBranch()
	out := f.detach(branch.ID)
	if from := f.line(branch.ID).SpunOffFrom; from == nil || !from.Available {
		t.Fatalf("the source is there: %+v", from)
	}
	marker := func() *domain.SpunOffRef {
		messages, err := f.store.ListMessages(f.ctx, tenant, main.ID, 0, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range messages {
			if m.ID == out.Marker.ID {
				return m.Meta.SpunOffTo
			}
		}
		t.Fatal("no marker")
		return nil
	}
	if to := marker(); to == nil || !to.Available {
		t.Fatalf("the new conversation is there: %+v", to)
	}
	if _, err := f.store.DeleteTree(f.ctx, tenant, branch.ID); err != nil {
		t.Fatal(err)
	}
	if to := marker(); to.Available {
		t.Fatal("the new conversation was deleted")
	}

	again, other := f.openBranch()
	f.detach(other.ID)
	if _, err := f.store.DeleteTree(f.ctx, tenant, again.ID); err != nil {
		t.Fatal(err)
	}
	if from := f.line(other.ID).SpunOffFrom; from == nil || from.Available || from.LineID != again.ID {
		t.Fatalf("the source was deleted: %+v", from)
	}
}

func TestRebalanceSignals_NameTheParent(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	branch := f.branch(main.ID, anchor.ID)
	inner := f.reply(branch.ID)
	child := f.branch(branch.ID, inner.ID)
	f.reply(child.ID)
	l := domain.RebalanceLimits{MinBranchTurns: 1, RecentTurns: 1}
	top, _ := f.store.RebalanceSignals(f.ctx, tenant, branch.ID, l)
	deep, _ := f.store.RebalanceSignals(f.ctx, tenant, child.ID, l)
	if !top.TopLevel || top.ParentTitle != "main" || deep.TopLevel || deep.ParentTitle != "check it" {
		t.Fatalf("top %+v deep %+v", top, deep)
	}
}

func TestMigrations_RecordForAHostMigrator(t *testing.T) {
	f := newFixture(t)
	if recorded, err := store.RecordFeatureMigration(f.ctx, f.pool, "search", 1); err != nil || !recorded {
		t.Fatalf("recorded %v: %v", recorded, err)
	}
	if recorded, err := store.RecordFeatureMigration(f.ctx, f.pool, "search", 1); err != nil || recorded {
		t.Fatalf("recording twice says so: %v %v", recorded, err)
	}
	if n := f.count(`SELECT count(*) FROM tangent_feature_migrations WHERE feature = 'search' AND version = 1`); n != 1 {
		t.Fatalf("rows = %d", n)
	}
	if recorded, err := store.RecordCoreMigration(f.ctx, f.pool, 999); err != nil || !recorded {
		t.Fatalf("recorded %v: %v", recorded, err)
	}
	if n := f.count(`SELECT count(*) FROM tangent_schema_migrations WHERE version = 999`); n != 1 {
		t.Fatalf("core rows = %d", n)
	}
	if _, err := store.RecordFeatureMigration(f.ctx, f.pool, " ", 1); err == nil {
		t.Fatal("a feature name is required")
	}
	if _, err := store.RecordCoreMigration(f.ctx, f.pool, 0); err == nil {
		t.Fatal("versions start at 1")
	}
}
