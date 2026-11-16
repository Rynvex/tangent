package store_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestMessages_InsertValidatesTheShape(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	cases := map[string]store.NewMessage{
		"unknown role":       {Role: "agent", Content: "x"},
		"unknown kind":       {Role: domain.RoleSystem, Kind: "note", Content: "x"},
		"card from the user": {Role: domain.RoleUser, Kind: domain.MessageKindBranchCard, Content: "x"},
		"unknown status":     {Role: domain.RoleUser, Status: "queued", Content: "x"},
		"host data array":    {Role: domain.RoleUser, Content: "x", HostMeta: json.RawMessage(`[]`)},
	}
	for name, message := range cases {
		if _, err := f.store.InsertMessage(f.ctx, tenant, line.ID, message); domain.CodeOf(err) != domain.CodeInvalidInput {
			t.Errorf("%s = %v", name, err)
		}
	}
	if _, err := f.store.InsertMessage(f.ctx, otherTenant, line.ID, store.NewMessage{Role: domain.RoleUser}); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant = %v", err)
	}
	if _, err := f.store.GetMessage(f.ctx, tenant, line.ID, "nope"); !errors.Is(err, domain.ErrMessageNotFound) {
		t.Fatalf("bad message id = %v", err)
	}
	if got := len(f.texts(line.ID)); got != 2 {
		t.Fatalf("a refused message was stored: %d", got)
	}
	if f.store.Limits().Branch.MaxOpenPerParent != domain.DefaultLimits().Branch.MaxOpenPerParent {
		t.Fatal("the store reports the limits it applies")
	}
}

// Ordering within a line is by seq only: moved and promoted messages keep
// their seq, and a misleading clock changes nothing.
func TestSeqOrdering_SurvivesMoveAndPromoteWhateverTheClockSays(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	f.exchange(root.ID, "tail q", "tail a")
	alt := f.branch(root.ID, anchor.ID)
	f.exchange(alt.ID, "alt q", "alt a")
	// The branch's messages claim to be older than everything on the main line.
	f.exec(`UPDATE tangent_message SET created_at = now() - interval '30 days' WHERE line_id = $1`, alt.ID)
	f.exec(`UPDATE tangent_message SET created_at = now() + interval '30 days' WHERE line_id = $1 AND id = $2`, root.ID, anchor.ID)

	out, err := f.store.PromoteBranch(f.ctx, tenant, alt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.texts(root.ID), "|"); got != "question|answer|alt q|alt a" {
		t.Fatalf("main line after the promotion = %q", got)
	}
	recent, _ := f.store.RecentMessages(f.ctx, tenant, root.ID, 2)
	if len(recent) != 2 || recent[0].Content != "alt q" || recent[1].Content != "alt a" {
		t.Fatalf("recent = %+v", recent)
	}
	if tip := f.parentTip(root.ID); tip != recent[1].ID {
		t.Fatalf("the tip is the newest by seq: %s", tip)
	}
	if got := strings.Join(f.texts(out.PreviousID), "|"); got != "tail q|tail a" {
		t.Fatalf("previous main line = %q", got)
	}

	f.exchange(root.ID, "more q", "more a")
	moved := f.move(root.ID, 2)
	if got := strings.Join(f.texts(root.ID), "|"); got != "question|answer|alt q|alt a|2 message(s) moved to a branch: dig into the cap" {
		t.Fatalf("main line after the move = %q", got)
	}
	if got := strings.Join(f.texts(moved.Line.ID), "|"); got != "more q|more a" {
		t.Fatalf("moved branch = %q", got)
	}
	after, _ := f.store.ListMessages(f.ctx, tenant, root.ID, recent[1].Seq, 10)
	if len(after) != 1 || after[0].Kind != domain.MessageKindBranchMarker {
		t.Fatalf("the seq cursor after the move = %+v", after)
	}
}

func TestMerge_AFailingHookLeavesNoCard(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	boom := errors.New("queue unavailable")
	if _, err := f.store.MergeBranch(f.ctx, f.mergeInput(branch.ID, f.parentTip(parent.ID)), failingHook(boom)); !errors.Is(err, boom) {
		t.Fatalf("merge with a failing hook = %v", err)
	}
	if f.cardsIn(parent.ID) != 0 || f.branchView(branch.ID).Status != domain.BranchStatusOpen {
		t.Fatal("a failed hook must roll the merge back")
	}
}

func TestDeleteTree_LocksAWideTree(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	var ids []string
	for range 4 {
		branch := f.branch(root.ID, anchor.ID)
		nested := f.branch(branch.ID, f.reply(branch.ID).ID)
		ids = append(ids, branch.ID, nested.ID)
	}
	deleted, err := f.store.DeleteTree(f.ctx, tenant, root.ID)
	if err != nil || len(deleted.LineIDs) != 9 || len(deleted.LineHostMeta) != 9 {
		t.Fatalf("deleted = %+v err=%v", deleted, err)
	}
	for _, id := range ids {
		if _, err := f.store.GetLine(f.ctx, tenant, id); !errors.Is(err, domain.ErrLineNotFound) {
			t.Fatalf("line %s survived: %v", id, err)
		}
	}
}
