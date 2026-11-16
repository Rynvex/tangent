package store_test

import (
	"errors"
	"sync"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func (f *fixture) seed(lineID, anchorID, text string) domain.Seed {
	f.t.Helper()
	seed, err := f.store.CreateSeed(f.ctx, store.CreateSeedInput{Tenant: tenant, LineID: lineID, AnchorMessageID: anchorID, Text: text, Actor: "chang"})
	if err != nil {
		f.t.Fatal(err)
	}
	return seed
}

func TestSeeds_CreateAnchorsAndLists(t *testing.T) {
	f := newFixture(t)
	main, branch := f.openBranch()
	branchTip := f.reply(branch.ID)
	atAnchor := f.seed(branch.ID, branchTip.ID, "  rail \n pass ")
	if atAnchor.Text != "rail pass" || atAnchor.AnchorMessageID != branchTip.ID || atAnchor.RootLineID != main.ID || atAnchor.Status != domain.SeedStatusOpen {
		t.Fatalf("seed = %+v", atAnchor)
	}
	atTip := f.seed(main.ID, "", "hotels")
	tip := f.parentTip(main.ID)
	if atTip.AnchorMessageID != tip {
		t.Fatalf("no anchor: the line's newest chat message (%s), got %s", tip, atTip.AnchorMessageID)
	}
	empty, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant, Title: "empty"})
	if err != nil {
		t.Fatal(err)
	}
	if bare := f.seed(empty.ID, "", "first thought"); bare.AnchorMessageID != "" {
		t.Fatalf("an empty line has no anchor: %+v", bare)
	}
	list, err := f.store.ListSeeds(f.ctx, store.SeedQuery{Tenant: tenant, LineID: branch.ID})
	if err != nil || list.RootLineID != main.ID || len(list.Seeds) != 2 || list.Seeds[0].ID != atTip.ID {
		t.Fatalf("list = %+v %v", list, err)
	}
	if got := f.line(main.ID); got.OpenSeeds != 2 {
		t.Fatalf("open seeds = %d", got.OpenSeeds)
	}
	for name, in := range map[string]store.CreateSeedInput{
		"empty text":   {Tenant: tenant, LineID: main.ID, Text: "  "},
		"other tenant": {Tenant: otherTenant, LineID: main.ID, Text: "x"},
		"bad anchor":   {Tenant: tenant, LineID: main.ID, Text: "x", AnchorMessageID: empty.ID},
		"other tree":   {Tenant: tenant, LineID: empty.ID, Text: "x", AnchorMessageID: branchTip.ID},
	} {
		if _, err := f.store.CreateSeed(f.ctx, in); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := f.store.CreateSeed(f.ctx, store.CreateSeedInput{Tenant: tenant, LineID: main.ID, Text: "x", AnchorMessageID: empty.ID}); !errors.Is(err, domain.ErrBranchAnchorNotFound) {
		t.Fatalf("anchor: %v", err)
	}
}

