package tangent_test

import (
	"context"
	"log/slog"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// b14Features is the P2 set plus fold, diverge, memo and search.
func b14Features() []tangent.Feature {
	return append(p2Features(tangent.ModeManual), tangent.Fold(tangent.ModeManual), tangent.Diverge(tangent.ModeManual), tangent.Memo(), tangent.Search())
}

// newB14Env is an engine with b14Features (search's migration run).
func newB14Env(t *testing.T, features []tangent.Feature, opts ...tangent.Option) *env {
	t.Helper()
	pool := tangenttest.OpenFeatures(t, tangent.FeatureSearch)
	events := tangenttest.NewRecorder()
	base := []tangent.Option{
		tangent.WithPublisher(events), tangent.WithLogger(slog.New(slog.DiscardHandler)), tangent.WithFeatures(features...),
	}
	engine, err := tangent.New(pool, append(base, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	return &env{t: t, ctx: tangenttest.Context(t), pool: pool, engine: engine, events: events, runner: tangenttest.NewFakeRunner()}
}

// readerOff turns every optional feature off for the actor "reader".
type readerOff struct{}

func (readerOff) Mode(_ context.Context, scope tangent.Scope, _ string) tangent.Mode {
	if scope.Actor == "reader" {
		return tangent.ModeOff
	}
	return tangent.ModeAuto
}

func TestB14_SearchWithinOneTreeFindsBranchesAndFoldedMessages(t *testing.T) {
	e := newB14Env(t, b14Features())
	main := e.mainLine()
	first := e.turn(main.ID, "the walrus plan, part one", "noted")
	second := e.turn(main.ID, "part two", "the walrus again")
	e.turn(main.ID, "part three", "done")
	if _, err := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: first.Message.ID, ToMessageID: second.Message.ID, Summary: "folded"}); err != nil {
		t.Fatal(err)
	}
	branch := e.branch(main.ID, second.Message.ID, "Walrus logistics")
	e.turn(branch.Line.ID, "where do walruses sleep?", "on the ice")
	other := e.mainLine()
	e.turn(other.ID, "a walrus elsewhere", "elsewhere")

	hits, err := e.engine.Search(e.ctx, scopeA, tangent.SearchInput{Query: "walrus", Root: main.ID})
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	for _, hit := range hits {
		if hit.RootLineID != main.ID {
			t.Fatalf("a hit outside the tree: %+v", hit)
		}
		kinds[hit.Kind]++
	}
	// Two folded main-line messages, the branch's question and its purpose.
	if kinds[domain.SearchKindMessage] != 3 || kinds[domain.SearchKindPurpose] != 1 {
		t.Fatalf("hits by kind = %v (%+v)", kinds, hits)
	}
	if all, _ := e.engine.Search(e.ctx, scopeA, tangent.SearchInput{Query: "walrus"}); len(all) != len(hits)+1 {
		t.Fatalf("without root the other tree is searched too: %d vs %d", len(all), len(hits))
	}

	// An archived tree is searched by its root whatever archived says.
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, true); err != nil {
		t.Fatal(err)
	}
	if again, err := e.engine.Search(e.ctx, scopeA, tangent.SearchInput{Query: "walrus", Root: main.ID}); err != nil || len(again) != len(hits) {
		t.Fatalf("archived tree: %d hits %v", len(again), err)
	}

	for _, root := range []string{branch.Line.ID, uuid.NewString(), "not-a-uuid"} {
		_, err := e.engine.Search(e.ctx, scopeA, tangent.SearchInput{Query: "walrus", Root: root})
		wantCode(t, err, domain.CodeLineNotFound)
	}
	_, err = e.engine.Search(e.ctx, scopeB, tangent.SearchInput{Query: "walrus", Root: other.ID})
	wantCode(t, err, domain.CodeLineNotFound)
}

