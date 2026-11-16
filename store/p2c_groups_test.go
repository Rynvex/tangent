package store_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// endedBranch opens a branch on the anchor, gives it an exchange and ends
// it with a leaf.
func (f *fixture) endedBranch(parentID, anchorID, leaf string) string {
	f.t.Helper()
	branch := f.branch(parentID, anchorID)
	f.reply(branch.ID)
	f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE line_id = $1`, branch.ID)
	if leaf != "" {
		f.exec(`INSERT INTO tangent_leaf (line_id, tenant_id, root_line_id, kind, line, status)
			SELECT line_id, tenant_id, root_line_id, 'decision', $2, 'confirmed' FROM tangent_branch WHERE line_id = $1`, branch.ID, leaf)
	}
	return branch.ID
}

func (f *fixture) group(lineID string, members []string, mutate ...func(*store.CreateGroupInput)) (store.GroupWrite, error) {
	f.t.Helper()
	in := store.CreateGroupInput{Tenant: tenant, LineID: lineID, MemberLineIDs: members, Title: "Disks", Actor: "chang"}
	for _, m := range mutate {
		m(&in)
	}
	return f.store.CreateGroup(f.ctx, in)
}

func TestGroups_CreateListRenameDissolve(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	a, b := f.endedBranch(main.ID, anchor.ID, "new disks"), f.endedBranch(main.ID, anchor.ID, "used disks")
	written, err := f.group(a, []string{a, b, a}, func(in *store.CreateGroupInput) {
		in.Settled = []string{"8TB new"}
		in.Notes = []domain.NoteChange{{Op: "add", Section: domain.NoteSectionToConfirm, Text: "new vs used", SourceLineID: a}}
	})
	group := written.Group
	if err != nil || group.RootLineID != main.ID || group.Title != "Disks" || group.Status != domain.GroupActive || group.SummaryStatus != domain.GroupSummaryNone ||
		!slices.Equal(group.MemberLineIDs, []string{a, b}) || written.Notes.Revision != 1 || len(written.Notes.Created) != 1 {
		t.Fatalf("written = %+v %v", written, err)
	}
	list, err := f.store.ListGroups(f.ctx, tenant, b, nil)
	if err != nil || list.RootLineID != main.ID || len(list.Groups) != 1 {
		t.Fatalf("list = %+v %v", list, err)
	}
	renamed, err := f.store.RenameGroup(f.ctx, tenant, group.ID, " Disk  choices ")
	if err != nil || renamed.Title != "Disk choices" {
		t.Fatalf("renamed = %+v %v", renamed, err)
	}
	dissolved, err := f.store.DissolveGroup(f.ctx, tenant, group.ID)
	if err != nil || dissolved.Status != domain.GroupDissolved {
		t.Fatalf("dissolved = %+v %v", dissolved, err)
	}
	if _, err := f.store.DissolveGroup(f.ctx, tenant, group.ID); !errors.Is(err, domain.ErrGroupNotActive) {
		t.Fatalf("twice: %v", err)
	}
	if active, _ := f.store.ListGroups(f.ctx, tenant, main.ID, nil); len(active.Groups) != 0 {
		t.Fatalf("active only by default: %+v", active)
	}
	if all, _ := f.store.ListGroups(f.ctx, tenant, main.ID, []string{domain.GroupActive, domain.GroupDissolved}); len(all.Groups) != 1 {
		t.Fatalf("all: %+v", all)
	}
	if _, err := f.group(main.ID, []string{a, b}); err != nil {
		t.Fatalf("dissolved members are free again: %v", err)
	}
	for _, id := range []string{"x", "00000000-0000-4000-8000-0000000000aa"} {
		if _, err := f.store.GetGroup(f.ctx, tenant, id); !errors.Is(err, domain.ErrGroupNotFound) {
			t.Fatalf("%s: %v", id, err)
		}
	}
	if _, err := f.store.GetGroup(f.ctx, otherTenant, group.ID); !errors.Is(err, domain.ErrGroupNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
}

func TestGroups_Refusals(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Group.MaxActivePerTree = 1
	f := newFixtureWithLimits(t, limits)
	main, anchor := f.mainLine()
	a, b := f.endedBranch(main.ID, anchor.ID, "x"), f.endedBranch(main.ID, anchor.ID, "y")
	bare := f.endedBranch(main.ID, anchor.ID, "")
	open := f.branch(main.ID, anchor.ID)
	other, otherAnchor := f.mainLine()
	foreign := f.endedBranch(other.ID, otherAnchor.ID, "z")
	for name, members := range map[string][]string{
		"one member": {a}, "an open branch": {a, open.ID}, "no leaf": {a, bare}, "another tree": {a, foreign}, "the main line": {a, main.ID}, "bad id": {a, "x"},
	} {
		if _, err := f.group(main.ID, members); domain.CodeOf(err) != domain.CodeInvalidGroup {
			t.Errorf("%s: %v", name, err)
		}
	}
	f.exec(`UPDATE tangent_branch SET conclusion_line = 'from a card' WHERE line_id = $1`, bare)
	if _, err := f.group(main.ID, []string{a, bare}); err != nil {
		t.Fatalf("a card's conclusion will do: %v", err)
	}
	if _, err := f.group(main.ID, []string{a, b}); domain.CodeOf(err) != domain.CodeInvalidGroup {
		t.Fatalf("a branch is in one active group: %v", err)
	}
	c, d := f.endedBranch(main.ID, anchor.ID, "c"), f.endedBranch(main.ID, anchor.ID, "d")
	if _, err := f.group(main.ID, []string{c, d}); !errors.Is(err, domain.ErrGroupLimit) {
		t.Fatalf("limit: %v", err)
	}
	if _, err := f.group(main.ID, []string{c, d}, func(in *store.CreateGroupInput) { in.Tenant = otherTenant }); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
	hookErr := errors.New("no")
	if _, err := f.store.DissolveGroup(f.ctx, tenant, f.firstGroup(main.ID), func(context.Context, store.Tx, any) error { return hookErr }); !errors.Is(err, hookErr) {
		t.Fatalf("hook: %v", err)
	}
	f.exec(`UPDATE tangent_line SET archived_at = now() WHERE id = $1`, main.ID)
	if _, err := f.store.RenameGroup(f.ctx, tenant, f.firstGroup(main.ID), "t"); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("archived: %v", err)
	}
}

func (f *fixture) firstGroup(lineID string) string {
	f.t.Helper()
	list, err := f.store.ListGroups(f.ctx, tenant, lineID, nil)
	if err != nil || len(list.Groups) == 0 {
		f.t.Fatalf("groups = %+v %v", list, err)
	}
	return list.Groups[0].ID
}

func TestGroups_SummaryJobs(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	a, b := f.endedBranch(main.ID, anchor.ID, "new disks"), f.endedBranch(main.ID, anchor.ID, "used disks")
	written, _ := f.group(main.ID, []string{a, b}, func(in *store.CreateGroupInput) { in.Settled = []string{"8TB new"} })
	first, err := f.store.StartGroupSummary(f.ctx, tenant, written.Group.ID, "group")
	if err != nil || first.Group.SummaryStatus != domain.GroupSummaryDrafting || first.Job.Kind != store.JobKindGroupSummary || first.Job.LineID != main.ID {
		t.Fatalf("first = %+v %v", first, err)
	}
	source, err := f.store.GroupSummarySource(f.ctx, tenant, written.Group.ID)
	if err != nil || len(source.Members) != 2 || source.Members[0].Leaf != "new disks" || !slices.Equal(source.Settled, []string{"8TB new"}) {
		t.Fatalf("source = %+v %v", source, err)
	}
	second, _ := f.store.StartGroupSummary(f.ctx, tenant, written.Group.ID, "group")
	late, err := f.store.FinishGroupSummary(f.ctx, first.Job.ID, "stale", "")
	if err != nil || late.Written {
		t.Fatalf("a superseded summary is not written: %+v %v", late, err)
	}
	done, err := f.store.FinishGroupSummary(f.ctx, second.Job.ID, "New disks win.", "")
	if err != nil || !done.Written || done.Group.Summary != "New disks win." || done.Group.SummaryStatus != domain.GroupSummaryReady {
		t.Fatalf("done = %+v %v", done, err)
	}
	if _, err := f.store.FinishGroupSummary(f.ctx, second.Job.ID, "again", ""); !errors.Is(err, domain.ErrJobNotPending) {
		t.Fatalf("twice: %v", err)
	}
	third, _ := f.store.StartGroupSummary(f.ctx, tenant, written.Group.ID, "group")
	failed, err := f.store.FinishGroupSummary(f.ctx, third.Job.ID, "", domain.JobUnusableText)
	if err != nil || failed.Group.SummaryStatus != domain.GroupSummaryFailed || failed.Group.Summary != "New disks win." {
		t.Fatalf("a failure keeps the last summary: %+v %v", failed, err)
	}
	ready, err := f.store.ReadyGroups(f.ctx, main.ID)
	if err != nil || len(ready) != 0 {
		t.Fatalf("a failed summary is not ready: %+v %v", ready, err)
	}
	fourth, _ := f.store.StartGroupSummary(f.ctx, tenant, written.Group.ID, "group")
	f.store.FinishGroupSummary(f.ctx, fourth.Job.ID, "Ready again.", "")
	if ready, _ := f.store.ReadyGroups(f.ctx, main.ID); len(ready) != 1 || len(ready[0].MemberLineIDs) != 2 {
		t.Fatalf("ready = %+v", ready)
	}
	f.store.DissolveGroup(f.ctx, tenant, written.Group.ID)
	if _, err := f.store.StartGroupSummary(f.ctx, tenant, written.Group.ID, "group"); !errors.Is(err, domain.ErrGroupNotActive) {
		t.Fatalf("dissolved: %v", err)
	}
}

func TestGroups_ADetachDissolvesTheGroupsItTakes(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	parent := f.branch(main.ID, anchor.ID)
	reply := f.reply(parent.ID)
	a, b := f.endedBranch(parent.ID, reply.ID, "x"), f.endedBranch(parent.ID, reply.ID, "y")
	written, _ := f.group(main.ID, []string{a, b})
	f.detach(parent.ID)
	if got, _ := f.store.GetGroup(f.ctx, tenant, written.Group.ID); got.Status != domain.GroupDissolved {
		t.Fatalf("group = %+v", got)
	}
}

func TestCombine_OpenSiblingsBecomeOneBranch(t *testing.T) {
	f := newFixture(t)
	main, first := f.mainLine()
	a := f.branch(main.ID, first.ID)
	later := f.reply(main.ID)
	b := f.branch(main.ID, later.ID)
	f.reply(a.ID)
	f.reply(b.ID)
	out, err := f.store.CombineBranches(f.ctx, store.CombineInput{
		Tenant: tenant, ParentLineID: main.ID, LineIDs: []string{b.ID, a.ID}, AnchorMessageID: later.ID, Purpose: "Disks together", Kind: domain.BranchKindInvestigate,
		Pack: domain.BranchPack{Rendered: "combined pack"}, Actor: "chang",
		Notes: []domain.NoteChange{{Op: "add", Section: domain.NoteSectionToConfirm, Text: "new vs used", SourceLineID: a.ID}},
	})
	if err != nil {
		t.Fatal(err)
	}
	created := out.Created.Branch
	if created.Origin != domain.BranchOriginMerge || created.AnchorMessageID != later.ID || created.Depth != 1 || created.Purpose != "Disks together" || out.Notes.Revision != 1 {
		t.Fatalf("created = %+v", out)
	}
	if len(out.Combined) != 2 {
		t.Fatalf("combined = %+v", out.Combined)
	}
	for _, old := range out.Combined {
		if old.Status != domain.BranchStatusDiscarded || old.MergedIntoLineID != created.LineID {
			t.Fatalf("old = %+v", old)
		}
	}
	if f.branchView(a.ID).MergedIntoLineID != created.LineID {
		t.Fatal("the outline shows where it went")
	}
}

func TestCombine_Refusals(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	a, b := f.branch(main.ID, anchor.ID), f.branch(main.ID, anchor.ID)
	nested := f.branch(a.ID, f.reply(a.ID).ID)
	closed := f.endedBranch(main.ID, anchor.ID, "x")
	aside := f.aside(main.ID, anchor.ID)
	combine := func(ids ...string) error {
		_, err := f.store.CombineBranches(f.ctx, store.CombineInput{
			Tenant: tenant, ParentLineID: main.ID, LineIDs: ids, AnchorMessageID: anchor.ID, Purpose: "p", Kind: domain.BranchKindInvestigate,
		})
		return err
	}
	cases := map[string]struct {
		ids  []string
		code string
	}{
		"one":           {[]string{a.ID}, domain.CodeInvalidGroup},
		"other parent":  {[]string{a.ID, nested.ID}, domain.CodeInvalidGroup},
		"closed":        {[]string{a.ID, closed}, domain.CodeBranchClosed},
		"aside":         {[]string{a.ID, aside.ID}, domain.CodeInvalidGroup},
		"the main line": {[]string{a.ID, main.ID}, domain.CodeInvalidGroup},
	}
	for name, c := range cases {
		if err := combine(c.ids...); domain.CodeOf(err) != c.code {
			t.Errorf("%s: %v", name, err)
		}
	}
	turn := f.busy(b.ID)
	if err := combine(a.ID, b.ID); !errors.Is(err, domain.ErrBranchBusy) {
		t.Fatalf("busy: %v", err)
	}
	f.answer(turn.Pending.ID, "done")
	hookErr := errors.New("no")
	_, err := f.store.CombineBranches(f.ctx, store.CombineInput{
		Tenant: tenant, ParentLineID: main.ID, LineIDs: []string{a.ID, b.ID}, AnchorMessageID: anchor.ID, Purpose: "p", Kind: domain.BranchKindInvestigate,
	}, func(context.Context, store.Tx, any) error { return hookErr })
	if !errors.Is(err, hookErr) || f.branchView(a.ID).Status != domain.BranchStatusOpen {
		t.Fatalf("rolled back: %v", err)
	}
}

func TestRelations_TheLabelCanChange(t *testing.T) {
	f := newFixture(t)
	main, _, branch := f.treeWithBranch()
	created, _ := f.relate(main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: branch.ID}, "old")
	changed, err := f.store.UpdateRelationLabel(f.ctx, tenant, branch.ID, created.Link.ID, "  new\nlabel ")
	if err != nil || changed.Link.Label != "new label" || !slices.Equal(changed.RootLineIDs, []string{main.ID}) {
		t.Fatalf("changed = %+v %v", changed, err)
	}
	other, _ := f.mainLine()
	if _, err := f.store.UpdateRelationLabel(f.ctx, tenant, other.ID, created.Link.ID, "x"); !errors.Is(err, domain.ErrRelationNotFound) {
		t.Fatalf("another conversation: %v", err)
	}
	if _, err := f.store.UpdateRelationLabel(f.ctx, tenant, main.ID, created.Link.ID, string(make([]rune, 201))); domain.CodeOf(err) != domain.CodeTooLong {
		t.Fatalf("long: %v", err)
	}
}

func TestP2cConcurrency_OverlappingGroupsAndCombinesWinOnce(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	for range 4 {
		a, b, c := f.endedBranch(main.ID, anchor.ID, "a"), f.endedBranch(main.ID, anchor.ID, "b"), f.endedBranch(main.ID, anchor.ID, "c")
		errs := race(
			func() error { _, err := f.group(main.ID, []string{a, b}); return err },
			func() error { _, err := f.group(main.ID, []string{b, c}); return err },
			func() error { _, err := f.group(main.ID, []string{a, c}); return err },
		)
		won := 0
		for _, err := range errs {
			switch {
			case err == nil:
				won++
			case domain.CodeOf(err) != domain.CodeInvalidGroup:
				t.Fatalf("unexpected: %v", err)
			}
		}
		if won != 1 {
			t.Fatalf("%d groups won: %v", won, errs)
		}
		x, y, z := f.branch(main.ID, anchor.ID), f.branch(main.ID, anchor.ID), f.branch(main.ID, anchor.ID)
		combine := func(ids ...string) func() error {
			return func() error {
				_, err := f.store.CombineBranches(f.ctx, store.CombineInput{
					Tenant: tenant, ParentLineID: main.ID, LineIDs: ids, AnchorMessageID: anchor.ID, Purpose: "p", Kind: domain.BranchKindInvestigate,
				})
				return err
			}
		}
		won = 0
		for _, err := range race(combine(x.ID, y.ID), combine(y.ID, z.ID)) {
			switch {
			case err == nil:
				won++
			case !errors.Is(err, domain.ErrBranchClosed):
				t.Fatalf("unexpected: %v", err)
			}
		}
		if won != 1 {
			t.Fatalf("%d combines won", won)
		}
		f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE parent_line_id = $1 AND status = 'open'`, main.ID)
	}
}
