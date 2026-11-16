package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func (f *fixture) putGoal(lineID, text string, mutate ...func(*store.PutGoalInput)) (domain.Goal, error) {
	f.t.Helper()
	in := store.PutGoalInput{Tenant: tenant, LineID: lineID, Text: text, Source: domain.GoalSourceManual, Actor: "chang"}
	for _, m := range mutate {
		m(&in)
	}
	write, err := f.store.PutGoal(f.ctx, in)
	return write.Goal, err
}

func TestGoal_PutGetDeleteOnTheConversation(t *testing.T) {
	f := newFixture(t)
	main, _, branch := f.treeWithBranch()
	if goal, err := f.store.GetGoal(f.ctx, tenant, main.ID); err != nil || goal != nil {
		t.Fatalf("no goal yet: %+v %v", goal, err)
	}
	goal, err := f.putGoal(branch.ID, "  Plan a\nKyoto trip ")
	if err != nil || goal.RootLineID != main.ID || goal.Text != "Plan a Kyoto trip" || goal.Source != domain.GoalSourceManual || goal.UpdatedBy != "chang" {
		t.Fatalf("a branch writes its conversation's goal: %+v %v", goal, err)
	}
	again, err := f.putGoal(main.ID, "Pick a ryokan", func(in *store.PutGoalInput) { in.Source = domain.GoalSourceAI })
	if err != nil || again.Text != "Pick a ryokan" || again.Source != domain.GoalSourceAI || !again.CreatedAt.Equal(goal.CreatedAt) {
		t.Fatalf("the goal is replaced: %+v %v", again, err)
	}
	read, err := f.store.GetGoal(f.ctx, tenant, branch.ID)
	if err != nil || read == nil || read.Text != "Pick a ryokan" {
		t.Fatalf("read through the branch: %+v %v", read, err)
	}
	if deleted, err := f.store.DeleteGoal(f.ctx, tenant, main.ID); err != nil || deleted.Text != "Pick a ryokan" {
		t.Fatalf("deleted = %+v %v", deleted, err)
	}
	if _, err := f.store.DeleteGoal(f.ctx, tenant, main.ID); !errors.Is(err, domain.ErrGoalNotFound) {
		t.Fatalf("nothing to delete: %v", err)
	}
}

func TestGoal_RefusalsAndKeepExisting(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	if _, err := f.putGoal(main.ID, " "); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("an empty goal: %v", err)
	}
	if _, err := f.putGoal(main.ID, strings.Repeat("g", 301)); domain.CodeOf(err) != domain.CodeTooLong {
		t.Fatalf("a long goal: %v", err)
	}
	if _, err := f.putGoal(main.ID, "x", func(in *store.PutGoalInput) { in.Source = "robot" }); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("an unknown source: %v", err)
	}
	if _, err := f.putGoal(main.ID, "x", func(in *store.PutGoalInput) { in.Tenant = otherTenant }); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
	if _, err := f.store.GetGoal(f.ctx, otherTenant, main.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant reads nothing: %v", err)
	}
	f.putGoal(main.ID, "the operator's")
	write, err := f.store.PutGoal(f.ctx, store.PutGoalInput{Tenant: tenant, LineID: main.ID, Text: "the model's", Source: domain.GoalSourceAI, KeepExisting: true})
	if err != nil || write.Written || write.Goal.Text != "the operator's" {
		t.Fatalf("keep existing: %+v %v", write, err)
	}
	hookErr := errors.New("no")
	failing := func(context.Context, store.Tx, any) error { return hookErr }
	if _, err := f.store.PutGoal(f.ctx, store.PutGoalInput{Tenant: tenant, LineID: main.ID, Text: "rolled back", Source: domain.GoalSourceManual}, failing); !errors.Is(err, hookErr) {
		t.Fatalf("hook: %v", err)
	}
	if _, err := f.store.DeleteGoal(f.ctx, tenant, main.ID, failing); !errors.Is(err, hookErr) {
		t.Fatalf("hook: %v", err)
	}
	if goal, _ := f.store.GetGoal(f.ctx, tenant, main.ID); goal.Text != "the operator's" {
		t.Fatalf("rolled back: %+v", goal)
	}
	f.exec(`UPDATE tangent_line SET archived_at = now() WHERE id = $1`, main.ID)
	if _, err := f.putGoal(main.ID, "y"); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("archived: %v", err)
	}
	if _, err := f.store.DeleteGoal(f.ctx, tenant, main.ID); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("archived: %v", err)
	}
}

// treeWithBranch is a main line, its reply and an open branch with an exchange.
func (f *fixture) treeWithBranch() (domain.LineView, domain.Message, domain.LineView) {
	f.t.Helper()
	main, anchor := f.mainLine()
	branch := f.branch(main.ID, anchor.ID)
	f.reply(branch.ID)
	return main, anchor, branch
}