func TestB14_ExportReadsTheWholeTreeFromAnyLine(t *testing.T) {
	e := newB14Env(t, b14Features(), tangent.WithFeaturePolicy(readerOff{}))
	main := e.mainLine()
	first := e.turn(main.ID, "q1", "a1")
	second := e.turn(main.ID, "q2", "a2")
	e.turn(main.ID, "q3", "a3")
	if _, err := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: first.Message.ID, ToMessageID: second.Message.ID, Summary: "s"}); err != nil {
		t.Fatal(err)
	}
	branch := e.branch(main.ID, first.Message.ID, "Talked over")
	e.turn(branch.Line.ID, "bq", "ba")
	empty := e.branch(main.ID, second.Message.ID, "Nothing yet")
	if _, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "two nights"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{NodeLineID: branch.Line.ID, Text: "ask later"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.PutGoal(e.ctx, scopeA, main.ID, "Pick a hotel"); err != nil {
		t.Fatal(err)
	}

	out, err := e.engine.ExportTree(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if out.RootLineID != main.ID || out.RootLine.ID != main.ID || out.Truncated || out.ExportedAt.IsZero() || len(out.Branches) != 2 {
		t.Fatalf("export = %+v", out)
	}
	if len(out.MessagesByLine) != 3 || len(out.MessagesByLine[main.ID]) != 6 || len(out.MessagesByLine[branch.Line.ID]) != 2 {
		t.Fatalf("messages by line = %d lines, main %d", len(out.MessagesByLine), len(out.MessagesByLine[main.ID]))
	}
	if got, ok := out.MessagesByLine[empty.Line.ID]; !ok || got == nil || len(got) != 0 {
		t.Fatalf("an empty branch has an empty list: %v %v", got, ok)
	}
	if !slices.IsSortedFunc(out.MessagesByLine[main.ID], func(a, b domain.Message) int { return int(a.Seq - b.Seq) }) {
		t.Fatal("messages are in seq order")
	}
	if len(out.Notes) != 1 || len(out.Memos) != 1 || out.Goal == nil || out.Goal.Text != "Pick a hotel" || len(out.FoldsByLine[main.ID]) != 1 {
		t.Fatalf("feature parts: notes %d memos %d goal %+v folds %v", len(out.Notes), len(out.Memos), out.Goal, out.FoldsByLine)
	}
	if out.Comparisons == nil || out.Links == nil || out.Chapters == nil {
		t.Fatal("empty parts are empty lists")
	}

	// The same tree with the features off for the reader: empty parts, no error.
	reader := tangent.Scope{Tenant: scopeA.Tenant, Actor: "reader"}
	off, err := e.engine.ExportTree(e.ctx, reader, main.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(off.Notes) != 0 || len(off.Memos) != 0 || off.Goal != nil || len(off.FoldsByLine) != 0 || off.FoldsByLine == nil || len(off.MessagesByLine[main.ID]) != 6 {
		t.Fatalf("with the features off: %+v", off)
	}
	_, err = e.engine.ExportTree(e.ctx, scopeB, main.ID)
	wantCode(t, err, domain.CodeLineNotFound)
}

func TestB14_ExportNeedsNoFeatureAndCapsEachLine(t *testing.T) {
	e := newEnvWith(t, nil)
	main := e.mainLine()
	for i := 0; i < 3; i++ {
		e.turn(main.ID, "q", "a")
	}
	out, err := e.engine.ExportTree(e.ctx, scopeA, main.ID)
	if err != nil || len(out.MessagesByLine[main.ID]) != 6 || out.Notes == nil || out.Goal != nil {
		t.Fatalf("core only: %+v %v", out, err)
	}
	capped, err := e.rawStore().ListTreeMessages(e.ctx, scopeA.Tenant, []string{main.ID}, 4)
	if err != nil || !capped.Truncated || len(capped.ByLine[main.ID]) != 4 || capped.ByLine[main.ID][0].Content != "q" {
		t.Fatalf("capped: %+v %v", capped, err)
	}
	exact, err := e.rawStore().ListTreeMessages(e.ctx, scopeA.Tenant, []string{main.ID}, 6)
	if err != nil || exact.Truncated || len(exact.ByLine[main.ID]) != 6 {
		t.Fatalf("exactly at the cap: %+v %v", exact, err)
	}
	// The store's tree reads filter by the tenant too, whatever ids they get.
	foreign, err := e.rawStore().ListTreeMessages(e.ctx, scopeB.Tenant, []string{main.ID}, 6)
	if err != nil || len(foreign.ByLine[main.ID]) != 0 {
		t.Fatalf("another tenant's line: %+v %v", foreign, err)
	}
}

func TestB14_DivergeModelsOpensOneBranchPerModel(t *testing.T) {
	e := newB14Env(t, b14Features(), tangent.WithModelCheck(allowOnly("anthropic/sonnet", "anthropic/haiku", "openai/gpt-5")))
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "Use a ring buffer for the event queue because it never allocates")
	e.events.Reset()

	out, err := e.engine.DivergeModels(e.ctx, scopeA, main.ID, tangent.DivergeModelsInput{
		AnchorMessageID: anchor.Message.ID,
		Targets: []tangent.DivergeTarget{
			{Provider: "openai", Model: "gpt-5"},
			{Provider: "anthropic", Model: "haiku", Purpose: "  The cheap take  "},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.ParentLineID != main.ID || out.RootLineID != main.ID || len(out.Branches) != 2 {
		t.Fatalf("out = %+v", out)
	}
	gpt, haiku := out.Branches[0], out.Branches[1]
	if gpt.Branch.Purpose != "Use a ring buffer for the event queue b… · gpt-5" || haiku.Branch.Purpose != "The cheap take" {
		t.Fatalf("purposes %q %q", gpt.Branch.Purpose, haiku.Branch.Purpose)
	}
	for _, b := range out.Branches {
		if b.Branch.Kind != domain.BranchKindAlternative || b.Branch.Origin != domain.BranchOriginDiverge || b.Branch.AnchorMessageID != anchor.Message.ID {
			t.Fatalf("branch = %+v", b.Branch)
		}
		if !strings.Contains(b.Pack.Rendered, "## Parallel answers") {
			t.Fatalf("pack = %q", b.Pack.Rendered)
		}
	}
	if gpt.Line.Provider != "openai" || gpt.Line.Model != "gpt-5" || haiku.Line.Provider != "anthropic" || haiku.Line.Model != "haiku" {
		t.Fatalf("models: %+v / %+v", gpt.Line, haiku.Line)
	}
	if !strings.Contains(gpt.Pack.Rendered, "The cheap take (anthropic/haiku)") || strings.Contains(gpt.Pack.Rendered, "The cheap take (openai") {
		t.Fatalf("the pack names the sibling and its model: %q", gpt.Pack.Rendered)
	}
	created := 0
	for _, typ := range e.events.Types() {
		if typ == tangent.EventLineCreated {
			created++
		}
	}
	if created != 2 {
		t.Fatalf("events = %v", e.events.Types())
	}

	shared, err := e.engine.DivergeModels(e.ctx, scopeA, main.ID, tangent.DivergeModelsInput{
		AnchorMessageID: anchor.Message.ID, Purpose: "Queue design",
		Targets: []tangent.DivergeTarget{{Provider: "anthropic", Model: "sonnet"}, {Provider: "openai", Model: "gpt-5"}},
	})
	if err != nil || shared.Branches[0].Branch.Purpose != "Queue design · sonnet" || shared.Branches[1].Branch.Purpose != "Queue design · gpt-5" {
		t.Fatalf("shared purpose: %+v %v", shared, err)
	}
}

func TestB14_DivergeModelsRefusesAllOrNothing(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Branch.MaxOpenPerParent = 3
	e := newB14Env(t, b14Features(), tangent.WithLimits(limits), tangent.WithModelCheck(allowOnly("anthropic/sonnet", "openai/gpt-5")))
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	two := []tangent.DivergeTarget{{Provider: "anthropic", Model: "sonnet"}, {Provider: "openai", Model: "gpt-5"}}
	try := func(in tangent.DivergeModelsInput) error {
		in.AnchorMessageID = cmpOr(in.AnchorMessageID, anchor.Message.ID)
		_, err := e.engine.DivergeModels(e.ctx, scopeA, main.ID, in)
		return err
	}
	wantCode(t, try(tangent.DivergeModelsInput{Targets: two[:1]}), domain.CodeInvalidInput)
	wantCode(t, try(tangent.DivergeModelsInput{Targets: slices.Repeat(two, 3)}), domain.CodeInvalidInput)
	wantCode(t, try(tangent.DivergeModelsInput{Targets: []tangent.DivergeTarget{two[0], {Provider: "openai"}}}), domain.CodeInvalidInput)
	wantCode(t, try(tangent.DivergeModelsInput{Targets: []tangent.DivergeTarget{two[0], {Provider: "openai", Model: "gpt-4"}}}), domain.CodeModelNotAllowed)
	wantCode(t, try(tangent.DivergeModelsInput{Targets: two, AnchorMessageID: uuid.NewString()}), domain.CodeAnchorNotFound)
	wantCode(t, try(tangent.DivergeModelsInput{Targets: two, Purpose: strings.Repeat("x", 201)}), domain.ErrInvalidPurpose.Code)

	e.rollsBack("DivergeModels", func(opt tangent.TxOption) error {
		_, err := e.engine.DivergeModels(e.ctx, scopeA, main.ID, tangent.DivergeModelsInput{AnchorMessageID: anchor.Message.ID, Targets: two}, opt)
		return err
	})

	// Room for one more open branch: the second is refused and the first rolls back.
	e.branch(main.ID, anchor.Message.ID, "taken")
	e.branch(main.ID, anchor.Message.ID, "taken too")
	e.events.Reset()
	wantCode(t, try(tangent.DivergeModelsInput{Targets: two}), domain.CodeBranchLimit)
	if n := e.count("SELECT count(*) FROM tangent_branch WHERE root_line_id = $1", main.ID); n != 2 {
		t.Fatalf("branches = %d, want the two made before", n)
	}
	if len(e.events.Events()) != 0 {
		t.Fatalf("a refused diverge published %v", e.events.Types())
	}

	off := newB14Env(t, p2Features(tangent.ModeManual))
	offMain := off.mainLine()
	_, err := off.engine.DivergeModels(off.ctx, scopeA, offMain.ID, tangent.DivergeModelsInput{Targets: two})
	wantCode(t, err, domain.CodeFeatureDisabled)
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func TestB14_SeedsBatchParksAllOrNone(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Parking.MaxOpenPerTree = 5
	e := newEnvWith(t, p1Features(), tangent.WithLimits(limits))
	main := e.mainLine()
	anchor := e.turn(main.ID, "an outline", "1. Basics 2. Pointers 3. Lifetimes")
	branch := e.branch(main.ID, anchor.Message.ID, "Study plan")
	e.events.Reset()

	created, err := e.engine.CreateSeeds(e.ctx, scopeA, branch.Line.ID, tangent.SeedsInput{Texts: []string{"Basics", " Pointers\nand refs ", "Lifetimes"}, AnchorMessageID: anchor.Message.ID})
	if err != nil {
		t.Fatal(err)
	}
	if created.RootLineID != main.ID || len(created.Seeds) != 3 || created.Seeds[1].Text != "Pointers and refs" {
		t.Fatalf("created = %+v", created)
	}
	for _, seed := range created.Seeds {
		if seed.AnchorMessageID != anchor.Message.ID || seed.AnchorLineID != main.ID || seed.Status != domain.SeedStatusOpen || seed.CreatedBy != "chang" {
			t.Fatalf("seed = %+v", seed)
		}
	}
	e.wantTypes(tangent.EventSeedsChanged, tangent.EventLineUpdated)

	// Three open and room for two: a batch of three is refused whole.
	_, err = e.engine.CreateSeeds(e.ctx, scopeA, main.ID, tangent.SeedsInput{Texts: []string{"a", "b", "c"}})
	wantCode(t, err, domain.CodeSeedLimit)
	if list, _ := e.engine.ListSeeds(e.ctx, scopeA, main.ID, nil); len(list.Seeds) != 3 {
		t.Fatalf("open seeds = %d, want 3", len(list.Seeds))
	}
	_, err = e.engine.CreateSeeds(e.ctx, scopeA, main.ID, tangent.SeedsInput{})
	wantCode(t, err, domain.CodeInvalidInput)
	_, err = e.engine.CreateSeeds(e.ctx, scopeA, main.ID, tangent.SeedsInput{Texts: slices.Repeat([]string{"x"}, domain.SeedBatchMax+1)})
	wantCode(t, err, domain.CodeInvalidInput)
	_, err = e.engine.CreateSeeds(e.ctx, scopeA, main.ID, tangent.SeedsInput{Texts: []string{"fine", "  "}})
	wantCode(t, err, domain.CodeInvalidInput)
	_, err = e.engine.CreateSeeds(e.ctx, scopeA, main.ID, tangent.SeedsInput{Texts: []string{strings.Repeat("字", limits.Parking.TextMaxRunes+1)}})
	wantCode(t, err, domain.CodeTooLong)
	_, err = e.engine.CreateSeeds(e.ctx, scopeA, main.ID, tangent.SeedsInput{Texts: []string{"x"}, AnchorMessageID: uuid.NewString()})
	wantCode(t, err, domain.CodeAnchorNotFound)
	_, err = e.engine.CreateSeeds(e.ctx, scopeB, main.ID, tangent.SeedsInput{Texts: []string{"x"}})
	wantCode(t, err, domain.CodeLineNotFound)
	e.rollsBack("CreateSeeds", func(opt tangent.TxOption) error {
		_, err := e.engine.CreateSeeds(e.ctx, scopeA, main.ID, tangent.SeedsInput{Texts: []string{"x"}}, opt)
		return err
	})
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, true); err != nil {
		t.Fatal(err)
	}
	_, err = e.engine.CreateSeeds(e.ctx, scopeA, main.ID, tangent.SeedsInput{Texts: []string{"x"}})
	wantCode(t, err, domain.ErrLineArchived.Code)
}

// Concurrent batches share the open-seed cap: the main line's lock lets
// exactly one of two batches that each fit alone through.
func TestB14_ConcurrentSeedBatchesKeepTheCap(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Parking.MaxOpenPerTree = 4
	e := newEnvWith(t, p1Features(), tangent.WithLimits(limits))
	main := e.mainLine()
	e.turn(main.ID, "q", "a")
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := e.engine.CreateSeeds(e.ctx, scopeA, main.ID, tangent.SeedsInput{Texts: []string{"a", "b", "c"}})
			errs <- err
		}()
	}
	refused := 0
	for range 2 {
		if err := <-errs; err != nil {
			wantCode(t, err, domain.CodeSeedLimit)
			refused++
		}
	}
	if refused != 1 {
		t.Fatalf("refused = %d, want 1", refused)
	}
	if n := e.count("SELECT count(*) FROM tangent_seed WHERE root_line_id = $1", main.ID); n != 3 {
		t.Fatalf("seeds = %d, want 3", n)
	}
}
