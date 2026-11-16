package store_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func (f *fixture) relate(lineID string, from, to store.RelationEnd, label string) (store.RelationChange, error) {
	f.t.Helper()
	return f.store.CreateRelation(f.ctx, store.CreateRelationInput{Tenant: tenant, LineID: lineID, From: from, To: to, Label: label, Actor: "chang"})
}

func (f *fixture) relations(lineID string) []domain.Link {
	f.t.Helper()
	links, err := f.store.ListLinks(f.ctx, tenant, lineID, []string{domain.LinkKindRelation})
	if err != nil {
		f.t.Fatal(err)
	}
	return links
}

func TestRelations_LinesAndMessagesOfOneTree(t *testing.T) {
	f := newFixture(t)
	main, anchor, branch := f.treeWithBranch()
	other := f.branch(main.ID, anchor.ID)
	created, err := f.relate(main.ID, store.RelationEnd{LineID: branch.ID}, store.RelationEnd{LineID: other.ID}, "  same\nquestion ")
	link := created.Link
	if err != nil || link.Kind != domain.LinkKindRelation || link.FromLineID != branch.ID || link.ToLineID != other.ID || link.Label != "same question" ||
		link.CreatedBy != "chang" || !slices.Equal(created.RootLineIDs, []string{main.ID}) {
		t.Fatalf("created = %+v %v", created, err)
	}
	withMessage, err := f.relate(branch.ID, store.RelationEnd{LineID: main.ID, MessageID: anchor.ID}, store.RelationEnd{LineID: branch.ID}, "")
	if err != nil || withMessage.Link.FromMessageID != anchor.ID || withMessage.Link.FromTitle != "main" {
		t.Fatalf("a message end: %+v %v", withMessage, err)
	}
	listed := f.relations(other.ID)
	if len(listed) != 2 || listed[0].ID != withMessage.Link.ID {
		t.Fatalf("the tree's relations, newest first: %+v", listed)
	}
	links, _ := f.store.ListLinks(f.ctx, tenant, main.ID, []string{domain.LinkKindSpinoff})
	if len(links) != 0 {
		t.Fatalf("only the kinds asked for: %+v", links)
	}
	if _, err := f.relate(main.ID, store.RelationEnd{LineID: other.ID}, store.RelationEnd{LineID: branch.ID}, "reverse"); !errors.Is(err, domain.ErrRelationExists) {
		t.Fatalf("the same two places in either direction: %v", err)
	}
	deleted, err := f.store.DeleteRelation(f.ctx, tenant, other.ID, link.ID)
	if err != nil || deleted.Link.ID != link.ID || !slices.Equal(deleted.RootLineIDs, []string{main.ID}) {
		t.Fatalf("deleted = %+v %v", deleted, err)
	}
	if _, err := f.store.DeleteRelation(f.ctx, tenant, main.ID, link.ID); !errors.Is(err, domain.ErrRelationNotFound) {
		t.Fatalf("deleted twice: %v", err)
	}
}

func TestRelations_Refusals(t *testing.T) {
	f := newFixture(t)
	main, anchor, branch := f.treeWithBranch()
	cases := []struct {
		name     string
		lineID   string
		from, to store.RelationEnd
		label    string
		want     string
	}{
		{"same place", main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: main.ID}, "", domain.CodeInvalidInput},
		{"same message", main.ID, store.RelationEnd{LineID: main.ID, MessageID: anchor.ID}, store.RelationEnd{LineID: main.ID, MessageID: anchor.ID}, "", domain.CodeInvalidInput},
		{"no target", main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{}, "", domain.CodeLineNotFound},
		{"unknown line", main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: "00000000-0000-4000-8000-0000000000aa"}, "", domain.CodeLineNotFound},
		{"message elsewhere", main.ID, store.RelationEnd{LineID: branch.ID, MessageID: anchor.ID}, store.RelationEnd{LineID: main.ID}, "", domain.CodeMessageNotFound},
		{"bad message id", main.ID, store.RelationEnd{LineID: main.ID, MessageID: "x"}, store.RelationEnd{LineID: branch.ID}, "", domain.CodeMessageNotFound},
		{"long label", main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: branch.ID}, strings.Repeat("l", 201), domain.CodeTooLong},
	}
	for _, c := range cases {
		if _, err := f.relate(c.lineID, c.from, c.to, c.label); domain.CodeOf(err) != c.want {
			t.Errorf("%s: %v, want %s", c.name, err, c.want)
		}
	}
	lonely, _ := f.mainLine()
	if _, err := f.relate(lonely.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: branch.ID}, ""); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("the from end must be in the path's conversation: %v", err)
	}
	pending := f.busy(main.ID)
	if _, err := f.relate(main.ID, store.RelationEnd{LineID: main.ID, MessageID: pending.Pending.ID}, store.RelationEnd{LineID: branch.ID}, ""); !errors.Is(err, domain.ErrMessageNotFound) {
		t.Fatalf("a pending message is no end: %v", err)
	}
	theirs, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: otherTenant, Title: "theirs"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.relate(main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: theirs.ID}, ""); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant's line: %v", err)
	}
	if _, err := f.store.ListLinks(f.ctx, otherTenant, main.ID, []string{domain.LinkKindRelation}); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant lists nothing: %v", err)
	}
	hookErr := errors.New("no")
	_, err = f.store.CreateRelation(f.ctx, store.CreateRelationInput{Tenant: tenant, LineID: main.ID, From: store.RelationEnd{LineID: main.ID}, To: store.RelationEnd{LineID: branch.ID}},
		func(context.Context, store.Tx, any) error { return hookErr })
	if !errors.Is(err, hookErr) || len(f.relations(main.ID)) != 0 {
		t.Fatalf("hook: %v", err)
	}
}

