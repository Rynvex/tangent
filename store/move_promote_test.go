package store_test

import (
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func (f *fixture) moveInput(sourceID string, count int) store.MoveToBranchInput {
	return store.MoveToBranchInput{
		CreateBranchInput: store.CreateBranchInput{
			Tenant: tenant, ParentLineID: sourceID, Purpose: "dig into the cap", Kind: domain.BranchKindInvestigate, CreatedBy: "chang",
		},
		Count:     count,
		BuildPack: func(store.MovePackBase) domain.BranchPack { return domain.BranchPack{Rendered: "pack"} },
	}
}

func (f *fixture) move(sourceID string, count int) store.MovedBranch {
	f.t.Helper()
	moved, err := f.store.MoveToBranch(f.ctx, f.moveInput(sourceID, count))
	if err != nil {
		f.t.Fatal(err)
	}
	return moved
}

func (f *fixture) setSummary(lineID string, topic string, uptoSeq int64) {
	f.t.Helper()
	if _, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: lineID, Summary: domain.Summary{Topic: topic}, UptoSeq: uptoSeq}); err != nil {
		f.t.Fatal(err)
	}
}

// seqsAscending reports whether a line's messages come back in seq order.
func (f *fixture) seqsAscending(lineID string) bool {
	f.t.Helper()
	messages, err := f.store.ListMessages(f.ctx, tenant, lineID, 0, 500)
	if err != nil {
		f.t.Fatal(err)
	}
	return slices.IsSortedFunc(messages, func(a, b domain.Message) int { return int(a.Seq - b.Seq) })
}

