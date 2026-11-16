package tangent_test

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

func leafChanges(e *env) []tangent.LeafChange {
	out := []tangent.LeafChange{}
	for _, ev := range e.events.OfType(tangent.EventLeafChanged) {
		out = append(out, ev.Data.(tangent.LeafChange))
	}
	return out
}

func TestLeaf_AFailedDraftIsPublishedAndReadable(t *testing.T) {
	e := newEnvWith(t, p1Features())
	_, branch := e.branchWithTurn("osaka")
	job, err := e.engine.StartLeafDraft(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, job.ID, "", errors.New("down")); err != nil {
		t.Fatal(err)
	}
	changes := leafChanges(e)
	if len(changes) != 1 || changes[0].Leaf != nil || changes[0].DraftError == nil || changes[0].DraftError.Code != domain.LeafDraftErrorRunFailed {
		t.Fatalf("changes = %+v", changes)
	}
	state, err := e.engine.GetLeafState(e.ctx, scopeA, branch.Line.ID)
	if err != nil || state.Leaf != nil || state.DraftError == nil || state.DraftError.Code != domain.LeafDraftErrorRunFailed {
		t.Fatalf("state = %+v %v", state, err)
	}
	if _, err := e.engine.PutLeaf(e.ctx, scopeA, branch.Line.ID, domain.LeafInput{Kind: "answer", Line: "mine"}); err != nil {
		t.Fatal(err)
	}
	if state, _ := e.engine.GetLeafState(e.ctx, scopeA, branch.Line.ID); state.DraftError != nil || state.Leaf == nil {
		t.Fatalf("a newer leaf clears the error: %+v", state)
	}
	unusable, _ := e.engine.StartLeafDraft(e.ctx, scopeA, branch.Line.ID)
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, unusable.ID, "no marker", nil); err != nil {
		t.Fatal(err)
	}
	if changes := leafChanges(e); len(changes) != 1 || changes[0].Leaf == nil || changes[0].Leaf.Line != "mine" || changes[0].DraftError.Code != domain.LeafDraftErrorUnusable {
		t.Fatalf("the current leaf with the error: %+v", changes)
	}
	if state, _ := e.engine.GetLeafState(e.ctx, scopeA, branch.Line.ID); state.DraftError == nil || state.DraftError.Code != domain.LeafDraftErrorUnusable {
		t.Fatalf("state = %+v", state)
	}
	pending, _ := e.engine.StartLeafDraft(e.ctx, scopeA, branch.Line.ID)
	if state, _ := e.engine.GetLeafState(e.ctx, scopeA, branch.Line.ID); state.DraftError != nil {
		t.Fatalf("a draft running again clears the error (%s): %+v", pending.ID, state)
	}
}

func TestLeaf_ATimedOutDraftIsPublished(t *testing.T) {
	clock := &movingClock{now: time.Now()}
	e := newEnvWith(t, p1Features(), tangent.WithClock(clock.Now))
	_, branch := e.branchWithTurn("osaka")
	if _, err := e.engine.StartLeafDraft(e.ctx, scopeA, branch.Line.ID); err != nil {
		t.Fatal(err)
	}
	clock.add(10 * time.Minute)
	e.events.Reset()
	if _, err := e.engine.FailStaleJobs(e.ctx); err != nil {
		t.Fatal(err)
	}
	if changes := leafChanges(e); len(changes) != 1 || changes[0].DraftError == nil || changes[0].DraftError.Code != domain.LeafDraftErrorTimedOut {
		t.Fatalf("changes = %+v", changes)
	}
	_, err := e.engine.GetLeafState(e.ctx, scopeA, e.mainLine().ID)
	wantCode(t, err, domain.CodeBranchNotFound)
}

// movingClock is a clock tests move forward.
type movingClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *movingClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *movingClock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}
