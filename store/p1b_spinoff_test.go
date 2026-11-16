package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// capsuleOf builds a capsule from a detach base as the engine would.
func capsuleOf(base store.DetachBase) domain.OriginCapsule {
	return domain.BuildOriginCapsule(domain.OriginCapsuleInput{
		Mode: domain.SpinoffDetach, From: base.From, Background: base.Pack.Rendered, Leaf: base.Leaf,
	})
}

func (f *fixture) detach(lineID string, mutate ...func(*store.DetachInput)) store.SpunOff {
	f.t.Helper()
	in := store.DetachInput{Tenant: tenant, LineID: lineID, Title: "On its own", Actor: "chang", WithLeaf: true, BuildCapsule: capsuleOf}
	for _, m := range mutate {
		m(&in)
	}
	out, err := f.store.Detach(f.ctx, in)
	if err != nil {
		f.t.Fatal(err)
	}
	return out
}

func TestDetach_ABranchAndItsSubtreeBecomeANewTree(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	branch := f.branch(main.ID, anchor.ID)
	inner := f.reply(branch.ID)
	child := f.branch(branch.ID, inner.ID)
	grand := f.branch(child.ID, f.reply(child.ID).ID)
	sibling := f.branch(main.ID, anchor.ID)
	f.propose(child.ID, "c")
	f.propose(branch.ID, "b")
	f.seed(branch.ID, inner.ID, "moves with the branch")
	f.seed(main.ID, anchor.ID, "stays")
	if _, err := f.store.PutLeaf(f.ctx, store.PutLeafInput{Tenant: tenant, LineID: child.ID, Leaf: domain.LeafInput{Kind: "answer", Line: "child leaf"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.PutLeaf(f.ctx, store.PutLeafInput{Tenant: tenant, LineID: branch.ID, Leaf: domain.LeafInput{Kind: "to_continue", Line: "own leaf"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: main.ID, Changes: []domain.NoteChange{
		{Op: "add", Section: "fact", Text: "from the branch", SourceMessageID: inner.ID},
	}}); err != nil {
		t.Fatal(err)
	}
	f.exec(`UPDATE tangent_note SET source_label = '' WHERE root_line_id = $1`, main.ID)
	out := f.detach(branch.ID, func(in *store.DetachInput) { in.CopyNotes = true })
	checkDetached(t, f, detachedTree{main: main.ID, anchor: anchor.ID, branch: branch.ID, child: child.ID, grand: grand.ID, sibling: sibling.ID}, out)
}

// detachedTree names the lines of the detach test.
type detachedTree struct{ main, anchor, branch, child, grand, sibling string }

func checkDetached(t *testing.T, f *fixture, d detachedTree, out store.SpunOff) {
	t.Helper()
	checkDetachedViews(t, d, out)

	// The new tree.
	if got := f.branchView(d.child); got.RootLineID != d.branch || got.Depth != 1 || f.branchView(d.grand).Depth != 2 {
		t.Fatalf("child = %+v", got)
	}
	if n := f.count(`SELECT count(*) FROM tangent_branch WHERE root_line_id = $1`, d.branch); n != 2 {
		t.Fatalf("the new tree has %d branches", n)
	}
	if n := f.count(`SELECT count(*) FROM tangent_branch WHERE root_line_id = $1`, d.main); n != 1 {
		t.Fatalf("the old tree keeps the sibling only: %d (%s)", n, d.sibling)
	}
	if n := f.count(`SELECT count(*) FROM tangent_leaf WHERE root_line_id = $1`, d.branch); n != 1 {
		t.Fatalf("the child's leaf moved, the branch's own went into the capsule: %d", n)
	}
	if n := f.count(`SELECT count(*) FROM tangent_suggestion WHERE root_line_id = $1 AND line_id = $2`, d.branch, d.child); n != 1 {
		t.Fatalf("the subtree's suggestions moved: %d", n)
	}
	if n := f.count(`SELECT count(*) FROM tangent_suggestion WHERE root_line_id = $1 AND line_id = $2`, d.main, d.branch); n != 1 {
		t.Fatalf("the detached line's own suggestions stay in the old tree: %d", n)
	}
	if n := f.count(`SELECT count(*) FROM tangent_seed WHERE root_line_id = $1`, d.branch); n != 1 {
		t.Fatalf("the seed anchored in the branch moved: %d", n)
	}
	copied, _ := f.store.ListNotes(f.ctx, tenant, d.branch)
	if len(copied.Notes) != 1 || copied.Revision != 1 || copied.Notes[0].CopiedFromNoteID == "" || copied.Notes[0].SourceLabel != "查證・check it" {
		t.Fatalf("copied notes = %+v", copied)
	}
	old, _ := f.store.ListNotes(f.ctx, tenant, d.main)
	if old.Notes[0].SourceLabel != "查證・check it" {
		t.Fatalf("the old tree's note keeps its source as a label: %+v", old.Notes[0])
	}
	if _, err := f.store.GetBranch(f.ctx, tenant, d.branch); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("no branch record any more: %v", err)
	}
	links, err := f.store.ListLinks(f.ctx, tenant, d.grand, []string{domain.LinkKindSpinoff})
	if err != nil || len(links) != 1 || links[0].ID != out.Link.ID {
		t.Fatalf("links from the new tree = %+v %v", links, err)
	}
	if links, _ := f.store.ListLinks(f.ctx, tenant, d.sibling, []string{domain.LinkKindSpinoff}); len(links) != 1 {
		t.Fatal("and from the old tree")
	}
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }

func TestDetach_Refusals(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	in := func(lineID string) store.DetachInput {
		return store.DetachInput{Tenant: tenant, LineID: lineID, Title: "x", BuildCapsule: capsuleOf}
	}
	if _, err := f.store.Detach(f.ctx, in(main.ID)); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("a main line: %v", err)
	}
	busy := f.branch(main.ID, anchor.ID)
	below := f.branch(busy.ID, f.reply(busy.ID).ID)
	f.busy(below.ID)
	if _, err := f.store.Detach(f.ctx, in(busy.ID)); !errors.Is(err, domain.ErrBranchBusy) {
		t.Fatalf("a line of the subtree is answering: %v", err)
	}
	closed := f.branch(main.ID, anchor.ID)
	if _, err := f.store.DiscardBranch(f.ctx, tenant, closed.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.Detach(f.ctx, in(closed.ID)); !errors.Is(err, domain.ErrBranchClosed) {
		t.Fatalf("a closed branch: %v", err)
	}
	open := f.branch(main.ID, anchor.ID)
	f.busy(main.ID)
	if _, err := f.store.Detach(f.ctx, in(open.ID)); !errors.Is(err, domain.ErrBranchSourceBusy) {
		t.Fatalf("the parent is answering: %v", err)
	}
	if _, err := f.store.Detach(f.ctx, store.DetachInput{Tenant: otherTenant, LineID: open.ID, Title: "x", BuildCapsule: capsuleOf}); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
	if _, err := f.store.Detach(f.ctx, in(open.ID), failingHook(errors.New("no"))); err == nil {
		t.Fatal("the hook refused")
	}
	if f.branchView(open.ID).RootLineID != main.ID {
		t.Fatal("rolled back")
	}
}

func TestFresh_ANewMainLineFromAMessage(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	branch := f.branch(main.ID, anchor.ID)
	at := f.reply(branch.ID)
	f.reply(branch.ID)
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: main.ID, Changes: []domain.NoteChange{
		{Op: "add", Section: "decided", Text: "keep it"},
	}}); err != nil {
		t.Fatal(err)
	}
	capsule := domain.BuildOriginCapsule(domain.OriginCapsuleInput{Mode: domain.SpinoffFresh, From: domain.SpunOffRef{LineID: branch.ID, MessageID: at.ID, Title: "check it"}, Path: "## Path\n> x"})
	out, err := f.store.SpinOffFresh(f.ctx, store.FreshInput{
		Tenant: tenant, LineID: branch.ID, AtMessageID: at.ID, Title: "Fresh start", Actor: "chang", CopyNotes: true, Capsule: capsule,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Line.ID == branch.ID || out.Line.ConversationBranch != nil || out.Line.Title != "Fresh start" || out.Line.Model != "haiku" ||
		out.Line.SpunOffFrom == nil || out.Line.SpunOffFrom.MessageID != at.ID || out.Line.Capsule.Rendered != capsule.Rendered {
		t.Fatalf("fresh = %+v", out.Line)
	}
	if out.Marker.LineID != branch.ID || out.Link.FromMessageID != at.ID || out.Notes.Revision != 1 || len(out.Notes.Created) != 1 || out.Branch.LineID != "" {
		t.Fatalf("out = %+v", out)
	}
	if f.branchView(branch.ID).Status != domain.BranchStatusOpen {
		t.Fatal("the source is untouched")
	}
	for name, bad := range map[string]store.FreshInput{
		"not on the line": {Tenant: tenant, LineID: main.ID, AtMessageID: at.ID, Title: "x", Capsule: capsule},
		"not a message":   {Tenant: tenant, LineID: main.ID, AtMessageID: main.ID, Title: "x", Capsule: capsule},
	} {
		if _, err := f.store.SpinOffFresh(f.ctx, bad); !errors.Is(err, domain.ErrBranchAnchorNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestDetach_RacesPromoteAndMerge(t *testing.T) {
	f := newFixture(t)
	for range 4 {
		main, branch := f.openBranch()
		errs := race(
			func() error {
				_, err := f.store.Detach(f.ctx, store.DetachInput{Tenant: tenant, LineID: branch.ID, Title: "x", BuildCapsule: capsuleOf})
				return err
			},
			func() error { _, err := f.store.PromoteBranch(f.ctx, tenant, branch.ID); return err },
			func() error {
				_, err := f.store.MergeBranch(f.ctx, store.MergeBranchInput{
					Tenant: tenant, LineID: branch.ID, Card: domain.BranchCard{Question: "q", Conclusion: "c"}, Content: "c", ParentTipMessageID: f.parentTip(main.ID),
				})
				return err
			},
		)
		won := 0
		for _, err := range errs {
			if err == nil {
				won++
			}
		}
		if won != 1 {
			t.Fatalf("%d of detach / promote / merge won: %v", won, errs)
		}
	}
}

func TestRebalanceSignals_CountTurnsAndRecency(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	branch := f.branch(main.ID, anchor.ID)
	for range 3 {
		f.reply(branch.ID)
	}
	l := domain.RebalanceLimits{MinBranchTurns: 3, ShareFactor: 2, RecentTurns: 3}
	state, err := f.store.RebalanceSignals(f.ctx, tenant, branch.ID, l)
	if err != nil || !state.Eligible || !state.TopLevel || state.Signals != (domain.RebalanceSignals{BranchTurns: 3, ParentTurns: 0, RecentInBranch: true}) {
		t.Fatalf("state = %+v %v", state, err)
	}
	f.reply(main.ID)
	state, _ = f.store.RebalanceSignals(f.ctx, tenant, branch.ID, l)
	if state.Signals.ParentTurns != 1 || state.Signals.RecentInBranch {
		t.Fatalf("after a parent turn: %+v", state.Signals)
	}
	if state, _ := f.store.RebalanceSignals(f.ctx, tenant, branch.ID, domain.RebalanceLimits{MinBranchTurns: 2, RecentTurns: 9}); state.Signals.RecentInBranch {
		t.Fatal("fewer replies than asked for")
	}
	if state, _ := f.store.RebalanceSignals(f.ctx, tenant, branch.ID, domain.RebalanceLimits{MinBranchTurns: 9, RecentTurns: 9}); state.Signals.ParentTurns != 0 {
		t.Fatal("too few replies: not measured further")
	}
	if _, err := f.store.RebalanceSignals(f.ctx, tenant, main.ID, l); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("a main line: %v", err)
	}
	if _, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID); err != nil {
		t.Fatal(err)
	}
	if state, _ := f.store.RebalanceSignals(f.ctx, tenant, branch.ID, l); state.Eligible {
		t.Fatal("an ended branch is not eligible")
	}
}

func TestSeeds_ExpandWalksUpFromAnEndedLine(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	branch := f.branch(main.ID, anchor.ID)
	inBranch := f.reply(branch.ID)
	child := f.branch(branch.ID, inBranch.ID)
	inChild := f.reply(child.ID)
	onMerged := f.seed(branch.ID, inBranch.ID, "on the merged branch")
	underMerged := f.seed(child.ID, inChild.ID, "under the merged branch")
	if _, err := f.store.MergeBranch(f.ctx, store.MergeBranchInput{
		Tenant: tenant, LineID: branch.ID, Card: domain.BranchCard{Question: "q", Conclusion: "c"}, Content: "c", ParentTipMessageID: f.parentTip(main.ID),
	}); err != nil {
		t.Fatal(err)
	}
	for _, seed := range []domain.Seed{onMerged, underMerged} {
		plan, err := f.store.PlanSeedExpansion(f.ctx, tenant, seed.ID)
		if err != nil || plan.ParentLineID != main.ID || plan.AnchorMessageID != anchor.ID {
			t.Fatalf("%s: expands at the merged branch's fork on the main line: %+v %v", seed.Text, plan, err)
		}
	}
	_, err := f.store.ExpandSeed(f.ctx, store.ExpandSeedInput{SeedID: underMerged.ID, CreateBranchInput: f.branchInput(main.ID, anchor.ID)})
	if err != nil {
		t.Fatalf("the expansion works there: %v", err)
	}
}

func TestInbox_LineViewsCountTheFeaturesTheContextNames(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	f.propose(main.ID, "a")
	f.propose(main.ID, "b", func(in *store.ProposeInput) { in.Feature = "other" })
	if got := f.line(main.ID).OpenSuggestions; got != 2 {
		t.Fatalf("without a filter: %d", got)
	}
	line, _ := f.store.GetLine(store.WithInboxFeatures(f.ctx, []string{"probe"}), tenant, main.ID)
	if line.OpenSuggestions != 1 {
		t.Fatalf("filtered: %d", line.OpenSuggestions)
	}
	none, _ := f.store.GetLine(store.WithInboxFeatures(context.Background(), nil), tenant, main.ID)
	if none.OpenSuggestions != 0 {
		t.Fatalf("no features on: %d", none.OpenSuggestions)
	}
}

func TestSpinoff_MoreRefusals(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	drafting := f.branch(main.ID, anchor.ID)
	f.reply(drafting.ID)
	if _, err := f.store.ClaimBranchDraft(f.ctx, tenant, drafting.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.Detach(f.ctx, store.DetachInput{Tenant: tenant, LineID: drafting.ID, BuildCapsule: capsuleOf}); !errors.Is(err, domain.ErrBranchDrafting) {
		t.Fatalf("drafting: %v", err)
	}
	if _, err := f.store.Detach(f.ctx, store.DetachInput{Tenant: tenant, LineID: drafting.ID}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("no capsule builder: %v", err)
	}
	fresh := func(lineID, at string) error {
		_, err := f.store.SpinOffFresh(f.ctx, store.FreshInput{Tenant: tenant, LineID: lineID, AtMessageID: at, Title: "x"})
		return err
	}
	if _, err := f.store.SpinOffFresh(f.ctx, store.FreshInput{Tenant: tenant, LineID: main.ID, AtMessageID: anchor.ID}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("no title: %v", err)
	}
	if err := fresh(unknownLine, anchor.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("unknown line: %v", err)
	}
	busy := f.branch(main.ID, anchor.ID)
	at := f.reply(busy.ID)
	f.busy(busy.ID)
	if err := fresh(busy.ID, at.ID); !errors.Is(err, domain.ErrBranchSourceBusy) {
		t.Fatalf("busy source: %v", err)
	}
	if _, err := f.store.ArchiveTree(f.ctx, tenant, main.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := fresh(main.ID, anchor.ID); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("archived: %v", err)
	}
	if _, err := f.store.ListLinks(f.ctx, otherTenant, main.ID, nil); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("links of another tenant: %v", err)
	}
	if _, err := f.store.SpinOffFresh(f.ctx, store.FreshInput{Tenant: tenant, LineID: main.ID, AtMessageID: anchor.ID, Title: "x"}, failingHook(errors.New("no"))); err == nil {
		t.Fatal("the hook refused")
	}
}

const unknownLine = "00000000-0000-4000-8000-0000000000aa"

// checkDetachedViews checks what Detach returned.
func checkDetachedViews(t *testing.T, d detachedTree, out store.SpunOff) {
	t.Helper()
	if out.Line.ID != d.branch || out.Line.ConversationBranch != nil || out.Line.Title != "On its own" || out.Line.SpunOffFrom == nil ||
		out.Line.SpunOffFrom.LineID != d.main || out.Line.SpunOffFrom.MessageID != d.anchor || out.Line.SpunOffFrom.Title != "main" {
		t.Fatalf("new main line = %+v", out.Line)
	}
	if out.Line.Capsule == nil || out.Line.Capsule.Mode != domain.SpinoffDetach || !contains(out.Line.Capsule.Rendered, "own leaf") ||
		!contains(out.Line.Capsule.Rendered, "pack text") {
		t.Fatalf("capsule = %+v", out.Line.Capsule)
	}
	if out.Branch.LineID != d.branch || out.OldRootLineID != d.main || out.SourceLineID != d.main || len(out.Moved) != 2 || out.MovedSeeds != 1 {
		t.Fatalf("detached = %+v", out)
	}
	if out.Marker.Kind != domain.MessageKindBranchMarker || out.Marker.LineID != d.main || out.Marker.Meta.SpunOffTo == nil ||
		out.Marker.Meta.SpunOffTo.LineID != d.branch || out.Marker.Meta.SpunOffTo.MessageID != d.anchor {
		t.Fatalf("marker = %+v", out.Marker)
	}
	if out.Link.Kind != domain.LinkKindSpinoff || out.Link.FromLineID != d.main || out.Link.ToLineID != d.branch || out.Link.ToTitle != "On its own" {
		t.Fatalf("link = %+v", out.Link)
	}
}