func TestMove_TailBecomesABranchInOrderAndTheSourceKeepsAMarker(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	f.exchange(root.ID, "and the cap?", "The cap is five.")
	var base store.MovePackBase
	in := f.moveInput(root.ID, 2)
	in.BuildPack = func(b store.MovePackBase) domain.BranchPack { base = b; return domain.BranchPack{Rendered: "pack"} }
	moved, err := f.store.MoveToBranch(f.ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	if moved.Branch.Origin != domain.BranchOriginMove || moved.Branch.Depth != 1 || moved.Branch.AnchorMessageID != anchor.ID ||
		moved.Branch.MessageCount != 2 || moved.SourceLineID != root.ID || moved.RootLineID != root.ID || len(moved.MovedMessageIDs) != 2 {
		t.Fatalf("moved = %+v", moved)
	}
	if base.Anchor.ID != anchor.ID || len(base.Remaining) != 2 || base.Remaining[1].ID != anchor.ID {
		t.Fatalf("pack base = %+v", base)
	}
	if got := strings.Join(f.texts(moved.Line.ID), "|"); got != "and the cap?|The cap is five." {
		t.Fatalf("branch messages = %q", got)
	}
	source := f.texts(root.ID)
	if len(source) != 3 || source[2] != "2 message(s) moved to a branch: dig into the cap" ||
		moved.Marker.Kind != domain.MessageKindBranchMarker || moved.Marker.Meta.BranchLineID != moved.Line.ID {
		t.Fatalf("source messages = %q marker = %+v", source, moved.Marker)
	}
	if !f.seqsAscending(root.ID) || !f.seqsAscending(moved.Line.ID) {
		t.Fatal("messages are not in seq order after the move")
	}
}

func TestMove_SummaryIsResetOnlyWhenItsCursorMoved(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	f.exchange(root.ID, "later question", "later answer")
	f.setSummary(root.ID, "retries", anchor.Seq)
	moved := f.move(root.ID, 2)
	if kept := f.line(root.ID); kept.Summary.Topic != "retries" || kept.SummaryUptoSeq != anchor.Seq || moved.SummaryReset {
		t.Fatalf("a summary covering messages that stay must be kept: %+v", kept)
	}

	g := newFixture(t)
	groot, _ := g.mainLine()
	g.exchange(groot.ID, "later question", "later answer")
	last := g.exchange(groot.ID, "last question", "last answer")
	g.setSummary(groot.ID, "retries", last.Seq)
	job, err := g.store.CreateJob(g.ctx, store.CreateJobInput{Tenant: tenant, Kind: store.JobKindSummary, LineID: groot.ID})
	if err != nil {
		t.Fatal(err)
	}
	reset := g.move(groot.ID, 2)
	if got := g.line(groot.ID); got.Summary.Topic != "" || got.SummaryUptoSeq != 0 || !reset.SummaryReset {
		t.Fatalf("a summary whose cursor moved must be reset: %+v", got)
	}
	if stale, _ := g.store.GetJob(g.ctx, job.ID); stale.Status != store.JobSuperseded {
		t.Fatalf("a pending summary of the source must be superseded: %+v", stale)
	}
}

func TestMove_BranchesOnMovedMessagesGoWithThemOneLevelDeeper(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	later := f.exchange(root.ID, "later question", "later answer")
	onMoved := f.branch(root.ID, later.ID)
	onKept := f.branch(root.ID, anchor.ID)
	moved := f.move(root.ID, 2)
	view := f.branchView(onMoved.ID)
	if view.ParentLineID != moved.Line.ID || view.Depth != 2 || view.RootLineID != root.ID {
		t.Fatalf("branch on a moved message = %+v", view)
	}
	if kept := f.branchView(onKept.ID); kept.ParentLineID != root.ID || kept.Depth != 1 {
		t.Fatalf("branch on a kept message = %+v", kept)
	}
	if len(moved.Reparented) != 1 || moved.Reparented[0] != onMoved.ID {
		t.Fatalf("reparented = %v", moved.Reparented)
	}
}

func TestMove_Refusals(t *testing.T) {
	f := newFixture(t)
	root, _ := f.mainLine()
	f.exchange(root.ID, "second", "second answer")
	cases := []struct {
		name  string
		count int
		code  string
	}{
		{"zero", 0, domain.CodeInvalidCount},
		{"too many", 41, domain.CodeInvalidCount},
		{"more than there are", 39, domain.CodeNotEnoughMessages},
		{"starts with the assistant", 1, domain.CodeMoveMustStartWithUser},
		{"nothing left to hang on", 4, domain.CodeMoveNoAnchor},
	}
	for _, tc := range cases {
		if _, err := f.store.MoveToBranch(f.ctx, f.moveInput(root.ID, tc.count)); domain.CodeOf(err) != tc.code {
			t.Fatalf("%s = %v, want %s", tc.name, err, tc.code)
		}
	}
	noPurpose := f.moveInput(root.ID, 2)
	noPurpose.Purpose = ""
	if _, err := f.store.MoveToBranch(f.ctx, noPurpose); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("no purpose = %v", err)
	}
	if len(f.texts(root.ID)) != 4 {
		t.Fatal("a refused move must change nothing")
	}
	f.card(root.ID)
	if _, err := f.store.MoveToBranch(f.ctx, f.moveInput(root.ID, 3)); !errors.Is(err, domain.ErrBranchMoveProtected) {
		t.Fatalf("card in range = %v", err)
	}

	g := newFixture(t)
	groot, _ := g.mainLine()
	g.exchange(groot.ID, "second", "second answer")
	g.move(groot.ID, 2)
	g.exchange(groot.ID, "third", "third answer")
	if _, err := g.store.MoveToBranch(g.ctx, g.moveInput(groot.ID, 4)); !errors.Is(err, domain.ErrBranchMoveProtected) {
		t.Fatalf("marker in range = %v", err)
	}
	g.busy(groot.ID)
	if _, err := g.store.MoveToBranch(g.ctx, g.moveInput(groot.ID, 2)); !errors.Is(err, domain.ErrBranchSourceBusy) {
		t.Fatalf("move while answering = %v", err)
	}
}

func TestMove_FromABranchAndTenantIsolation(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	branch := f.branch(root.ID, anchor.ID)
	f.exchange(branch.ID, "dig", "found")
	f.exchange(branch.ID, "dig more", "found more")
	moved := f.move(branch.ID, 2)
	if moved.Branch.Depth != 2 || moved.Branch.ParentLineID != branch.ID || moved.Branch.RootLineID != root.ID {
		t.Fatalf("nested move = %+v", moved.Branch)
	}
	in := f.moveInput(root.ID, 2)
	in.Tenant = otherTenant
	if _, err := f.store.MoveToBranch(f.ctx, in); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant = %v", err)
	}
}

