package store_test

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestBranches_TreeDepthRootAndInheritance(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()

	in := f.branchInput(root.ID, anchor.ID)
	in.Model = ""
	created, err := f.store.CreateBranch(f.ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	first := created.Line
	if first.ConversationBranch == nil || first.ConversationBranch.Depth != 1 || first.ConversationBranch.RootLineID != root.ID ||
		first.ConversationBranch.ParentLineID != root.ID || first.Title != "check it" || created.Branch.LineID != first.ID {
		t.Fatalf("first branch = %+v / %+v", first, first.ConversationBranch)
	}
	if first.Provider != "anthropic" || first.Model != "sonnet" || first.TenantID != tenant {
		t.Fatalf("a branch inherits provider and model: %+v", first)
	}

	second := f.branch(first.ID, f.reply(first.ID).ID)
	if second.Model != "haiku" || second.ConversationBranch.Depth != 2 || second.ConversationBranch.RootLineID != root.ID ||
		second.ConversationBranch.ParentLineID != first.ID {
		t.Fatalf("nested branch = %+v / %+v", second, second.ConversationBranch)
	}
	reloaded := f.line(root.ID)
	if reloaded.ConversationBranch != nil || reloaded.BranchCounts.Open != 1 {
		t.Fatalf("root = branch %+v counts %+v, want a main line with 1 open branch", reloaded.ConversationBranch, reloaded.BranchCounts)
	}
}

func TestBranches_RequestValidation(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	cases := map[string]func(*store.CreateBranchInput){
		"empty purpose": func(in *store.CreateBranchInput) { in.Purpose = "  " },
		"bad kind":      func(in *store.CreateBranchInput) { in.Kind = "tangent" },
		"bad origin":    func(in *store.CreateBranchInput) { in.Origin = "anywhere" },
		"move origin":   func(in *store.CreateBranchInput) { in.Origin = domain.BranchOriginMove },
	}
	for name, mutate := range cases {
		in := f.branchInput(root.ID, anchor.ID)
		mutate(&in)
		if _, err := f.store.CreateBranch(f.ctx, in); domain.CodeOf(err) == "" {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
	if f.count(`SELECT count(*) FROM tangent_branch`) != 0 {
		t.Fatal("a refused branch was stored")
	}
}

func TestBranches_TenantIsolation(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	branch := f.branch(root.ID, anchor.ID)
	if _, err := f.store.GetBranch(f.ctx, otherTenant, branch.ID); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("cross-tenant GetBranch = %v", err)
	}
	if views, err := f.store.ListBranches(f.ctx, otherTenant, root.ID, true); !errors.Is(err, domain.ErrLineNotFound) || len(views) != 0 {
		t.Fatalf("cross-tenant ListBranches = %v err=%v", views, err)
	}
	cross := f.branchInput(root.ID, anchor.ID)
	cross.Tenant = otherTenant
	if _, err := f.store.CreateBranch(f.ctx, cross); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("cross-tenant CreateBranch = %v", err)
	}
	if _, err := f.store.GetBranch(f.ctx, tenant, root.ID); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("a main line is not a branch: %v", err)
	}
}

func TestBranches_DeletingTheMainLineRowCascadesToItsBranches(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	branch := f.branch(root.ID, anchor.ID)
	f.exec(`DELETE FROM tangent_line WHERE id = $1`, root.ID)
	if got := f.count(`SELECT count(*) FROM tangent_branch WHERE line_id = $1`, branch.ID); got != 0 {
		t.Fatalf("branch rows after delete = %d", got)
	}
}

func TestBranches_OutlineIsCappedAndHidesAsidesUnlessAsked(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	for range 502 {
		f.insertBranchDirect(root.ID, root.ID, anchor.ID, 1, domain.BranchStatusDiscarded)
	}
	views, err := f.store.ListBranches(f.ctx, tenant, root.ID, true)
	if err != nil || len(views) != 500 {
		t.Fatalf("outline = %d rows err=%v, want the 500-row cap", len(views), err)
	}

	g := newFixture(t)
	groot, ganchor := g.mainLine()
	aside := g.branchInput(groot.ID, ganchor.ID)
	aside.Kind = domain.BranchKindAside
	if _, err := g.store.CreateBranch(g.ctx, aside); err != nil {
		t.Fatal(err)
	}
	plain := g.branch(groot.ID, ganchor.ID)
	if got, _ := g.store.ListBranches(g.ctx, tenant, groot.ID, false); len(got) != 1 || got[0].LineID != plain.ID {
		t.Fatalf("default outline = %+v", got)
	}
	if got, _ := g.store.ListBranches(g.ctx, tenant, plain.ID, true); len(got) != 2 {
		t.Fatalf("outline through a branch with asides = %d", len(got))
	}
}

