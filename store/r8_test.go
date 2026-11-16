package store_test

import (
	"errors"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// R8 review fixes (docs/prompts/review/R8-findings.md).

func TestR8_E2_ADetachReportsTheGroupsItDissolves(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	parent := f.branch(main.ID, anchor.ID)
	reply := f.reply(parent.ID)
	a, b := f.endedBranch(parent.ID, reply.ID, "x"), f.endedBranch(parent.ID, reply.ID, "y")
	written, _ := f.group(main.ID, []string{a, b})
	out := f.detach(parent.ID)
	if len(out.DissolvedGroups) != 1 || out.DissolvedGroups[0].ID != written.Group.ID || out.DissolvedGroups[0].Status != domain.GroupDissolved {
		t.Fatalf("dissolved = %+v", out.DissolvedGroups)
	}
}

func TestR8_E2_ATimedOutSummaryLeavesADissolvedGroupAlone(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	a, b := f.endedBranch(main.ID, anchor.ID, "x"), f.endedBranch(main.ID, anchor.ID, "y")
	written, _ := f.group(main.ID, []string{a, b})
	claim, _ := f.store.StartGroupSummary(f.ctx, tenant, written.Group.ID, "group")
	f.store.DissolveGroup(f.ctx, tenant, written.Group.ID)
	group, err := f.store.FailGroupSummaryOfJob(f.ctx, claim.Job.ID)
	if err != nil || group != nil {
		t.Fatalf("a dissolved group is not marked: %+v %v", group, err)
	}
	if got, _ := f.store.GetGroup(f.ctx, tenant, written.Group.ID); got.SummaryStatus != domain.GroupSummaryDrafting || got.Status != domain.GroupDissolved {
		t.Fatalf("group = %+v", got)
	}
}

func TestR8_E3_APromotedBranchIsNoMember(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	a := f.endedBranch(main.ID, anchor.ID, "x")
	promoted := f.endedBranch(main.ID, anchor.ID, "y")
	f.exec(`UPDATE tangent_branch SET status = 'promoted' WHERE line_id = $1`, promoted)
	if _, err := f.group(main.ID, []string{a, promoted}); domain.CodeOf(err) != domain.CodeInvalidGroup {
		t.Fatalf("promoted: %v", err)
	}
}

func TestR8_E4_ConcurrentDeletesAndUpdatesOfOneRelation(t *testing.T) {
	f := newFixture(t)
	main, _, branch := f.treeWithBranch()
	for range 5 {
		created, err := f.relate(main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: branch.ID}, "")
		if err != nil {
			t.Fatal(err)
		}
		id := created.Link.ID
		errs := race(
			func() error { _, err := f.store.DeleteRelation(f.ctx, tenant, main.ID, id); return err },
			func() error { _, err := f.store.DeleteRelation(f.ctx, tenant, branch.ID, id); return err },
			func() error { _, err := f.store.UpdateRelationLabel(f.ctx, tenant, main.ID, id, "late"); return err },
		)
		deleted := 0
		for i, err := range errs {
			switch {
			case err == nil && i < 2:
				deleted++
			case err == nil:
			case !errors.Is(err, domain.ErrRelationNotFound):
				t.Fatalf("call %d: %v", i, err)
			}
		}
		if deleted != 1 {
			t.Fatalf("%d deletes won: %v", deleted, errs)
		}
	}
}

func TestR8_E5_AMovedMessageEndIsStillADuplicate(t *testing.T) {
	f := newFixture(t)
	main, _, branch := f.treeWithBranch()
	question := f.message(main.ID, domain.RoleUser, "move me")
	f.message(main.ID, domain.RoleAssistant, "moved")
	if _, err := f.relate(main.ID, store.RelationEnd{LineID: main.ID, MessageID: question.ID}, store.RelationEnd{LineID: branch.ID}, ""); err != nil {
		t.Fatal(err)
	}
	moved := f.move(main.ID, 2)
	_, err := f.relate(main.ID, store.RelationEnd{LineID: moved.Line.ID, MessageID: question.ID}, store.RelationEnd{LineID: branch.ID}, "again")
	if !errors.Is(err, domain.ErrRelationExists) {
		t.Fatalf("the same message and line: %v", err)
	}
	if _, err := f.relate(main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: branch.ID}, "the line itself"); err != nil {
		t.Fatalf("a line end is another place than a message on it: %v", err)
	}
}

func TestR8_E6_ARelationToAnArchivedConversationCanBeDeleted(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	other, _ := f.mainLine()
	first, _ := f.relate(main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: other.ID}, "")
	second, _ := f.relate(main.ID, store.RelationEnd{LineID: main.ID, MessageID: f.reply(main.ID).ID}, store.RelationEnd{LineID: other.ID}, "")
	f.exec(`UPDATE tangent_line SET archived_at = now() WHERE id = $1`, other.ID)
	if _, err := f.store.DeleteRelation(f.ctx, tenant, main.ID, first.Link.ID); err != nil {
		t.Fatalf("the caller's tree is not archived: %v", err)
	}
	if _, err := f.store.DeleteRelation(f.ctx, tenant, other.ID, second.Link.ID); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("from the archived side: %v", err)
	}
}
