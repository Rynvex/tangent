package tangent_test

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// B23: keeping an aside, continuing one as a branch, deleting an ended
// branch.

// b23Features: the group features (leaf, relations, spinoff among them)
// with memos.
func b23Features() []tangent.Feature {
	return append(groupFeatures(tangent.ModeManual), tangent.Memo())
}

// b23Env is an engine whose clock runs shift ahead of the wall clock.
func b23Env(t *testing.T, shift *time.Duration) *env {
	t.Helper()
	return newEnvWith(t, b23Features(), tangent.WithClock(func() time.Time { return time.Now().Add(*shift) }))
}

// asideOn opens an aside on the anchor.
func (e *env) asideOn(parentID, anchorID string, keep bool) tangent.CreatedBranch {
	e.t.Helper()
	created, err := e.engine.CreateBranch(e.ctx, scopeA, parentID, tangent.BranchInput{
		AnchorMessageID: anchorID, Purpose: "quick check", Kind: domain.BranchKindAside, Model: "haiku", Keep: keep,
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return created
}

// answeredAside is a main line with an aside that got its one answer.
func (e *env) answeredAside() (domain.LineView, domain.Message, tangent.CreatedBranch) {
	e.t.Helper()
	main := e.mainLine()
	anchor := e.turn(main.ID, "which pool mode?", "transaction")
	aside := e.asideOn(main.ID, anchor.Message.ID, false)
	e.turn(aside.Line.ID, "what is a pool?", "a set of reused connections")
	return main, anchor.Message, aside
}

// purged runs the maintenance sweep and returns how many asides it purged.
func (e *env) purged() int {
	e.t.Helper()
	report, err := e.engine.Maintain(e.ctx)
	if err != nil {
		e.t.Fatal(err)
	}
	return report.Tasks[tangent.TaskPurgeAsides]
}

// branchChanges are the change values of the recorded branch.changed events.
func (e *env) branchChanges() []string {
	out := []string{}
	for _, ev := range e.events.OfType(tangent.EventBranchChanged) {
		out = append(out, ev.Data.(tangent.BranchChange).Change)
	}
	return out
}

func (e *env) lineGone(lineID string) {
	e.t.Helper()
	if _, err := e.engine.GetLine(e.ctx, scopeA, lineID); domain.CodeOf(err) != domain.CodeLineNotFound {
		e.t.Fatalf("line %s is still there: %v", lineID, err)
	}
}

func TestB23_AKeptAsideOutlivesTheRetentionUntilItIsReleased(t *testing.T) {
	shift := time.Duration(0)
	e := b23Env(t, &shift)
	_, _, aside := e.answeredAside()
	e.rollsBack("keep", func(opt tangent.TxOption) error {
		_, err := e.engine.KeepBranch(e.ctx, scopeA, aside.Line.ID, true, opt)
		return err
	})
	e.events.Reset()
	kept, err := e.engine.KeepBranch(e.ctx, scopeA, aside.Line.ID, true)
	if err != nil || kept.KeptAt == nil || kept.Status != domain.BranchStatusDiscarded {
		t.Fatalf("kept = %+v, %v", kept, err)
	}
	e.wantTypes(tangent.EventBranchChanged)
	if got := e.branchChanges(); !slices.Equal(got, []string{tangent.BranchKept}) {
		t.Fatalf("changes = %v", got)
	}
	// Keeping it again changes nothing and publishes nothing.
	e.events.Reset()
	again, err := e.engine.KeepBranch(e.ctx, scopeA, aside.Line.ID, true)
	if err != nil || again.KeptAt == nil || !again.KeptAt.Equal(*kept.KeptAt) {
		t.Fatalf("kept again = %+v, %v", again, err)
	}
	e.wantTypes()
	shift = 8 * 24 * time.Hour
	if n := e.purged(); n != 0 {
		t.Fatalf("a kept aside was purged (%d)", n)
	}
	if detail, err := e.engine.GetBranch(e.ctx, scopeA, aside.Line.ID); err != nil || detail.Branch.KeptAt == nil {
		t.Fatalf("the kept aside = %+v, %v", detail.Branch, err)
	}
	// Released, its purge time is the old one: closed_at + retention.
	e.events.Reset()
	released, err := e.engine.KeepBranch(e.ctx, scopeA, aside.Line.ID, false)
	if err != nil || released.KeptAt != nil {
		t.Fatalf("released = %+v, %v", released, err)
	}
	if got := e.branchChanges(); !slices.Equal(got, []string{tangent.BranchKept}) {
		t.Fatalf("changes = %v", got)
	}
	e.events.Reset()
	if _, err := e.engine.KeepBranch(e.ctx, scopeA, aside.Line.ID, false); err != nil {
		t.Fatal(err)
	}
	e.wantTypes()
	if n := e.purged(); n != 1 {
		t.Fatalf("the released aside was purged %d times", n)
	}
	e.lineGone(aside.Line.ID)
}

func TestB23_AnAsideOpenedKeptStaysAfterItsAnswer(t *testing.T) {
	shift := time.Duration(0)
	e := b23Env(t, &shift)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	aside := e.asideOn(main.ID, anchor.Message.ID, true)
	if aside.Branch.KeptAt == nil || aside.Branch.Status != domain.BranchStatusOpen {
		t.Fatalf("opened kept = %+v", aside.Branch)
	}
	done := e.turn(aside.Line.ID, "2+2?", "4")
	if done.EndedAside == nil || done.EndedAside.KeptAt == nil {
		t.Fatalf("ended aside = %+v", done.EndedAside)
	}
	shift = 30 * 24 * time.Hour
	if n := e.purged(); n != 0 {
		t.Fatalf("purged %d", n)
	}
	// keep belongs to asides.
	_, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{
		AnchorMessageID: anchor.Message.ID, Purpose: "p", Kind: domain.BranchKindInvestigate, Keep: true,
	})
	wantCode(t, err, domain.CodeInvalidInput)
	if e := domain.AsError(err, domain.DefaultLimits()); e.Extra["field"] != "keep" {
		t.Fatalf("extra = %v", e.Extra)
	}
}

func TestB23_KeepRefusals(t *testing.T) {
	shift := time.Duration(0)
	e := b23Env(t, &shift)
	main, anchor, aside := e.answeredAside()
	branch := e.branch(main.ID, anchor.ID, "a branch")
	_, err := e.engine.KeepBranch(e.ctx, scopeA, branch.Line.ID, true)
	wantCode(t, err, domain.CodeKindUnsupported)
	_, err = e.engine.KeepBranch(e.ctx, scopeA, main.ID, true)
	wantCode(t, err, domain.CodeBranchNotFound)
	_, err = e.engine.KeepBranch(e.ctx, scopeB, aside.Line.ID, true)
	wantCode(t, err, domain.CodeBranchNotFound)
	// An aside that is still open can be kept already.
	open := e.asideOn(main.ID, anchor.ID, false)
	if kept, err := e.engine.KeepBranch(e.ctx, scopeA, open.Line.ID, true); err != nil || kept.KeptAt == nil || kept.Status != domain.BranchStatusOpen {
		t.Fatalf("an open aside kept = %+v, %v", kept, err)
	}
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, true); err != nil {
		t.Fatal(err)
	}
	_, err = e.engine.KeepBranch(e.ctx, scopeA, aside.Line.ID, true)
	wantCode(t, err, domain.CodeArchived)

	off := newEnvWith(t, without(tangent.FeatureAside))
	_, err = off.engine.KeepBranch(off.ctx, scopeA, aside.Line.ID, true)
	wantCode(t, err, domain.CodeFeatureDisabled)
	_, err = off.engine.ContinueAside(off.ctx, scopeA, aside.Line.ID, tangent.ContinueAsideInput{})
	wantCode(t, err, domain.CodeFeatureDisabled)
}