func TestBranches_DepthLimits(t *testing.T) {
	f := newFixture(t)
	limits := domain.DefaultLimits().Branch
	root, anchor := f.mainLine()
	parent, parentAnchor := root.ID, anchor.ID
	for depth := 1; depth <= limits.SoftMaxDepth; depth++ {
		branch := f.branch(parent, parentAnchor)
		parent, parentAnchor = branch.ID, f.reply(branch.ID).ID
	}
	var soft *domain.BranchDepthSoftError
	if _, err := f.store.CreateBranch(f.ctx, f.branchInput(parent, parentAnchor)); !errors.As(err, &soft) || soft.Depth != 4 || soft.Limit != 3 {
		t.Fatalf("depth 4 without confirmation = %v, want the soft limit", err)
	}
	for depth := limits.SoftMaxDepth + 1; depth <= limits.HardMaxDepth; depth++ {
		in := f.branchInput(parent, parentAnchor)
		in.ConfirmDeeper = true
		created, err := f.store.CreateBranch(f.ctx, in)
		if err != nil {
			t.Fatalf("depth %d confirmed: %v", depth, err)
		}
		parent, parentAnchor = created.Line.ID, f.reply(created.Line.ID).ID
	}
	in := f.branchInput(parent, parentAnchor)
	in.ConfirmDeeper = true
	if _, err := f.store.CreateBranch(f.ctx, in); !errors.Is(err, domain.ErrBranchDepthHard) {
		t.Fatalf("depth 7 = %v, want the hard limit even when confirmed", err)
	}
}

func TestBranches_OpenBranchesPerParentAreCapped(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	limit := domain.DefaultLimits().Branch.MaxOpenPerParent
	for i := range limit {
		if _, err := f.store.CreateBranch(f.ctx, f.branchInput(root.ID, anchor.ID)); err != nil {
			t.Fatalf("branch %d: %v", i+1, err)
		}
	}
	if _, err := f.store.CreateBranch(f.ctx, f.branchInput(root.ID, anchor.ID)); !errors.Is(err, domain.ErrBranchLimit) {
		t.Fatalf("9th open branch = %v, want ErrBranchLimit", err)
	}
	// Finished branches do not count against the cap.
	f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE parent_line_id = $1`, root.ID)
	if _, err := f.store.CreateBranch(f.ctx, f.branchInput(root.ID, anchor.ID)); err != nil {
		t.Fatalf("after discarding: %v", err)
	}
}

func TestBranches_TheLimitsComeFromTheStore(t *testing.T) {
	f := newFixture(t)
	limits := domain.DefaultLimits()
	limits.Branch.MaxOpenPerParent = 1
	small, err := store.New(f.pool, limits)
	if err != nil {
		t.Fatal(err)
	}
	root, anchor := f.mainLine()
	if _, err := small.CreateBranch(f.ctx, f.branchInput(root.ID, anchor.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := small.CreateBranch(f.ctx, f.branchInput(root.ID, anchor.ID)); !errors.Is(err, domain.ErrBranchLimit) {
		t.Fatalf("second branch with a cap of one = %v", err)
	}
	bad := domain.DefaultLimits()
	bad.Branch.SoftMaxDepth = 9
	if _, err := store.New(f.pool, bad); err == nil {
		t.Fatal("limits that cannot work must be refused")
	}
	if _, err := store.New(nil, domain.DefaultLimits()); err == nil {
		t.Fatal("a nil pool must be refused")
	}
}

func TestBranches_WholeTreeIsCapped(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	for range domain.DefaultLimits().Branch.MaxPerTree {
		f.insertBranchDirect(root.ID, root.ID, anchor.ID, 1, domain.BranchStatusDiscarded)
	}
	if _, err := f.store.CreateBranch(f.ctx, f.branchInput(root.ID, anchor.ID)); !errors.Is(err, domain.ErrBranchTreeLimit) {
		t.Fatalf("branch 201 = %v, want ErrBranchTreeLimit", err)
	}
}

func TestBranches_ConcurrentCreatesCannotPassTheLimit(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	limit := int32(domain.DefaultLimits().Branch.MaxOpenPerParent)
	var created, refused atomic.Int32
	var wg sync.WaitGroup
	for range 14 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.store.CreateBranch(f.ctx, f.branchInput(root.ID, anchor.ID))
			switch {
			case err == nil:
				created.Add(1)
			case errors.Is(err, domain.ErrBranchLimit):
				refused.Add(1)
			default:
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	wg.Wait()
	if created.Load() != limit || refused.Load() != 14-limit {
		t.Fatalf("created %d refused %d, want exactly %d created", created.Load(), refused.Load(), limit)
	}
}

func TestBranches_AnchorMustBeAFinishedMessageOfTheParent(t *testing.T) {
	f := newFixture(t)
	root, _ := f.mainLine()
	otherRoot, otherAnchor := f.mainLine()
	in := f.branchInput(root.ID, otherAnchor.ID)
	if _, err := f.store.CreateBranch(f.ctx, in); !errors.Is(err, domain.ErrBranchAnchorNotFound) {
		t.Fatalf("foreign anchor = %v", err)
	}
	in.AnchorMessageID = "not-a-uuid"
	if _, err := f.store.CreateBranch(f.ctx, in); !errors.Is(err, domain.ErrBranchAnchorNotFound) {
		t.Fatalf("bad anchor id = %v", err)
	}
	pending := f.busy(otherRoot.ID).Pending
	if _, err := f.store.CreateBranch(f.ctx, f.branchInput(otherRoot.ID, pending.ID)); !errors.Is(err, domain.ErrBranchAnchorNotFound) {
		t.Fatalf("pending anchor = %v", err)
	}
	notice, err := f.store.InsertMessage(f.ctx, tenant, root.ID, store.NewMessage{Role: domain.RoleSystem, Kind: domain.MessageKindBranchMarker, Content: "moved"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.CreateBranch(f.ctx, f.branchInput(root.ID, notice.ID)); !errors.Is(err, domain.ErrBranchAnchorNotFound) {
		t.Fatalf("a system message as anchor = %v", err)
	}
	// B17: a conclusion card of the parent is an anchor (a follow-up on it),
	// a card of another line is not.
	card := f.card(root.ID)
	if _, err := f.store.CreateBranch(f.ctx, f.branchInput(otherRoot.ID, card.ID)); !errors.Is(err, domain.ErrBranchAnchorNotFound) {
		t.Fatalf("another line's card as anchor = %v", err)
	}
	created, err := f.store.CreateBranch(f.ctx, f.branchInput(root.ID, card.ID))
	if err != nil || created.Branch.AnchorMessageID != card.ID {
		t.Fatalf("a card as anchor = %+v %v", created.Branch, err)
	}
}

func TestBranches_ClosedOrArchivedBranchRefusesTurns(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	branch := f.branch(root.ID, anchor.ID)
	turn := f.busy(branch.ID)
	f.answer(turn.Pending.ID, "ok")
	f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE line_id = $1`, branch.ID)
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: branch.ID, Content: "again"}); !errors.Is(err, domain.ErrBranchClosed) {
		t.Fatalf("closed branch turn = %v, want ErrBranchClosed", err)
	}
	f.exec(`UPDATE tangent_branch SET status = 'open', closed_at = NULL WHERE line_id = $1`, branch.ID)
	if _, err := f.store.ArchiveTree(f.ctx, tenant, root.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: branch.ID, Content: "after archive"}); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("branch of an archived main line = %v, want ErrLineArchived", err)
	}
}