func TestSeeds_TheOpenLimitHoldsUnderConcurrency(t *testing.T) {
	f := newFixture(t)
	limits := domain.DefaultLimits()
	limits.Parking.MaxOpenPerTree = 3
	s, err := store.New(f.pool, limits)
	if err != nil {
		t.Fatal(err)
	}
	main, _ := f.mainLine()
	var wg sync.WaitGroup
	var mu sync.Mutex
	refused := 0
	for range 6 {
		wg.Go(func() {
			_, err := s.CreateSeed(f.ctx, store.CreateSeedInput{Tenant: tenant, LineID: main.ID, Text: "x"})
			mu.Lock()
			defer mu.Unlock()
			if errors.Is(err, domain.ErrSeedLimit) {
				refused++
			} else if err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if refused != 3 || f.count(`SELECT count(*) FROM tangent_seed WHERE status = 'open'`) != 3 {
		t.Fatalf("refused %d", refused)
	}
	dropped, err := s.DropSeed(f.ctx, tenant, f.firstSeed(main.ID).ID)
	if err != nil || dropped.Status != domain.SeedStatusDropped {
		t.Fatalf("drop = %+v %v", dropped, err)
	}
	if _, err := s.CreateSeed(f.ctx, store.CreateSeedInput{Tenant: tenant, LineID: main.ID, Text: "room again"}); err != nil {
		t.Fatalf("a dropped seed makes room: %v", err)
	}
}

func (f *fixture) firstSeed(lineID string) domain.Seed {
	f.t.Helper()
	list, err := f.store.ListSeeds(f.ctx, store.SeedQuery{Tenant: tenant, LineID: lineID, Statuses: []string{domain.SeedStatusOpen}})
	if err != nil || len(list.Seeds) == 0 {
		f.t.Fatalf("seeds: %+v %v", list, err)
	}
	return list.Seeds[0]
}

func TestSeeds_EndingsAreFinal(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	seed := f.seed(main.ID, anchor.ID, "a thought worth noting")
	noted, err := f.store.NoteSeed(f.ctx, store.NoteSeedInput{Tenant: tenant, SeedID: seed.ID, Actor: "chang"})
	if err != nil || noted.Seed.Status != domain.SeedStatusNoted || noted.Seed.NoteID == "" || len(noted.Notes.Created) != 1 {
		t.Fatalf("noted = %+v %v", noted, err)
	}
	note := noted.Notes.Created[0]
	if note.Section != domain.NoteSectionToConfirm || note.Text != seed.Text || note.SourceMessageID != anchor.ID || note.SourceLabel != "主線 #2" {
		t.Fatalf("note = %+v", note)
	}
	if _, err := f.store.DropSeed(f.ctx, tenant, seed.ID); !errors.Is(err, domain.ErrSeedNotOpen) {
		t.Fatalf("a noted seed stays noted: %v", err)
	}
	if _, err := f.store.NoteSeed(f.ctx, store.NoteSeedInput{Tenant: tenant, SeedID: seed.ID}); !errors.Is(err, domain.ErrSeedNotOpen) {
		t.Fatalf("noted twice: %v", err)
	}
	fact := f.seed(main.ID, "", "a fact")
	if n, err := f.store.NoteSeed(f.ctx, store.NoteSeedInput{Tenant: tenant, SeedID: fact.ID, Section: "fact"}); err != nil || n.Notes.Created[0].Section != "fact" {
		t.Fatalf("section = %+v %v", n, err)
	}
	if _, err := f.store.NoteSeed(f.ctx, store.NoteSeedInput{Tenant: tenant, SeedID: f.seed(main.ID, "", "x").ID, Section: "nope"}); domain.CodeOf(err) != domain.CodeInvalidNote {
		t.Fatalf("bad section: %v", err)
	}
	if _, err := f.store.GetSeed(f.ctx, otherTenant, seed.ID); !errors.Is(err, domain.ErrSeedNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
	if _, err := f.store.DropSeed(f.ctx, tenant, "nope"); !errors.Is(err, domain.ErrSeedNotFound) {
		t.Fatalf("bad id: %v", err)
	}
}

func TestSeeds_ExpandOpensABranchAtTheAnchor(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	f.reply(main.ID)
	seed := f.seed(main.ID, anchor.ID, "compare rail passes")
	plan, err := f.store.PlanSeedExpansion(f.ctx, tenant, seed.ID)
	if err != nil || plan.ParentLineID != main.ID || plan.AnchorMessageID != anchor.ID {
		t.Fatalf("plan = %+v %v", plan, err)
	}
	in := store.ExpandSeedInput{SeedID: seed.ID, CreateBranchInput: f.branchInput(plan.ParentLineID, plan.AnchorMessageID)}
	expanded, err := f.store.ExpandSeed(f.ctx, in)
	if err != nil || expanded.Seed.Status != domain.SeedStatusExpanded || expanded.Seed.ExpandedLineID != expanded.Line.ID ||
		expanded.Branch.Origin != domain.BranchOriginSeed || expanded.Branch.AnchorMessageID != anchor.ID {
		t.Fatalf("expanded = %+v %v", expanded, err)
	}
	if _, err := f.store.ExpandSeed(f.ctx, in); !errors.Is(err, domain.ErrSeedNotOpen) {
		t.Fatalf("expanded twice: %v", err)
	}
	if _, err := f.store.PlanSeedExpansion(f.ctx, tenant, seed.ID); !errors.Is(err, domain.ErrSeedNotOpen) {
		t.Fatalf("plan a closed seed: %v", err)
	}
}

func TestSeeds_ExpandFollowsAMovedAnchorAndFallsBackWhenItIsGone(t *testing.T) {
	f := newFixture(t)
	main, firstReply := f.mainLine()
	f.message(main.ID, domain.RoleUser, "tail question")
	tail := f.message(main.ID, domain.RoleAssistant, "tail answer")
	seed := f.seed(main.ID, tail.ID, "follow the tail")
	moved, err := f.store.MoveToBranch(f.ctx, store.MoveToBranchInput{
		CreateBranchInput: store.CreateBranchInput{Tenant: tenant, ParentLineID: main.ID, Purpose: "moved", Kind: domain.BranchKindInvestigate},
		Count:             2, BuildPack: func(store.MovePackBase) domain.BranchPack { return domain.BranchPack{} },
	})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := f.store.PlanSeedExpansion(f.ctx, tenant, seed.ID)
	if err != nil || plan.ParentLineID != moved.Line.ID || plan.AnchorMessageID != tail.ID {
		t.Fatalf("the anchor moved with its messages: %+v %v", plan, err)
	}
	gone := f.seed(main.ID, tail.ID, "anchor goes away")
	f.exec(`DELETE FROM tangent_message WHERE id = $1`, tail.ID)
	plan, err = f.store.PlanSeedExpansion(f.ctx, tenant, gone.ID)
	if err != nil || plan.ParentLineID != main.ID || plan.AnchorMessageID != firstReply.ID {
		t.Fatalf("a gone anchor falls back to the main line's newest message: %+v %v", plan, err)
	}
	empty, _ := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant, Title: "empty"})
	bare := f.seed(empty.ID, "", "nothing to hang on")
	if _, err := f.store.PlanSeedExpansion(f.ctx, tenant, bare.ID); !errors.Is(err, domain.ErrBranchAnchorNotFound) {
		t.Fatalf("nothing to hang on: %v", err)
	}
}

func TestSeeds_AFailedExpansionLeavesTheSeedOpen(t *testing.T) {
	f := newFixture(t)
	limits := domain.DefaultLimits()
	limits.Branch.MaxOpenPerParent = 1
	s, err := store.New(f.pool, limits)
	if err != nil {
		t.Fatal(err)
	}
	main, anchor := f.mainLine()
	f.branch(main.ID, anchor.ID)
	seed := f.seed(main.ID, anchor.ID, "one too many")
	in := store.ExpandSeedInput{SeedID: seed.ID, CreateBranchInput: f.branchInput(main.ID, anchor.ID)}
	if _, err := s.ExpandSeed(f.ctx, in); !errors.Is(err, domain.ErrBranchLimit) {
		t.Fatalf("the branch limit: %v", err)
	}
	if got, _ := f.store.GetSeed(f.ctx, tenant, seed.ID); got.Status != domain.SeedStatusOpen {
		t.Fatalf("still open: %+v", got)
	}
	other, otherAnchor := f.mainLine()
	in = store.ExpandSeedInput{SeedID: seed.ID, CreateBranchInput: f.branchInput(other.ID, otherAnchor.ID)}
	if _, err := f.store.ExpandSeed(f.ctx, in); !errors.Is(err, domain.ErrSeedNotFound) {
		t.Fatalf("a seed expands only inside its conversation: %v", err)
	}
}
