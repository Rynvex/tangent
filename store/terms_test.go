package store_test

import (
	"errors"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// The glossary (B24): writes lock the main line, then (saving from an
// aside) the aside line, the order the purge, continue and delete use.

func (f *fixture) term(lineID, term string) store.TermChange {
	f.t.Helper()
	out, err := f.store.CreateTerm(f.ctx, store.CreateTermInput{Tenant: tenant, LineID: lineID, Term: term, Explanation: "about " + term, Actor: "chang"})
	if err != nil {
		f.t.Fatal(err)
	}
	return out
}

func (f *fixture) termRow(id string) (root, source string) {
	f.t.Helper()
	var src *string
	if err := f.pool.QueryRow(f.ctx, `SELECT root_line_id::text, source_line_id::text FROM tangent_term WHERE id = $1`, id).Scan(&root, &src); err != nil {
		f.t.Fatal(err)
	}
	if src != nil {
		source = *src
	}
	return root, source
}

func TestGlossary_SavingFromAnAsideKeepsItInTheSameTransaction(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	aside := f.answeredAside(root.ID, anchor.ID)

	_, err := f.store.CreateTerm(f.ctx, store.CreateTermInput{Tenant: tenant, LineID: aside.ID, Term: "MVCC", Explanation: "x"}, failingHook(errors.New("host says no")))
	if err == nil || f.branchView(aside.ID).KeptAt != nil || f.count(`SELECT count(*)::int FROM tangent_term`) != 0 {
		t.Fatalf("a refused write kept the aside or the term: %v", err)
	}

	first := f.term(aside.ID, "MVCC")
	if first.Change != store.TermCreated || first.Kept == nil || first.Kept.KeptAt == nil || first.Kept.LineID != aside.ID {
		t.Fatalf("first save = %+v", first)
	}
	if first.Term.RootLineID != root.ID || first.Term.SourceLineID != aside.ID || first.Term.SourceLabel == "" {
		t.Fatalf("term = %+v", first.Term)
	}
	if f.branchView(aside.ID).KeptAt == nil {
		t.Fatal("the aside is not kept")
	}
	if second := f.term(aside.ID, "WAL"); second.Kept != nil {
		t.Fatalf("an aside kept already is not kept again: %+v", second.Kept)
	}
	if onMain := f.term(root.ID, "B-tree"); onMain.Kept != nil {
		t.Fatalf("a main line is no aside: %+v", onMain.Kept)
	}
}

func TestGlossary_SavingFromAnAsideRacingThePurge(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	f := newFixture(t, store.WithClock(clock.Now))
	root, anchor := f.mainLine()
	clock.now = time.Now().Add(2 * domain.DefaultLimits().Branch.AsideRetention)
	for i := range 10 {
		aside := f.answeredAside(root.ID, anchor.ID)
		var saved store.TermChange
		errs := race(
			func() error { _, err := f.store.PurgeExpiredAsides(f.ctx, 0); return err },
			func() (err error) {
				saved, err = f.store.CreateTerm(f.ctx, store.CreateTermInput{Tenant: tenant, LineID: aside.ID, Term: "term " + string(rune('a'+i)), Explanation: "x"})
				return err
			},
		)
		if errs[0] != nil {
			t.Fatalf("purge: %v", errs[0])
		}
		switch {
		case errs[1] == nil:
			// The save went first: the purge re-read the aside and left it.
			if view := f.branchView(aside.ID); view.KeptAt == nil {
				t.Fatalf("saved but not kept: %+v", view)
			}
			if _, source := f.termRow(saved.Term.ID); source != aside.ID {
				t.Fatalf("source = %q", source)
			}
			if _, err := f.store.KeepBranch(f.ctx, tenant, aside.ID, false); err != nil {
				t.Fatal(err)
			}
		case errors.Is(errs[1], domain.ErrLineNotFound):
			// The purge went first: nothing was saved.
			if n := f.count(`SELECT count(*)::int FROM tangent_term WHERE term = $1`, "term "+string(rune('a'+i))); n != 0 {
				t.Fatalf("%d terms saved from a purged aside", n)
			}
		default:
			t.Fatalf("save: %v", errs[1])
		}
	}
}

func TestGlossary_SavingFromAnAsideRacingItsContinue(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	for i := range 10 {
		aside := f.answeredAside(root.ID, anchor.ID)
		name := "term " + string(rune('a'+i))
		var continued store.ContinuedAside
		var saved store.TermChange
		errs := race(
			func() (err error) {
				continued, err = f.store.ContinueAside(f.ctx, f.continueInput(aside, anchor.ID))
				return err
			},
			func() (err error) {
				saved, err = f.store.CreateTerm(f.ctx, store.CreateTermInput{Tenant: tenant, LineID: aside.ID, Term: name, Explanation: "x"})
				return err
			},
		)
		if errs[0] != nil {
			t.Fatalf("continue: %v", errs[0])
		}
		switch {
		case errs[1] == nil:
			// Saved first: the continue carried the term's source over.
			if _, source := f.termRow(saved.Term.ID); source != continued.Line.ID {
				t.Fatalf("source = %q, the new branch is %s", source, continued.Line.ID)
			}
		case errors.Is(errs[1], domain.ErrLineNotFound):
		default:
			t.Fatalf("save: %v", errs[1])
		}
		if _, err := f.store.DiscardBranch(f.ctx, tenant, continued.Line.ID); err != nil {
			t.Fatal(err)
		}
	}
}

func TestGlossary_ADetachTakesTheTermsSavedInTheSubtree(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	branch := f.branch(root.ID, anchor.ID)
	below := f.branch(branch.ID, f.reply(branch.ID).ID)
	onMain, onBranch, onBelow := f.term(root.ID, "main"), f.term(branch.ID, "branch"), f.term(below.ID, "below")
	if _, err := f.store.Detach(f.ctx, store.DetachInput{Tenant: tenant, LineID: branch.ID, BuildCapsule: func(store.DetachBase) domain.OriginCapsule {
		return domain.OriginCapsule{}
	}}); err != nil {
		t.Fatal(err)
	}
	if r, _ := f.termRow(onMain.Term.ID); r != root.ID {
		t.Fatalf("the main line's term moved to %s", r)
	}
	for _, moved := range []store.TermChange{onBranch, onBelow} {
		if r, _ := f.termRow(moved.Term.ID); r != branch.ID {
			t.Fatalf("%s stayed in %s", moved.Term.Term, r)
		}
	}
	list, err := f.store.ListTerms(f.ctx, tenant, branch.ID)
	if err != nil || list.RootLineID != branch.ID || len(list.Terms) != 2 || list.Terms[0].Term != "below" {
		t.Fatalf("the new conversation's glossary: %+v %v", list, err)
	}
}

func TestGlossary_AnAttachKeepsTheTargetsTermOnACollision(t *testing.T) {
	f := newFixture(t)
	target, _ := f.mainLine()
	source, _ := f.mainLine()
	kept, dropped, moved := f.term(target.ID, "MVCC"), f.term(source.ID, " mvcc "), f.term(source.ID, "WAL")
	out, err := f.store.AttachLine(f.ctx, f.attachInput(target.ID, source.ID))
	if err != nil {
		t.Fatal(err)
	}
	if out.Moved.Terms != 1 || out.Moved.DroppedTerms != 1 {
		t.Fatalf("moved = %+v", out.Moved)
	}
	if n := f.count(`SELECT count(*)::int FROM tangent_term WHERE id = $1`, dropped.Term.ID); n != 0 {
		t.Fatal("the source's colliding term is still there")
	}
	list, err := f.store.ListTerms(f.ctx, tenant, source.ID)
	if err != nil || list.RootLineID != target.ID || len(list.Terms) != 2 {
		t.Fatalf("the target's glossary: %+v %v", list, err)
	}
	if list.Terms[0].ID != kept.Term.ID || list.Terms[1].ID != moved.Term.ID || list.Terms[1].SourceLineID != source.ID {
		t.Fatalf("terms = %+v", list.Terms)
	}
}

func TestGlossary_DeletingOrPurgingTheSourceLineKeepsTheTerm(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	f := newFixture(t, store.WithClock(clock.Now))
	root, anchor := f.mainLine()
	ended := f.branch(root.ID, anchor.ID)
	f.reply(ended.ID)
	fromBranch := f.term(ended.ID, "from a branch")
	if _, err := f.store.DiscardBranch(f.ctx, tenant, ended.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.DeleteBranch(f.ctx, tenant, ended.ID); err != nil {
		t.Fatal(err)
	}
	aside := f.answeredAside(root.ID, anchor.ID)
	fromAside := f.term(aside.ID, "from an aside")
	if _, err := f.store.KeepBranch(f.ctx, tenant, aside.ID, false); err != nil {
		t.Fatal(err)
	}
	clock.now = time.Now().Add(2 * domain.DefaultLimits().Branch.AsideRetention)
	if purged, err := f.store.PurgeExpiredAsides(f.ctx, 0); err != nil || len(purged) != 1 {
		t.Fatalf("purged %v, %v", purged, err)
	}
	list, err := f.store.ListTerms(f.ctx, tenant, root.ID)
	if err != nil || len(list.Terms) != 2 {
		t.Fatalf("glossary: %+v %v", list, err)
	}
	for i, want := range []store.TermChange{fromBranch, fromAside} {
		got := list.Terms[i]
		if got.ID != want.Term.ID || got.SourceLineID != "" || got.SourceLabel != want.Term.SourceLabel || got.SourceLabel == "" {
			t.Fatalf("term %d = %+v", i, got)
		}
	}
}

func TestGlossary_SearchIsPerTenantPrefixFirstAndSkipsArchived(t *testing.T) {
	f := newFixture(t)
	a, _ := f.mainLine()
	b, _ := f.mainLine()
	archived, _ := f.mainLine()
	f.term(a.ID, "Cache line")
	f.term(b.ID, "Prompt cache")
	f.term(a.ID, "cache")
	f.term(archived.ID, "Cache stampede")
	f.exec(`UPDATE tangent_line SET archived_at = now() WHERE id = $1`, archived.ID)
	f.exec(`UPDATE tangent_line SET title = 'Second' WHERE id = $1`, b.ID)
	f.exec(`INSERT INTO tangent_term (tenant_id, root_line_id, term, term_key, explanation) VALUES ('other', $1, 'cache x', 'cachex', 'x')`, a.ID)

	page, err := f.store.SearchTerms(f.ctx, store.TermQuery{Tenant: tenant, Query: "CACHE", Limit: 2})
	if err != nil || len(page.Terms) != 2 || page.NextCursor == "" {
		t.Fatalf("page 1: %+v %v", page, err)
	}
	next, err := f.store.SearchTerms(f.ctx, store.TermQuery{Tenant: tenant, Query: "CACHE", Limit: 2, Cursor: page.NextCursor})
	if err != nil || len(next.Terms) != 1 || next.NextCursor != "" {
		t.Fatalf("page 2: %+v %v", next, err)
	}
	got := []string{page.Terms[0].Term.Term, page.Terms[1].Term.Term, next.Terms[0].Term.Term}
	if got[0] != "cache" || got[1] != "Cache line" || got[2] != "Prompt cache" {
		t.Fatalf("order = %v", got)
	}
	if page.Terms[0].RootTitle != a.Title || next.Terms[0].RootTitle != "Second" {
		t.Fatalf("titles = %+v %+v", page.Terms[0], next.Terms[0])
	}
	if _, err := f.store.SearchTerms(f.ctx, store.TermQuery{Tenant: tenant, Cursor: "nope"}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("bad cursor: %v", err)
	}
}

func TestGlossary_ContinuingAnAsideMovesItsTermsSourceToTheNewBranch(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	aside := f.answeredAside(root.ID, anchor.ID)
	saved := f.term(aside.ID, "pool")
	continued, err := f.store.ContinueAside(f.ctx, f.continueInput(aside, anchor.ID))
	if err != nil {
		t.Fatal(err)
	}
	if r, source := f.termRow(saved.Term.ID); r != root.ID || source != continued.Line.ID {
		t.Fatalf("root %s source %s, the new branch is %s", r, source, continued.Line.ID)
	}
}