func TestBranches_ArchiveCoversTheWholeTreeAndRefusesABranch(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	child := f.branch(root.ID, anchor.ID)
	grandchild := f.branch(child.ID, f.reply(child.ID).ID)
	if _, err := f.store.ArchiveTree(f.ctx, tenant, child.ID, true); !errors.Is(err, domain.ErrArchiveNotMainLine) {
		t.Fatalf("archiving a branch = %v", err)
	}
	archived, err := f.store.ArchiveTree(f.ctx, tenant, root.ID, true)
	if err != nil || len(archived) != 3 || archived[0].ID != root.ID {
		t.Fatalf("archived = %d lines err=%v", len(archived), err)
	}
	for _, id := range []string{child.ID, grandchild.ID} {
		if f.line(id).ArchivedAt == nil {
			t.Fatalf("branch %s was not archived with its main line", id)
		}
	}
	restored, err := f.store.ArchiveTree(f.ctx, tenant, root.ID, false)
	if err != nil || len(restored) != 3 || restored[1].ArchivedAt != nil {
		t.Fatalf("unarchive = %d err=%v", len(restored), err)
	}
}

func TestBranches_CreateRefusesAnArchivedParent(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	if _, err := f.store.ArchiveTree(f.ctx, tenant, root.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.CreateBranch(f.ctx, f.branchInput(root.ID, anchor.ID)); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("branch under an archived main line = %v", err)
	}
}