func TestB23_ContinuingAnAsideMovesItsExchangeIntoANewBranch(t *testing.T) {
	shift := time.Duration(0)
	e := b23Env(t, &shift)
	main, anchor, aside := e.answeredAside()
	// A failed message stays behind and goes with the aside.
	e.exec(`INSERT INTO tangent_message (line_id, tenant_id, role, content, status) VALUES ($1, $2, 'assistant', 'boom', 'error')`, aside.Line.ID, scopeA.Tenant)
	before := e.transcript(aside.Line.ID)[:2]
	memo, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{NodeLineID: aside.Line.ID, Text: "remember the pool"})
	if err != nil {
		t.Fatal(err)
	}
	e.rollsBack("continue", func(opt tangent.TxOption) error {
		_, err := e.engine.ContinueAside(e.ctx, scopeA, aside.Line.ID, tangent.ContinueAsideInput{}, opt)
		return err
	})
	e.events.Reset()
	var hooked store.ContinuedAside
	out, err := e.engine.ContinueAside(e.ctx, scopeA, aside.Line.ID, tangent.ContinueAsideInput{}, tangent.InTx(func(_ context.Context, _ store.Tx, result any) error {
		hooked = result.(store.ContinuedAside)
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	if out.ReplacedLineID != aside.Line.ID || hooked.ReplacedLineID != aside.Line.ID || out.Line.ID == aside.Line.ID {
		t.Fatalf("continued = %+v", out)
	}
	b := out.Branch
	if b.Kind != domain.BranchKindInvestigate || b.Status != domain.BranchStatusOpen || b.Purpose != "quick check" || b.ParentLineID != main.ID ||
		b.AnchorMessageID != anchor.ID || b.Origin != aside.Branch.Origin || b.Depth != 1 || b.Model != "haiku" || b.KeptAt != nil || b.MessageCount != 2 {
		t.Fatalf("the new branch = %+v", b)
	}
	e.lineGone(aside.Line.ID)
	after := e.transcript(out.Line.ID)
	if len(after) != 2 || after[0].ID != before[0].ID || after[0].Seq != before[0].Seq || after[1].ID != before[1].ID || after[1].Seq != before[1].Seq {
		t.Fatalf("moved messages = %+v, were %+v", after, before)
	}
	if !slices.Equal(out.MovedMessageIDs, []string{before[0].ID, before[1].ID}) {
		t.Fatalf("moved ids = %v", out.MovedMessageIDs)
	}
	if n := e.count(`SELECT count(*)::int FROM tangent_message WHERE content = 'boom'`); n != 0 {
		t.Fatalf("the failed message outlived the aside (%d)", n)
	}
	// The memo written on the aside stays in the tree, on no node.
	memos, err := e.engine.ListMemos(e.ctx, scopeA, main.ID, "")
	if err != nil || len(memos.Memos) != 1 || memos.Memos[0].ID != memo.ID || memos.Memos[0].LineID != "" {
		t.Fatalf("memos = %+v, %v", memos, err)
	}
	e.wantTypes(tangent.EventLineDeleted, tangent.EventLineCreated, tangent.EventLineUpdated, tangent.EventBranchChanged)
	deleted := e.events.OfType(tangent.EventLineDeleted)[0]
	if data := deleted.Data.(tangent.LinesDeleted); deleted.LineID != aside.Line.ID || data.RootLineID != main.ID || !slices.Equal(data.LineIDs, []string{aside.Line.ID}) {
		t.Fatalf("line.deleted = %+v", deleted)
	}
	if got := e.branchChanges(); !slices.Equal(got, []string{tangent.BranchCreated}) {
		t.Fatalf("changes = %v", got)
	}
	// The branch takes another turn, with the aside's exchange as history.
	if got := e.historyTexts(out.Line.ID); !slices.Equal(got, []string{"what is a pool?", "a set of reused connections"}) {
		t.Fatalf("history = %v", got)
	}
	next := e.turn(out.Line.ID, "and how big?", "20")
	if next.EndedAside != nil || next.Message.Content != "20" {
		t.Fatalf("the next turn = %+v", next)
	}
	if detail, err := e.engine.GetBranch(e.ctx, scopeA, out.Line.ID); err != nil || detail.Branch.Status != domain.BranchStatusOpen || detail.Pack.Rendered == "" {
		t.Fatalf("the branch after a turn = %+v, %v", detail.Branch, err)
	}
}

func TestB23_ContinueTakesAPurposeAndAKindAndCarriesTheAsidesBranches(t *testing.T) {
	shift := time.Duration(0)
	e := b23Env(t, &shift)
	main, _, aside := e.answeredAside()
	// A branch that hangs on the aside's answer follows the exchange.
	reply := e.transcript(aside.Line.ID)[1]
	child := e.rawBranch(aside.Line.ID, main.ID, reply.ID, 2)
	e.events.Reset()
	out, err := e.engine.ContinueAside(e.ctx, scopeA, aside.Line.ID, tangent.ContinueAsideInput{Purpose: "  pool sizing  ", Kind: domain.BranchKindAlternative})
	if err != nil {
		t.Fatal(err)
	}
	if out.Branch.Purpose != "pool sizing" || out.Branch.Kind != domain.BranchKindAlternative || out.Line.Title != "pool sizing" {
		t.Fatalf("branch = %+v", out.Branch)
	}
	if !slices.Equal(out.Reparented, []string{child}) {
		t.Fatalf("reparented = %v", out.Reparented)
	}
	view, err := e.engine.GetBranch(e.ctx, scopeA, child)
	if err != nil || view.Branch.ParentLineID != out.Line.ID || view.Branch.Depth != 2 {
		t.Fatalf("the aside's branch = %+v, %v", view.Branch, err)
	}
	if got := e.branchChanges(); !slices.Equal(got, []string{tangent.BranchCreated, tangent.BranchMoved}) {
		t.Fatalf("changes = %v", got)
	}
}

func TestB23_ContinueRefusals(t *testing.T) {
	shift := time.Duration(0)
	e := b23Env(t, &shift)
	main, anchor, aside := e.answeredAside()
	refuse := func(name, code, lineID string, in tangent.ContinueAsideInput) {
		t.Helper()
		e.events.Reset()
		_, err := e.engine.ContinueAside(e.ctx, scopeA, lineID, in)
		if domain.CodeOf(err) != code {
			t.Fatalf("%s: code = %q (%v), want %q", name, domain.CodeOf(err), err, code)
		}
		e.wantTypes()
	}
	branch := e.branch(main.ID, anchor.ID, "a branch")
	refuse("not an aside", domain.CodeKindUnsupported, branch.Line.ID, tangent.ContinueAsideInput{})
	refuse("a main line", domain.CodeBranchNotFound, main.ID, tangent.ContinueAsideInput{})
	refuse("into an aside", domain.CodeKindUnsupported, aside.Line.ID, tangent.ContinueAsideInput{Kind: domain.BranchKindAside})
	refuse("an unknown kind", domain.CodeKindUnsupported, aside.Line.ID, tangent.ContinueAsideInput{Kind: "nope"})
	open := e.asideOn(main.ID, anchor.ID, false)
	refuse("not answered yet", domain.CodeBranchBusy, open.Line.ID, tangent.ContinueAsideInput{})
	if _, err := e.engine.BeginTurn(e.ctx, scopeA, open.Line.ID, tangent.TurnInput{Content: "still going"}); err != nil {
		t.Fatal(err)
	}
	refuse("answering", domain.CodeBranchBusy, open.Line.ID, tangent.ContinueAsideInput{})
	// Ended without an answer: there is no exchange to continue from.
	unanswered := e.asideOn(main.ID, anchor.ID, false)
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, unanswered.Line.ID); err != nil {
		t.Fatal(err)
	}
	refuse("ended unanswered", domain.CodeNoMessages, unanswered.Line.ID, tangent.ContinueAsideInput{})
	refuse("a purpose too long", domain.CodeInvalidInput, aside.Line.ID, tangent.ContinueAsideInput{Purpose: strings.Repeat("x", 201)})
	if _, err := e.engine.ContinueAside(e.ctx, scopeB, aside.Line.ID, tangent.ContinueAsideInput{}); domain.CodeOf(err) != domain.CodeBranchNotFound {
		t.Fatalf("another tenant: %v", err)
	}
	// The parent is full: nothing changes.
	for i := e.count(`SELECT count(*)::int FROM tangent_branch WHERE parent_line_id = $1 AND status = 'open'`, main.ID); i < domain.DefaultLimits().Branch.MaxOpenPerParent; i++ {
		e.branch(main.ID, anchor.ID, "filler")
	}
	refuse("the parent is full", domain.CodeBranchLimit, aside.Line.ID, tangent.ContinueAsideInput{})
	if got := contents(e.transcript(aside.Line.ID)); !slices.Equal(got, []string{"what is a pool?", "a set of reused connections"}) {
		t.Fatalf("a refused continue changed the aside: %v", got)
	}
	if detail, err := e.engine.GetBranch(e.ctx, scopeA, aside.Line.ID); err != nil || detail.Branch.Status != domain.BranchStatusDiscarded {
		t.Fatalf("the aside = %+v, %v", detail.Branch, err)
	}
	// An aside below a branch that ended has no parent to continue in.
	nested := e.asideOn(branch.Line.ID, e.turn(branch.Line.ID, "q", "a").Message.ID, false)
	e.turn(nested.Line.ID, "q", "a")
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, branch.Line.ID); err != nil {
		t.Fatal(err)
	}
	refuse("the parent ended", domain.CodeParentClosed, nested.Line.ID, tangent.ContinueAsideInput{})
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, true); err != nil {
		t.Fatal(err)
	}
	refuse("archived", domain.CodeArchived, aside.Line.ID, tangent.ContinueAsideInput{})
}