func TestPromote_SwapsTheTranscriptsAndKeepsTheMainLineID(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	f.exchange(root.ID, "old tail q", "old tail a")
	in := f.branchInput(root.ID, anchor.ID)
	in.Kind = domain.BranchKindAlternative
	created, err := f.store.CreateBranch(f.ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	alt := created.Line
	f.exchange(alt.ID, "alt q", "alt a")
	f.setSummary(root.ID, "old", anchor.Seq)
	f.setSummary(alt.ID, "alt", 0)
	job, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: store.JobKindSummary, LineID: root.ID})
	if err != nil {
		t.Fatal(err)
	}

	out, err := f.store.PromoteBranch(f.ctx, tenant, alt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.texts(root.ID), "|"); got != "question|answer|alt q|alt a" {
		t.Fatalf("main line = %q", got)
	}
	if got := strings.Join(f.texts(out.PreviousID), "|"); got != "old tail q|old tail a" {
		t.Fatalf("previous main line = %q", got)
	}
	if len(f.texts(alt.ID)) != 0 || out.MainLineID != root.ID || out.PromotedID != alt.ID {
		t.Fatalf("promoted = %+v", out)
	}
	if !f.seqsAscending(root.ID) || !f.seqsAscending(out.PreviousID) {
		t.Fatal("messages are not in seq order after the promotion")
	}
	promoted, previous := f.branchView(alt.ID), f.branchView(out.PreviousID)
	if promoted.Status != domain.BranchStatusPromoted || previous.Status != domain.BranchStatusDiscarded ||
		previous.Origin != domain.BranchOriginPreviousMainLine || previous.ParentLineID != root.ID ||
		previous.AnchorMessageID != anchor.ID || previous.Depth != 1 || previous.Purpose != domain.BranchPreviousMainLinePurpose {
		t.Fatalf("views = %+v / %+v", promoted, previous)
	}
	for _, id := range []string{root.ID, alt.ID} {
		if line := f.line(id); line.Summary.HasContent() || line.SummaryUptoSeq != 0 {
			t.Fatalf("line %s keeps its summary: %+v", id, line.Summary)
		}
	}
	if stale, _ := f.store.GetJob(f.ctx, job.ID); stale.Status != store.JobSuperseded {
		t.Fatalf("a pending summary of the main line must be superseded: %+v", stale)
	}
}

func TestPromote_AnyDirectBranchCanBePromoted(t *testing.T) {
	f := newFixture(t)
	_, branch := f.openBranch()
	if _, err := f.store.PromoteBranch(f.ctx, tenant, branch.ID); err != nil {
		t.Fatalf("an investigation = %v", err)
	}
	if view := f.branchView(branch.ID); view.Kind != domain.BranchKindInvestigate || view.Status != domain.BranchStatusPromoted {
		t.Fatalf("branch = %+v", view)
	}
}

func TestPromote_OpenBranchesOnTheOldTailBlockIt(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	tail := f.exchange(root.ID, "old tail q", "old tail a")
	onTail := f.branch(root.ID, tail.ID)
	alt := f.branch(root.ID, anchor.ID)

	var openTail *domain.BranchOpenTailError
	if _, err := f.store.PromoteBranch(f.ctx, tenant, alt.ID); !errors.As(err, &openTail) || !slices.Contains(openTail.LineIDs, onTail.ID) {
		t.Fatalf("promote with an open branch on the tail = %v", err)
	}
	if len(f.texts(root.ID)) != 4 || f.branchView(alt.ID).Status != domain.BranchStatusOpen {
		t.Fatal("a refused promotion must change nothing")
	}
	if _, err := f.store.DiscardBranch(f.ctx, tenant, onTail.ID); err != nil {
		t.Fatal(err)
	}
	out, err := f.store.PromoteBranch(f.ctx, tenant, alt.ID)
	if err != nil {
		t.Fatal(err)
	}
	moved := f.branchView(onTail.ID)
	if moved.ParentLineID != out.PreviousID || moved.Depth != 2 || moved.RootLineID != root.ID {
		t.Fatalf("a closed branch on the old tail goes below the previous main line: %+v", moved)
	}
}