func TestBranches_ParentRowRollsUpUnreadOfOpenBranches(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	quiet := f.branch(root.ID, anchor.ID)
	middle := f.branch(root.ID, anchor.ID)
	nested := f.branch(middle.ID, f.reply(middle.ID).ID)
	f.exec(`UPDATE tangent_line SET unread = 2 WHERE id = $1`, quiet.ID)
	f.exec(`UPDATE tangent_line SET unread = 1 WHERE id = $1`, nested.ID)

	reloaded := f.line(root.ID)
	if reloaded.BranchUnread != 3 || reloaded.BranchCounts.Open != 2 {
		t.Fatalf("root roll-up = unread %d counts %+v, want 3 / 2 open", reloaded.BranchUnread, reloaded.BranchCounts)
	}
	if got := f.line(middle.ID); got.BranchUnread != 1 || got.BranchCounts.Open != 1 {
		t.Fatalf("middle roll-up = %+v", got)
	}
	// A branch the operator already closed no longer lights up the main line.
	f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE line_id = $1`, nested.ID)
	if got := f.line(root.ID); got.BranchUnread != 2 {
		t.Fatalf("after discarding the nested branch: unread %d", got.BranchUnread)
	}
}

func TestBranches_DetailCarriesThePackDraftAndParentTip(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	in := f.branchInput(root.ID, anchor.ID)
	in.Excerpt = "selected words"
	in.Origin = domain.BranchOriginSelection
	created, err := f.store.CreateBranch(f.ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	detail, err := f.store.GetBranch(f.ctx, tenant, created.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	view := detail.Branch
	if detail.Pack.Rendered != "pack text" || view.Excerpt != "selected words" || view.Origin != domain.BranchOriginSelection ||
		view.Depth != 1 || view.AnchorMessageID != anchor.ID || view.MessageCount != 0 || view.Purpose != "check it" ||
		view.ClosedAt != nil || view.DraftStatus != domain.BranchDraftNone || view.LineStatus != domain.LineStatusIdle {
		t.Fatalf("branch view = %+v pack = %+v", view, detail.Pack)
	}
	if detail.ParentTipMessageID != anchor.ID || detail.Draft.Status != domain.BranchDraftNone || !detail.Draft.ManualCardAvailable {
		t.Fatalf("detail = %+v", detail)
	}
}

func TestBranches_BranchBelowAClosedBranchRefusesTurns(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	child := f.branch(root.ID, anchor.ID)
	grandchild := f.branch(child.ID, f.reply(child.ID).ID)
	f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE line_id = $1`, child.ID)
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: grandchild.ID, Content: "hello"}); !errors.Is(err, domain.ErrBranchClosed) {
		t.Fatalf("a branch below a closed branch took a turn: %v", err)
	}
	ended, err := f.store.BranchLineEnded(f.ctx, grandchild.ID)
	if err != nil || !ended {
		t.Fatalf("BranchLineEnded = %v err=%v", ended, err)
	}
	if ended, _ := f.store.BranchLineEnded(f.ctx, root.ID); ended {
		t.Fatal("a main line is never ended")
	}
	subtree, err := f.store.BranchSubtree(f.ctx, tenant, child.ID)
	if err != nil || len(subtree) != 2 || subtree[0].ID != child.ID {
		t.Fatalf("subtree = %d err=%v", len(subtree), err)
	}
}

func TestBranches_HydrationFailsLoudlyWhenTheBranchQueriesFail(t *testing.T) {
	f := newFixture(t)
	root, _ := f.mainLine()
	f.exec(`ALTER TABLE tangent_branch RENAME TO tangent_branch_gone`)
	if _, err := f.store.GetLine(f.ctx, tenant, root.ID); err == nil {
		t.Fatal("a failed branch query must not silently become zero counts")
	}
}

func TestBranches_PackReadsFollowTheAnchorBySeq(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	later := f.exchange(root.ID, "later q", "later a")
	// created_at no longer orders anything: put the later messages in the past.
	f.exec(`UPDATE tangent_message SET created_at = now() - interval '1 day' WHERE line_id = $1 AND seq > $2`, root.ID, anchor.Seq)
	upTo, err := f.store.MessagesUpToAnchor(f.ctx, tenant, root.ID, anchor.ID)
	if err != nil || len(upTo) != 2 || upTo[1].ID != anchor.ID {
		t.Fatalf("up to the anchor = %+v err=%v", upTo, err)
	}
	after, err := f.store.MessagesAfterAnchor(f.ctx, tenant, root.ID, anchor.ID)
	if err != nil || len(after) != 2 || after[1].ID != later.ID {
		t.Fatalf("after the anchor = %+v err=%v", after, err)
	}
	if _, err := f.store.MessagesUpToAnchor(f.ctx, tenant, root.ID, "not-a-uuid"); !errors.Is(err, domain.ErrMessageNotFound) {
		t.Fatalf("unknown anchor = %v", err)
	}
}
