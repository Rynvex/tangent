package store_test

import (
	"errors"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestP2Concurrency_GoalWritesLeaveOneGoal(t *testing.T) {
	f := newFixture(t)
	main, _, branch := f.treeWithBranch()
	writes := []func() error{}
	for i, line := range []string{main.ID, branch.ID, main.ID, branch.ID, main.ID, branch.ID} {
		writes = append(writes, func() error {
			_, err := f.putGoal(line, "goal "+string(rune('a'+i)))
			return err
		})
	}
	writes = append(writes, func() error {
		_, err := f.store.DeleteGoal(f.ctx, tenant, main.ID)
		if errors.Is(err, domain.ErrGoalNotFound) {
			return nil
		}
		return err
	})
	for _, err := range race(writes...) {
		if err != nil {
			t.Fatalf("unexpected: %v", err)
		}
	}
	if n := f.count(`SELECT count(*) FROM tangent_goal WHERE root_line_id = $1`, main.ID); n > 1 {
		t.Fatalf("goals = %d", n)
	}
}

func TestP2Concurrency_APinFollowsAMessageMovedMeanwhile(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	for range 5 {
		f.message(main.ID, domain.RoleUser, "move me")
		last := f.message(main.ID, domain.RoleAssistant, "moved")
		var moved store.MovedBranch
		errs := race(
			func() error {
				var err error
				moved, err = f.store.MoveToBranch(f.ctx, f.moveInput(main.ID, 2))
				return err
			},
			func() error { _, err := f.store.PinMessage(f.ctx, tenant, last.ID, true); return err },
		)
		if errs[0] != nil || errs[1] != nil {
			t.Fatalf("errs = %v", errs)
		}
		messages, _ := f.store.ListMessages(f.ctx, tenant, moved.Line.ID, 0, 10)
		if len(messages) != 2 || !messages[1].Pinned {
			t.Fatalf("the moved message keeps its pin: %+v", messages)
		}
		f.reply(main.ID)
	}
}

func TestP2Concurrency_RelationsRacingADeletedTreeNeverDeadlock(t *testing.T) {
	f := newFixture(t)
	for range 5 {
		main, reply := f.mainLine()
		other, _ := f.mainLine()
		errs := race(
			func() error {
				_, err := f.relate(main.ID, store.RelationEnd{LineID: main.ID, MessageID: reply.ID}, store.RelationEnd{LineID: other.ID}, "")
				return err
			},
			func() error { _, err := f.store.DeleteTree(f.ctx, tenant, other.ID); return err },
			func() error {
				_, err := f.relate(other.ID, store.RelationEnd{LineID: other.ID}, store.RelationEnd{LineID: main.ID}, "")
				return err
			},
		)
		if errs[1] != nil {
			t.Fatalf("delete: %v", errs[1])
		}
		for _, err := range []error{errs[0], errs[2]} {
			if err != nil && !errors.Is(err, domain.ErrLineNotFound) && !errors.Is(err, domain.ErrRelationExists) {
				t.Fatalf("unexpected: %v", err)
			}
		}
		if n := f.count(`SELECT count(*) FROM tangent_link WHERE from_line_id = $1 OR to_line_id = $1`, main.ID); n != 0 {
			t.Fatalf("the deleted tree took its relations along: %d", n)
		}
	}
}
