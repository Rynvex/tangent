package tangent_test

import (
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// R8 review fixes (docs/prompts/review/R8-findings.md).

func TestR8_E1_RehungChildrenCanBeCombinedAgain(t *testing.T) {
	e, _ := groupEnv(t, tangent.ModeManual)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	a, b := e.branch(main.ID, anchor.Message.ID, "A"), e.branch(main.ID, anchor.Message.ID, "B")
	onA, onB := e.turn(a.Line.ID, "in a", "ra"), e.turn(b.Line.ID, "in b", "rb")
	c1, c2 := e.branch(a.Line.ID, onA.Message.ID, "C1"), e.branch(b.Line.ID, onB.Message.ID, "C2")
	first, err := e.engine.CombineBranches(e.ctx, scopeA, main.ID, tangent.CombineInput{LineIDs: []string{a.Line.ID, b.Line.ID}, Purpose: "N1"})
	if err != nil || len(first.Reparented) != 2 {
		t.Fatalf("first = %+v %v", first, err)
	}
	n1 := first.Created.Line.ID
	again := tangent.CombineInput{LineIDs: []string{c1.Line.ID, c2.Line.ID}, Purpose: "C"}
	_, err = e.engine.CombineBranches(e.ctx, scopeA, n1, again)
	wantCode(t, err, domain.CodeAnchorNotFound)
	if !strings.Contains(err.Error(), "finished message") {
		t.Fatalf("the error says why: %v", err)
	}
	reply := e.turn(n1, "on N1", "reply on N1")
	second, err := e.engine.CombineBranches(e.ctx, scopeA, n1, again)
	if err != nil || second.Created.Branch.AnchorMessageID != reply.Message.ID || second.Created.Branch.ParentLineID != n1 {
		t.Fatalf("second = %+v %v", second, err)
	}
}

func TestR8_E2_ADetachPublishesTheGroupsItDissolves(t *testing.T) {
	e := newEnvWith(t, groupFeatures(tangent.ModeManual))
	e.engine.SetJobDispatcher(&recordingDispatcher{})
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	parent := e.branch(main.ID, anchor.Message.ID, "parent")
	reply := e.turn(parent.Line.ID, "in", "out")
	x, y := e.endedWithLeaf(parent.Line.ID, reply.Message.ID, "X", "x"), e.endedWithLeaf(parent.Line.ID, reply.Message.ID, "Y", "y")
	created, _ := e.engine.CreateGroup(e.ctx, scopeA, main.ID, tangent.GroupInput{MemberLineIDs: []string{x, y}, Title: "XY"})
	e.events.Reset()
	if _, err := e.engine.Spinoff(e.ctx, scopeA, parent.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach}); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ev := range e.events.OfType(tangent.EventGroupChanged) {
		g := ev.Data.(tangent.GroupChange).Group
		found = found || (g.ID == created.Group.ID && g.Status == domain.GroupDissolved && ev.RootLineID == main.ID)
	}
	if !found {
		t.Fatalf("group.changed for the dissolved group: %v", e.events.Types())
	}
}

func TestR8_E2_ATimedOutSummaryOfADissolvedGroupChangesNothing(t *testing.T) {
	e, _ := groupEnv(t, tangent.ModeManual)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	x, y := e.endedWithLeaf(main.ID, anchor.Message.ID, "X", "x"), e.endedWithLeaf(main.ID, anchor.Message.ID, "Y", "y")
	created, _ := e.engine.CreateGroup(e.ctx, scopeA, main.ID, tangent.GroupInput{MemberLineIDs: []string{x, y}, Title: "XY"})
	e.engine.DissolveGroup(e.ctx, scopeA, created.Group.ID)
	e.exec(`UPDATE tangent_job SET created_at = now() - interval '1 hour' WHERE id = $1`, created.Job.ID)
	e.events.Reset()
	if _, err := e.engine.FailStaleJobs(e.ctx); err != nil {
		t.Fatal(err)
	}
	if got := e.events.OfType(tangent.EventGroupChanged); len(got) != 0 {
		t.Fatalf("no group.changed for a dissolved group: %v", e.events.Types())
	}
	if got := e.events.OfType(tangent.EventJobFailed); len(got) != 1 {
		t.Fatalf("the job itself still failed: %v", e.events.Types())
	}
	if group, _ := e.engine.GetGroup(e.ctx, scopeA, created.Group.ID); group.SummaryStatus != domain.GroupSummaryDrafting {
		t.Fatalf("group = %+v", group)
	}
}