func TestPin_PinsAndUnpinsAFinishedMessage(t *testing.T) {
	f := newFixture(t)
	main, reply := f.mainLine()
	pinned, err := f.store.PinMessage(f.ctx, tenant, reply.ID, true)
	if err != nil || !pinned.Message.Pinned || !pinned.Changed || pinned.RootLineID != main.ID {
		t.Fatalf("pinned = %+v %v", pinned, err)
	}
	if again, err := f.store.PinMessage(f.ctx, tenant, reply.ID, true); err != nil || again.Changed {
		t.Fatalf("pinning twice changes nothing: %+v %v", again, err)
	}
	messages, _ := f.store.ListMessages(f.ctx, tenant, main.ID, 0, 10)
	if !messages[1].Pinned || messages[0].Pinned {
		t.Fatalf("the transcript shows the pin: %+v", messages)
	}
	if unpinned, err := f.store.PinMessage(f.ctx, tenant, reply.ID, false); err != nil || unpinned.Message.Pinned || !unpinned.Changed {
		t.Fatalf("unpinned = %+v %v", unpinned, err)
	}
	card := f.card(main.ID)
	if _, err := f.store.PinMessage(f.ctx, tenant, card.ID, true); err != nil {
		t.Fatalf("a card can be pinned: %v", err)
	}
}

func TestPin_Refusals(t *testing.T) {
	f := newFixture(t)
	main, reply := f.mainLine()
	turn := f.busy(main.ID)
	if _, err := f.store.PinMessage(f.ctx, tenant, turn.Pending.ID, true); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("a pending message: %v", err)
	}
	marker := f.message(main.ID, domain.RoleSystem, "a marker")
	if _, err := f.store.PinMessage(f.ctx, tenant, marker.ID, true); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("a system message: %v", err)
	}
	for _, id := range []string{"nope", "00000000-0000-4000-8000-0000000000aa"} {
		if _, err := f.store.PinMessage(f.ctx, tenant, id, true); !errors.Is(err, domain.ErrMessageNotFound) {
			t.Fatalf("%s: %v", id, err)
		}
	}
	if _, err := f.store.PinMessage(f.ctx, otherTenant, reply.ID, true); !errors.Is(err, domain.ErrMessageNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
	hookErr := errors.New("no")
	if _, err := f.store.PinMessage(f.ctx, tenant, reply.ID, true, func(context.Context, store.Tx, any) error { return hookErr }); !errors.Is(err, hookErr) {
		t.Fatalf("hook: %v", err)
	}
	if f.count(`SELECT count(*) FROM tangent_message WHERE pinned`) != 0 {
		t.Fatal("the hook rolled the pin back")
	}
	f.exec(`UPDATE tangent_line SET archived_at = now() WHERE id = $1`, main.ID)
	if _, err := f.store.PinMessage(f.ctx, tenant, reply.ID, true); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("archived: %v", err)
	}
}

func TestPin_FollowsAMessageThatMoved(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	f.exchange(main.ID, "move me", "moved")
	moved := f.move(main.ID, 2)
	messages, _ := f.store.ListMessages(f.ctx, tenant, moved.Line.ID, 0, 10)
	pinned, err := f.store.PinMessage(f.ctx, tenant, messages[1].ID, true)
	if err != nil || pinned.Message.LineID != moved.Line.ID || pinned.RootLineID != main.ID {
		t.Fatalf("pinned on the branch it moved to: %+v %v", pinned, err)
	}
}

func TestSuggestions_AnAskedProposalIgnoresAnEarlierDismissal(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	first := f.propose(main.ID, "goal", func(in *store.ProposeInput) { in.Permanent = true })
	if _, err := f.store.DecideSuggestion(f.ctx, tenant, first.Suggestion.ID, domain.SuggestionDismissed); err != nil {
		t.Fatal(err)
	}
	if blocked := f.propose(main.ID, "goal", func(in *store.ProposeInput) { in.Permanent = true }); blocked.Created {
		t.Fatal("dismissed for good")
	}
	asked := f.propose(main.ID, "goal", func(in *store.ProposeInput) { in.Permanent, in.Asked = true, true })
	if !asked.Created {
		t.Fatal("the operator asked for it")
	}
	if _, err := f.store.ReplyCount(f.ctx, "nope"); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("reply count of a bad id: %v", err)
	}
	if goal, err := f.store.GoalOfRoot(f.ctx, "nope"); goal != nil || err != nil {
		t.Fatalf("goal of a bad id: %+v %v", goal, err)
	}
}