func TestPromote_BranchesOfThePromotedBranchMoveUp(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	alt := f.branch(root.ID, anchor.ID)
	child := f.branch(alt.ID, f.exchange(alt.ID, "alt q", "alt a").ID)
	grand := f.branch(child.ID, f.exchange(child.ID, "c q", "c a").ID)
	out, err := f.store.PromoteBranch(f.ctx, tenant, alt.ID)
	if err != nil {
		t.Fatal(err)
	}
	lifted, deeper := f.branchView(child.ID), f.branchView(grand.ID)
	if lifted.ParentLineID != root.ID || lifted.Depth != 1 || deeper.ParentLineID != child.ID || deeper.Depth != 2 {
		t.Fatalf("lifted = %+v deeper = %+v", lifted, deeper)
	}
	if len(out.Reparented) != 1 || out.Reparented[0] != child.ID {
		t.Fatalf("reparented = %v", out.Reparented)
	}
}

func TestPromote_Refusals(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	alt := f.branch(root.ID, anchor.ID)
	nested := f.branch(alt.ID, f.reply(alt.ID).ID)
	if _, err := f.store.PromoteBranch(f.ctx, tenant, root.ID); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("a main line is not a branch: %v", err)
	}
	if _, err := f.store.PromoteBranch(f.ctx, tenant, nested.ID); !errors.Is(err, domain.ErrBranchPromoteNotTopLevel) {
		t.Fatalf("nested = %v", err)
	}
	f.busy(alt.ID)
	if _, err := f.store.PromoteBranch(f.ctx, tenant, alt.ID); !errors.Is(err, domain.ErrBranchBusy) {
		t.Fatalf("branch answering = %v", err)
	}

	g := newFixture(t)
	groot, ganchor := g.mainLine()
	galt := g.branch(groot.ID, ganchor.ID)
	g.busy(groot.ID)
	if _, err := g.store.PromoteBranch(g.ctx, tenant, galt.ID); !errors.Is(err, domain.ErrBranchParentBusy) {
		t.Fatalf("main line answering = %v", err)
	}

	h := newFixture(t)
	hroot, hanchor := h.mainLine()
	halt := h.branch(hroot.ID, hanchor.ID)
	if _, err := h.store.DiscardBranch(h.ctx, tenant, halt.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.PromoteBranch(h.ctx, tenant, halt.ID); !errors.Is(err, domain.ErrBranchClosed) {
		t.Fatalf("closed branch = %v", err)
	}
	drafting := h.branch(hroot.ID, hanchor.ID)
	h.reply(drafting.ID)
	if _, err := h.store.ClaimBranchDraft(h.ctx, tenant, drafting.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.PromoteBranch(h.ctx, tenant, drafting.ID); !errors.Is(err, domain.ErrBranchPromoteDrafting) {
		t.Fatalf("drafting branch = %v", err)
	}
}

// Two moves and a promotion race for the same line. The locks serialise them:
// nothing deadlocks, each message lives in exactly one line afterwards, and at
// most one move can take the same tail.
func TestMoveAndPromote_ConcurrentCallsKeepEveryMessageOnce(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	f.reply(root.ID)
	f.reply(root.ID)
	alt := f.branch(root.ID, anchor.ID)
	f.reply(alt.ID)
	const total = 8 // three exchanges on the root, one in the branch

	var wg sync.WaitGroup
	results := make(chan error, 3)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.store.MoveToBranch(f.ctx, f.moveInput(root.ID, 2))
			results <- err
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, err := f.store.PromoteBranch(f.ctx, tenant, alt.ID)
		results <- err
	}()
	wg.Wait()
	close(results)
	for err := range results {
		if err == nil || errors.Is(err, domain.ErrBranchMoveProtected) || errors.Is(err, domain.ErrBranchMoveNoAnchor) ||
			errors.Is(err, domain.ErrBranchMoveNotUserStart) || errors.Is(err, domain.ErrBranchClosed) || errors.Is(err, domain.ErrBranchMoveTooFew) {
			continue
		}
		var openTail *domain.BranchOpenTailError
		if !errors.As(err, &openTail) {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	all := f.count(`SELECT count(*) FROM tangent_message WHERE line_id = $1 OR line_id IN (SELECT line_id FROM tangent_branch WHERE root_line_id = $1)`, root.ID)
	markers := f.count(`SELECT count(*) FROM tangent_message WHERE kind = 'branch_marker' AND (line_id = $1 OR line_id IN (SELECT line_id FROM tangent_branch WHERE root_line_id = $1))`, root.ID)
	if all-markers != total {
		t.Fatalf("messages in the tree = %d (%d markers), want %d of the originals", all, markers, total)
	}
}
