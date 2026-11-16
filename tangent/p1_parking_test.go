package tangent_test

import (
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

func TestParking_ParkListDropAndCount(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	e.events.Reset()
	seed, err := e.engine.CreateSeed(e.ctx, scopeA, main.ID, tangent.SeedInput{Text: "rail pass?", AnchorMessageID: anchor.Message.ID})
	if err != nil || seed.AnchorMessageID != anchor.Message.ID || seed.CreatedBy != scopeA.Actor {
		t.Fatalf("seed = %+v %v", seed, err)
	}
	e.wantTypes(tangent.EventSeedsChanged, tangent.EventLineUpdated)
	if changed := e.events.OfType(tangent.EventSeedsChanged)[0].Data.(tangent.SeedsChange); changed.RootLineID != main.ID {
		t.Fatalf("seeds.changed = %+v", changed)
	}
	if line := e.events.OfType(tangent.EventLineUpdated)[0].Data.(domain.LineView); line.OpenSeeds != 1 {
		t.Fatalf("the main line counts it: %d", line.OpenSeeds)
	}
	list, err := e.engine.ListSeeds(e.ctx, scopeA, main.ID, nil)
	if err != nil || len(list.Seeds) != 1 {
		t.Fatalf("list = %+v %v", list, err)
	}
	if _, err := e.engine.ListSeeds(e.ctx, scopeA, main.ID, []string{"nope"}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("bad status: %v", err)
	}
	e.turn(main.ID, "next", "ok")
	if strings.Contains(e.lastSystem(), "rail pass") {
		t.Fatal("a seed never enters a prompt")
	}
	e.rollsBack("drop seed", func(opt tangent.TxOption) error {
		_, err := e.engine.DropSeed(e.ctx, scopeA, seed.ID, opt)
		return err
	})
	e.rollsBack("note seed", func(opt tangent.TxOption) error {
		_, err := e.engine.NoteSeed(e.ctx, scopeA, seed.ID, "", opt)
		return err
	})
	dropped, err := e.engine.DropSeed(e.ctx, scopeA, seed.ID)
	if err != nil || dropped.Status != domain.SeedStatusDropped {
		t.Fatalf("dropped = %+v %v", dropped, err)
	}
	_, err = e.engine.DropSeed(e.ctx, scopeA, seed.ID)
	wantCode(t, err, domain.CodeSeedNotOpen)
	all, _ := e.engine.ListSeeds(e.ctx, scopeA, main.ID, []string{domain.SeedStatusOpen, domain.SeedStatusDropped})
	if len(all.Seeds) != 1 || all.Seeds[0].Status != domain.SeedStatusDropped {
		t.Fatalf("all = %+v", all)
	}
	e.rollsBack("create seed", func(opt tangent.TxOption) error {
		_, err := e.engine.CreateSeed(e.ctx, scopeA, main.ID, tangent.SeedInput{Text: "x"}, opt)
		return err
	})
}

func TestParking_ExpandOpensASeedBranch(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	e.turn(main.ID, "later", "more")
	seed, _ := e.engine.CreateSeed(e.ctx, scopeA, main.ID, tangent.SeedInput{Text: strings.Repeat("long thought ", 30), AnchorMessageID: anchor.Message.ID})
	e.rollsBack("expand", func(opt tangent.TxOption) error {
		_, err := e.engine.ExpandSeed(e.ctx, scopeA, seed.ID, tangent.ExpandInput{}, opt)
		return err
	})
	e.events.Reset()
	expanded, err := e.engine.ExpandSeed(e.ctx, scopeA, seed.ID, tangent.ExpandInput{})
	if err != nil || expanded.Branch.Origin != domain.BranchOriginSeed || expanded.Branch.AnchorMessageID != anchor.Message.ID ||
		expanded.Branch.Kind != domain.BranchKindInvestigate || expanded.Seed.ExpandedLineID != expanded.Line.ID {
		t.Fatalf("expanded = %+v %v", expanded, err)
	}
	if got := []rune(expanded.Branch.Purpose); len(got) != 200 || got[len(got)-1] != '…' {
		t.Fatalf("the purpose is the seed's text, cut: %q", expanded.Branch.Purpose)
	}
	if expanded.Pack.Rendered == "" {
		t.Fatal("the branch has a pack")
	}
	e.wantTypes(tangent.EventLineCreated, tangent.EventLineUpdated, tangent.EventBranchChanged, tangent.EventSeedsChanged, tangent.EventLineUpdated)
	_, err = e.engine.ExpandSeed(e.ctx, scopeA, seed.ID, tangent.ExpandInput{})
	wantCode(t, err, domain.CodeSeedNotOpen)
	named, _ := e.engine.CreateSeed(e.ctx, scopeA, main.ID, tangent.SeedInput{Text: "x"})
	aside, err := e.engine.ExpandSeed(e.ctx, scopeA, named.ID, tangent.ExpandInput{Purpose: "quick one", Kind: domain.BranchKindAside})
	if err != nil || aside.Branch.Kind != domain.BranchKindAside || aside.Branch.Purpose != "quick one" {
		t.Fatalf("aside = %+v %v", aside, err)
	}
	bad, _ := e.engine.CreateSeed(e.ctx, scopeA, main.ID, tangent.SeedInput{Text: "x"})
	_, err = e.engine.ExpandSeed(e.ctx, scopeA, bad.ID, tangent.ExpandInput{Kind: "nope"})
	wantCode(t, err, domain.CodeKindUnsupported)
}

func TestParking_AnExpansionTheBranchLimitsRefuseLeavesTheSeedOpen(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Branch.MaxOpenPerParent = 1
	e := newEnvWith(t, p1Features(), tangent.WithLimits(limits))
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	e.branch(main.ID, anchor.Message.ID, "taken")
	seed, _ := e.engine.CreateSeed(e.ctx, scopeA, main.ID, tangent.SeedInput{Text: "no room"})
	e.events.Reset()
	_, err := e.engine.ExpandSeed(e.ctx, scopeA, seed.ID, tangent.ExpandInput{})
	wantCode(t, err, domain.CodeBranchLimit)
	if len(e.events.Events()) != 0 {
		t.Fatalf("nothing published: %v", e.events.Types())
	}
	if list, _ := e.engine.ListSeeds(e.ctx, scopeA, main.ID, nil); len(list.Seeds) != 1 {
		t.Fatal("the seed is still open")
	}
}

func TestParking_ToNoteNeedsNotes(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	seed, _ := e.engine.CreateSeed(e.ctx, scopeA, main.ID, tangent.SeedInput{Text: "check the visa", AnchorMessageID: anchor.Message.ID})
	e.events.Reset()
	noted, err := e.engine.NoteSeed(e.ctx, scopeA, seed.ID, "")
	if err != nil || noted.Seed.Status != domain.SeedStatusNoted || noted.Notes.Created[0].Section != domain.NoteSectionToConfirm ||
		noted.Notes.Created[0].SourceLabel != "主線 #2" {
		t.Fatalf("noted = %+v %v", noted, err)
	}
	e.wantTypes(tangent.EventNotesChanged, tangent.EventSeedsChanged, tangent.EventLineUpdated)

	off := newEnvWith(t, p1Features(func(f []tangent.Feature) []tangent.Feature {
		out := []tangent.Feature{}
		for _, feature := range f {
			if feature.Name() != tangent.FeatureNotes {
				out = append(out, feature)
			}
		}
		return out
	}))
	line := off.mainLine()
	other, _ := off.engine.CreateSeed(off.ctx, scopeA, line.ID, tangent.SeedInput{Text: "x"})
	_, err = off.engine.NoteSeed(off.ctx, scopeA, other.ID, "")
	wantCode(t, err, domain.CodeFeatureDisabled)
	if list, _ := off.engine.ListSeeds(off.ctx, scopeA, line.ID, nil); len(list.Seeds) != 1 {
		t.Fatal("the seed stays open")
	}
}

func TestParking_OffRefusesEverySeedCall(t *testing.T) {
	e := newEnvWith(t, tangent.AllFeatures())
	main := e.mainLine()
	for _, call := range []func() error{
		func() error { _, err := e.engine.ListSeeds(e.ctx, scopeA, main.ID, nil); return err },
		func() error {
			_, err := e.engine.CreateSeed(e.ctx, scopeA, main.ID, tangent.SeedInput{Text: "x"})
			return err
		},
		func() error { _, err := e.engine.DropSeed(e.ctx, scopeA, main.ID); return err },
		func() error { _, err := e.engine.NoteSeed(e.ctx, scopeA, main.ID, ""); return err },
		func() error { _, err := e.engine.ExpandSeed(e.ctx, scopeA, main.ID, tangent.ExpandInput{}); return err },
	} {
		wantCode(t, call(), domain.CodeFeatureDisabled)
	}
}

func TestNotes_SourceLabelsFollowTheEngineOption(t *testing.T) {
	e := newEnvWith(t, tangent.AllFeatures(), tangent.WithNoteSourceLabels(domain.EnglishNoteSourceLabels()))
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	write, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: "add", Section: "fact", Text: "x", SourceMessageID: anchor.Message.ID}})
	if err != nil || write.Created[0].SourceLabel != "Main line #2" {
		t.Fatalf("write = %+v %v", write, err)
	}
}
