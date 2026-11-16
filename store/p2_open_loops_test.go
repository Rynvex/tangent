package store_test

import (
	"errors"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangenttest"
)

func newFixtureWithLimits(t *testing.T, limits domain.Limits) *fixture {
	t.Helper()
	pool := tangenttest.Open(t)
	s, err := store.New(pool, limits)
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t: t, ctx: tangenttest.Context(t), pool: pool, store: s}
}

// idle makes a line's last activity days ago.
func (f *fixture) idle(lineID string, days int) {
	f.t.Helper()
	f.exec(`UPDATE tangent_line SET last_activity_at = now() - make_interval(days => $2) WHERE id = $1`, lineID, days)
}

func (f *fixture) openLoops(mutate ...func(*store.OpenLoopsQuery)) store.OpenLoops {
	f.t.Helper()
	q := store.OpenLoopsQuery{Tenant: tenant, IdleBefore: time.Now().Add(-72 * time.Hour), Notes: true, Seeds: true, SuggestionFeatures: []string{"probe"}}
	for _, m := range mutate {
		m(&q)
	}
	loops, err := f.store.OpenLoops(f.ctx, q)
	if err != nil {
		f.t.Fatal(err)
	}
	return loops
}

func TestOpenLoops_ListsEachKindOverTheTenantOrOneConversation(t *testing.T) {
	f := newFixture(t)
	main, anchor, stale := f.treeWithBranch()
	fresh := f.branch(main.ID, anchor.ID)
	f.idle(stale.ID, 5)
	other, otherAnchor := f.mainLine()
	otherStale := f.branch(other.ID, otherAnchor.ID)
	f.idle(otherStale.ID, 10)
	f.addNote(main.ID, domain.NoteSectionToConfirm, "check the visa")
	f.addNote(main.ID, domain.NoteSectionFact, "not a loop")
	f.seed(other.ID, otherAnchor.ID, "later")
	f.propose(stale.ID, "x")
	f.propose(main.ID, "y", func(in *store.ProposeInput) { in.Feature = "off" })

	all := f.openLoops()
	if all.StaleBranches.Total != 2 || all.StaleBranches.Items[0].LineID != otherStale.ID || all.StaleBranches.Items[0].RootTitle != "main" {
		t.Fatalf("stale branches, idlest first: %+v", all.StaleBranches)
	}
	if all.ToConfirm.Total != 1 || all.ToConfirm.Items[0].Text != "check the visa" || all.ToConfirm.Items[0].RootLineID != main.ID {
		t.Fatalf("notes to confirm: %+v", all.ToConfirm)
	}
	if all.Seeds.Total != 1 || all.Seeds.Items[0].RootLineID != other.ID || all.Suggestions.Total != 1 || all.Suggestions.Items[0].Feature != "probe" {
		t.Fatalf("seeds %+v suggestions %+v", all.Seeds, all.Suggestions)
	}
	one := f.openLoops(func(q *store.OpenLoopsQuery) { q.LineID = fresh.ID })
	if one.RootLineID != main.ID || one.StaleBranches.Total != 1 || one.StaleBranches.Items[0].LineID != stale.ID || one.Seeds.Total != 0 {
		t.Fatalf("one conversation: %+v", one)
	}
	none := f.openLoops(func(q *store.OpenLoopsQuery) { q.Notes, q.Seeds, q.SuggestionFeatures = false, false, nil })
	if none.ToConfirm != nil || none.Seeds != nil || none.Suggestions != nil {
		t.Fatalf("kinds that are off are left out: %+v", none)
	}
	if _, err := f.store.OpenLoops(f.ctx, store.OpenLoopsQuery{Tenant: otherTenant, LineID: main.ID}); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant's conversation: %v", err)
	}
	if theirs := f.openLoopsOf(otherTenant); theirs.StaleBranches.Total != 0 || len(theirs.StaleBranches.Items) != 0 {
		t.Fatalf("another tenant sees nothing: %+v", theirs)
	}
}

func (f *fixture) openLoopsOf(tenantID string) store.OpenLoops {
	f.t.Helper()
	loops, err := f.store.OpenLoops(f.ctx, store.OpenLoopsQuery{Tenant: tenantID, IdleBefore: time.Now()})
	if err != nil {
		f.t.Fatal(err)
	}
	return loops
}

func TestOpenLoops_LimitsArchivedAndEnded(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.OpenLoops.MaxPerKind = 2
	f := newFixtureWithLimits(t, limits)
	main, anchor := f.mainLine()
	for range 3 {
		f.idle(f.branch(main.ID, anchor.ID).ID, 4)
	}
	closed := f.branch(main.ID, anchor.ID)
	f.idle(closed.ID, 4)
	f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE line_id = $1`, closed.ID)
	loops := f.openLoops()
	if loops.StaleBranches.Total != 3 || len(loops.StaleBranches.Items) != 2 {
		t.Fatalf("capped items, exact total: %+v", loops.StaleBranches)
	}
	if view := f.line(main.ID); view.StaleBranches != 3 {
		t.Fatalf("the main line counts its stale branches: %d", view.StaleBranches)
	}
	f.exec(`UPDATE tangent_line SET archived_at = now() WHERE id = $1`, main.ID)
	if archived := f.openLoops(); archived.StaleBranches.Total != 0 {
		t.Fatalf("archived conversations are left out: %+v", archived.StaleBranches)
	}
}