func TestRelations_AcrossTreesOfOneTenant(t *testing.T) {
	f := newFixture(t)
	main, reply := f.mainLine()
	other, otherReply := f.mainLine()
	created, err := f.relate(main.ID, store.RelationEnd{LineID: main.ID, MessageID: reply.ID}, store.RelationEnd{LineID: other.ID, MessageID: otherReply.ID}, "see also")
	if err != nil || len(created.RootLineIDs) != 2 || !slices.Contains(created.RootLineIDs, other.ID) {
		t.Fatalf("created = %+v %v", created, err)
	}
	if len(f.relations(other.ID)) != 1 || len(f.relations(main.ID)) != 1 {
		t.Fatal("both conversations list it")
	}
	if _, err := f.store.DeleteRelation(f.ctx, tenant, other.ID, created.Link.ID); err != nil {
		t.Fatalf("either conversation deletes it: %v", err)
	}
	third, _ := f.mainLine()
	again, _ := f.relate(main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: other.ID}, "")
	if _, err := f.store.DeleteRelation(f.ctx, tenant, third.ID, again.Link.ID); !errors.Is(err, domain.ErrRelationNotFound) {
		t.Fatalf("an unrelated conversation: %v", err)
	}
	if _, err := f.store.DeleteRelation(f.ctx, otherTenant, main.ID, again.Link.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
	f.exec(`UPDATE tangent_line SET archived_at = now() WHERE id = $1`, other.ID)
	if _, err := f.relate(main.ID, store.RelationEnd{LineID: main.ID, MessageID: reply.ID}, store.RelationEnd{LineID: other.ID}, ""); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("an archived conversation: %v", err)
	}
	if _, err := f.store.DeleteRelation(f.ctx, tenant, other.ID, again.Link.ID); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("from the archived end: %v", err)
	}
	if _, err := f.store.UpdateRelationLabel(f.ctx, tenant, main.ID, again.Link.ID, "x"); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("a label change still needs both ends writable: %v", err)
	}
	if _, err := f.store.DeleteRelation(f.ctx, tenant, main.ID, again.Link.ID); err != nil {
		t.Fatalf("R8 E6: the caller's end is enough to delete: %v", err)
	}
}

func TestRelations_TheTreeLimitCountsBothTrees(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Relations.MaxPerTree = 2
	f := newFixtureWithLimits(t, limits)
	main, anchor, branch := f.treeWithBranch()
	other, _ := f.mainLine()
	f.relate(main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: branch.ID}, "")
	f.relate(main.ID, store.RelationEnd{LineID: main.ID, MessageID: anchor.ID}, store.RelationEnd{LineID: branch.ID}, "")
	if _, err := f.relate(main.ID, store.RelationEnd{LineID: branch.ID}, store.RelationEnd{LineID: other.ID}, ""); !errors.Is(err, domain.ErrRelationLimit) {
		t.Fatalf("the from tree is full: %v", err)
	}
	if _, err := f.relate(other.ID, store.RelationEnd{LineID: other.ID}, store.RelationEnd{LineID: main.ID}, ""); !errors.Is(err, domain.ErrRelationLimit) {
		t.Fatalf("the to tree is full: %v", err)
	}
	if e := domain.AsError(domain.ErrRelationLimit, limits); e.Extra["limit"] != 2 {
		t.Fatalf("extra = %v", e.Extra)
	}
}

func TestRelations_ConcurrentCreatesKeepTheLimit(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Relations.MaxPerTree = 3
	f := newFixtureWithLimits(t, limits)
	main, _ := f.mainLine()
	writes := []func() error{}
	for range 6 {
		other, _ := f.mainLine()
		writes = append(writes, func() error {
			_, err := f.relate(main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: other.ID}, "")
			return err
		})
	}
	won := 0
	for _, err := range race(writes...) {
		switch {
		case err == nil:
			won++
		case !errors.Is(err, domain.ErrRelationLimit):
			t.Fatalf("unexpected: %v", err)
		}
	}
	if won != 3 || len(f.relations(main.ID)) != 3 {
		t.Fatalf("%d won", won)
	}
}

func TestRelations_AMessageEndFollowsItsMessage(t *testing.T) {
	f := newFixture(t)
	main, anchor, branch := f.treeWithBranch()
	question := f.message(main.ID, domain.RoleUser, "move me")
	f.message(main.ID, domain.RoleAssistant, "moved")
	created, _ := f.relate(main.ID, store.RelationEnd{LineID: main.ID, MessageID: question.ID}, store.RelationEnd{LineID: branch.ID}, "")
	moved := f.move(main.ID, 2)
	listed := f.relations(main.ID)
	if len(listed) != 1 || listed[0].FromLineID != moved.Line.ID || listed[0].ID != created.Link.ID {
		t.Fatalf("the end is on the branch the message moved to: %+v", listed)
	}
	spun := f.detach(moved.Line.ID)
	if got := f.relations(spun.Line.ID); len(got) != 1 || got[0].FromLineID != moved.Line.ID {
		t.Fatalf("the new conversation lists it: %+v", got)
	}
	if got := f.relations(main.ID); len(got) != 1 {
		t.Fatalf("the old one still does (its other end): %+v", got)
	}
	_ = anchor
}