func TestB23_DeletingADiscardedBranchTakesItsSubtreeAndLeavesTheMarker(t *testing.T) {
	shift := time.Duration(0)
	e := b23Env(t, &shift)
	main := e.mainLine()
	anchor := e.turn(main.ID, "which disks?", "let us see")
	e.turn(main.ID, "a tangent about cases", "any 4-bay case")
	moved, err := e.engine.MoveToBranch(e.ctx, scopeA, main.ID, tangent.MoveInput{Count: 2, Purpose: "cases"})
	if err != nil {
		t.Fatal(err)
	}
	branch := moved.Line.ID
	childReply := e.transcript(branch)[1]
	child := e.branch(branch, childReply.ID, "fans")
	e.turn(child.Line.ID, "how loud?", "quiet")
	for _, id := range []string{child.Line.ID, branch} {
		if _, err := e.engine.DiscardBranch(e.ctx, scopeA, id); err != nil {
			t.Fatal(err)
		}
	}
	memo, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{NodeLineID: child.Line.ID, Text: "fans matter"})
	if err != nil {
		t.Fatal(err)
	}
	related, err := e.engine.CreateRelation(e.ctx, scopeA, main.ID, tangent.RelationInput{
		From: tangent.RelationEnd{LineID: branch}, To: tangent.RelationEnd{LineID: main.ID, MessageID: anchor.Message.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	e.rollsBack("delete branch", func(opt tangent.TxOption) error {
		_, err := e.engine.DeleteBranch(e.ctx, scopeA, branch, opt)
		return err
	})
	e.events.Reset()
	rowsSeen := 0
	out, err := e.engine.DeleteBranch(e.ctx, scopeA, branch, tangent.InTx(func(ctx context.Context, tx store.Tx, result any) error {
		// The hook runs before the rows go.
		deleted := result.(store.DeletedBranch)
		return tx.QueryRow(ctx, `SELECT count(*)::int FROM tangent_line WHERE id = ANY($1::uuid[])`, deleted.LineIDs).Scan(&rowsSeen)
	}))
	if err != nil {
		t.Fatal(err)
	}
	if rowsSeen != 2 || out.RootLineID != main.ID || out.LineID != branch || out.ParentLineID != main.ID || !slices.Equal(out.LineIDs, []string{branch, child.Line.ID}) {
		t.Fatalf("deleted = %+v (the hook saw %d rows)", out, rowsSeen)
	}
	e.lineGone(branch)
	e.lineGone(child.Line.ID)
	// The move marker on the parent stays.
	if got := contents(e.transcript(main.ID)); !slices.Equal(got, []string{"which disks?", "let us see", domain.MessageKindBranchMarker}) {
		t.Fatalf("the parent's transcript = %v", got)
	}
	memos, err := e.engine.ListMemos(e.ctx, scopeA, main.ID, "")
	if err != nil || len(memos.Memos) != 1 || memos.Memos[0].ID != memo.ID || memos.Memos[0].LineID != "" {
		t.Fatalf("memos = %+v, %v", memos, err)
	}
	if links, err := e.engine.ListRelations(e.ctx, scopeA, main.ID); err != nil || len(links) != 0 {
		t.Fatalf("relations = %+v, %v", links, err)
	}
	e.wantTypes(tangent.EventLineDeleted, tangent.EventLinkChanged, tangent.EventLineUpdated)
	deleted := e.events.OfType(tangent.EventLineDeleted)[0]
	if data := deleted.Data.(tangent.LinesDeleted); deleted.LineID != branch || deleted.RootLineID != main.ID || data.RootLineID != main.ID || !slices.Equal(data.LineIDs, out.LineIDs) {
		t.Fatalf("line.deleted = %+v", deleted)
	}
	if link := e.events.OfType(tangent.EventLinkChanged)[0].Data.(tangent.LinkChange); !link.Deleted || link.Link.ID != related.Link.ID || link.RootLineID != main.ID {
		t.Fatalf("link.changed = %+v", link)
	}
	if n := e.count(`SELECT count(*)::int FROM tangent_branch WHERE root_line_id = $1`, main.ID); n != 0 {
		t.Fatalf("%d branch rows left", n)
	}
}

func TestB23_DeletingAMemberShrinksOrDissolvesItsGroup(t *testing.T) {
	shift := time.Duration(0)
	e := b23Env(t, &shift)
	main := e.mainLine()
	anchor := e.turn(main.ID, "which disks?", "let us see")
	a, b, c := e.endedWithLeaf(main.ID, anchor.Message.ID, "New", "8TB"), e.endedWithLeaf(main.ID, anchor.Message.ID, "Used", "risky"), e.endedWithLeaf(main.ID, anchor.Message.ID, "Cases", "4-bay")
	created, err := e.engine.CreateGroup(e.ctx, scopeA, main.ID, tangent.GroupInput{MemberLineIDs: []string{a, b, c}, Title: "Disks"})
	if err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	if _, err := e.engine.DeleteBranch(e.ctx, scopeA, a); err != nil {
		t.Fatal(err)
	}
	groups := e.events.OfType(tangent.EventGroupChanged)
	if len(groups) != 1 {
		t.Fatalf("group events = %v", e.events.Types())
	}
	if g := groups[0].Data.(tangent.GroupChange).Group; g.ID != created.Group.ID || g.Status != domain.GroupActive || !slices.Equal(g.MemberLineIDs, []string{b, c}) {
		t.Fatalf("the group after one member went = %+v", g)
	}
	e.events.Reset()
	if _, err := e.engine.DeleteBranch(e.ctx, scopeA, b); err != nil {
		t.Fatal(err)
	}
	groups = e.events.OfType(tangent.EventGroupChanged)
	if len(groups) != 1 || groups[0].Data.(tangent.GroupChange).Group.Status != domain.GroupDissolved {
		t.Fatalf("a group of one is dissolved: %+v", groups)
	}
}

func TestB23_DeleteRefusals(t *testing.T) {
	shift := time.Duration(0)
	e := b23Env(t, &shift)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	refuse := func(name, code, lineID string) {
		t.Helper()
		e.events.Reset()
		_, err := e.engine.DeleteBranch(e.ctx, scopeA, lineID)
		if domain.CodeOf(err) != code {
			t.Fatalf("%s: code = %q (%v), want %q", name, domain.CodeOf(err), err, code)
		}
		e.wantTypes()
	}
	refuse("a main line", domain.CodeInvalidInput, main.ID)
	refuse("an unknown line", domain.CodeLineNotFound, "00000000-0000-4000-8000-0000000000aa")
	open := e.branch(main.ID, anchor.Message.ID, "open")
	refuse("an open branch", domain.CodeBranchNotDeletable, open.Line.ID)
	_, _, merged := e.mergedCard()
	refuse("a merged branch", domain.CodeBranchNotDeletable, merged.Branch.LineID)
	// Combined branches are discarded into the new one: they stay.
	x, y := e.endedOpen(main.ID, anchor.Message.ID, "x"), e.endedOpen(main.ID, anchor.Message.ID, "y")
	combined, err := e.engine.CombineBranches(e.ctx, scopeA, main.ID, tangent.CombineInput{LineIDs: []string{x, y}, Purpose: "both"})
	if err != nil {
		t.Fatal(err)
	}
	refuse("combined into another", domain.CodeBranchNotDeletable, x)
	// A discarded branch with an open branch below it waits for that one.
	parent := e.branch(main.ID, anchor.Message.ID, "parent")
	below := e.branch(parent.Line.ID, e.turn(parent.Line.ID, "q", "a").Message.ID, "below")
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, parent.Line.ID); err != nil {
		t.Fatal(err)
	}
	refuse("an open branch below", domain.CodeBranchBusy, parent.Line.ID)
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, below.Line.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.DeleteBranch(e.ctx, scopeB, parent.Line.ID); domain.CodeOf(err) != domain.CodeLineNotFound {
		t.Fatalf("another tenant: %v", err)
	}
	if out, err := e.engine.DeleteBranch(e.ctx, scopeA, parent.Line.ID); err != nil || len(out.LineIDs) != 2 {
		t.Fatalf("deleted = %+v, %v", out, err)
	}
	// Promoting leaves a promoted branch and the previous main line: both stay.
	promote := e.branch(main.ID, anchor.Message.ID, "promote")
	e.turn(promote.Line.ID, "q", "a")
	e.turn(main.ID, "an old tail", "old")
	promoted, err := e.engine.PromoteBranch(e.ctx, scopeA, promote.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	refuse("a promoted branch", domain.CodeBranchNotDeletable, promoted.PromotedID)
	refuse("the previous main line", domain.CodeBranchNotDeletable, promoted.Previous.LineID)
	// An ended aside goes, kept or not; an open one does not.
	aside := e.asideOn(main.ID, anchor.Message.ID, true)
	refuse("an open aside", domain.CodeBranchNotDeletable, aside.Line.ID)
	e.turn(aside.Line.ID, "2+2?", "4")
	if out, err := e.engine.DeleteBranch(e.ctx, scopeA, aside.Line.ID); err != nil || !slices.Equal(out.LineIDs, []string{aside.Line.ID}) {
		t.Fatalf("a kept aside deleted = %+v, %v", out, err)
	}
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, true); err != nil {
		t.Fatal(err)
	}
	refuse("archived", domain.CodeArchived, combined.Combined[1].LineID)
}

// rawBranch hangs an open branch on a line the API would refuse as a parent
// (an aside that ended).
func (e *env) rawBranch(parentID, rootID, anchorID string, depth int) string {
	e.t.Helper()
	id := uuid.NewString()
	e.exec(`INSERT INTO tangent_line (id, tenant_id, title) VALUES ($1, $2, 'raw')`, id, scopeA.Tenant)
	e.exec(`INSERT INTO tangent_branch (line_id, tenant_id, parent_line_id, root_line_id, anchor_message_id, purpose, kind, depth, origin)
		VALUES ($1, $2, $3, $4, $5, 'raw', 'investigate', $6, 'button')`, id, scopeA.Tenant, parentID, rootID, anchorID, depth)
	return id
}

// endedOpen opens a branch with an exchange and leaves it open.
func (e *env) endedOpen(mainID, anchorID, purpose string) string {
	e.t.Helper()
	b := e.branch(mainID, anchorID, purpose)
	e.turn(b.Line.ID, "about "+purpose, "noted")
	return b.Line.ID
}
