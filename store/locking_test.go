package store_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// A held line lock must not block rows that merely reference the line: a
// foreign-key check takes KEY SHARE, which FOR NO KEY UPDATE allows. Under
// FOR UPDATE this wait closed a deadlock cycle (summary on a branch → cut
// referencing the root, merge holding the root → waiting for the branch).
func TestLocking_ALineLockDoesNotBlockRowsThatReferenceIt(t *testing.T) {
	f := newFixture(t)
	root, branch := f.openBranch()
	branchMsg := f.reply(branch.ID)
	locked, release := make(chan struct{}), make(chan struct{})
	holding := func(context.Context, store.Tx, any) error {
		close(locked)
		<-release
		return nil
	}
	done := make(chan error, 1)
	go func() {
		title := "held"
		_, err := f.store.UpdateLine(f.ctx, tenant, root.ID, store.LinePatch{Title: &title}, holding)
		done <- err
	}()
	<-locked
	// The root is locked by UpdateLine; a cut on the branch references it.
	ctx, cancel := context.WithTimeout(f.ctx, 2*time.Second)
	defer cancel()
	cut, err := f.store.RecordTopicCut(ctx, tenant, branch.ID, branchMsg.ID, "topic")
	close(release)
	if err != nil || cut.Cut == nil {
		t.Fatalf("a topic cut waited on the root's lock: %+v err=%v", cut, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// The reproduced deadlock: summaries (with topic cuts) on branches racing
// merges of the same branches, plus milestones and cuts on the tree. Every
// write must succeed or refuse cleanly; none may fail on a deadlock.
func TestLocking_SummariesMergesAndCutsDoNotDeadlock(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	const branches = 6
	var wg sync.WaitGroup
	errs := make(chan error, branches*4)
	for i := range branches {
		branch := f.branch(root.ID, anchor.ID)
		reply := f.exchange(branch.ID, fmt.Sprintf("q%d", i), fmt.Sprintf("a%d", i))
		tip := f.parentTip(root.ID)
		wg.Add(4)
		go func() {
			defer wg.Done()
			_, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: branch.ID, Summary: domain.Summary{Topic: fmt.Sprintf("topic %d", i)}, UptoSeq: reply.Seq})
			errs <- err
		}()
		go func() {
			defer wg.Done()
			in := f.mergeInput(branch.ID, tip)
			in.ConfirmParentMoved = true
			_, err := f.store.MergeBranch(f.ctx, in)
			errs <- err
		}()
		go func() {
			defer wg.Done()
			_, err := f.store.RecordTopicCut(f.ctx, tenant, branch.ID, reply.ID, "cut")
			errs <- err
		}()
		go func() {
			defer wg.Done()
			_, err := f.store.AddMilestone(f.ctx, store.MilestoneInput{Tenant: tenant, LineID: root.ID, MessageID: reply.ID, Title: "m"})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil && !errors.Is(err, domain.ErrChapterMilestoneExists) {
			t.Fatalf("a concurrent write failed: %v", err)
		}
	}
	if got := f.cardsIn(root.ID); got != branches {
		t.Fatalf("cards = %d", got)
	}
}

// InsertMessage and CreateJob lock their line now that foreign-key checks no
// longer serialise them against line writers: concurrent supersedes leave
// exactly one pending job, and messages racing a discard never land in a
// closed branch.
func TestLocking_CreateJobSupersedeIsAtomic(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: store.JobKindSummary, LineID: line.ID, Supersede: true}); err != nil {
				t.Errorf("create job: %v", err)
			}
		}()
	}
	wg.Wait()
	if got := f.count(`SELECT count(*) FROM tangent_job WHERE line_id = $1 AND status = 'pending'`, line.ID); got != 1 {
		t.Fatalf("pending jobs = %d, want 1", got)
	}
}

func TestLocking_MessagesRacingADiscardNeverLandInAClosedBranch(t *testing.T) {
	f := newFixture(t)
	_, branch := f.openBranch()
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.store.InsertMessage(f.ctx, tenant, branch.ID, store.NewMessage{Role: domain.RoleSystem, Content: fmt.Sprintf("note %d", i)})
			if err != nil && !errors.Is(err, domain.ErrBranchClosed) {
				t.Errorf("insert: %v", err)
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		if _, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID); err != nil {
			t.Errorf("discard: %v", err)
		}
	}()
	wg.Wait()
	after := f.count(`SELECT count(*) FROM tangent_message m JOIN tangent_branch b ON b.line_id = m.line_id
		WHERE m.line_id = $1 AND m.created_at > b.closed_at`, branch.ID)
	if after != 0 {
		t.Fatalf("%d message(s) landed after the discard", after)
	}
}
