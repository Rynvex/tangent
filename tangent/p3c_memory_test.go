package tangent_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// memoryEnv is an engine with notes, leaf and memory in mode (the fake
// Embedder) over a schema with the memory migration; it skips without the
// vector extension.
func memoryEnv(t *testing.T, mode tangent.Mode, cfg tangent.MemoryConfig, opts ...tangent.Option) (*env, *recordingDispatcher) {
	t.Helper()
	pool := tangenttest.OpenFeatures(t, tangent.FeatureMemory)
	if cfg.Embedder == nil {
		cfg.Embedder = fake.NewEmbedder(0)
	}
	events := tangenttest.NewRecorder()
	base := []tangent.Option{
		tangent.WithPublisher(events), tangent.WithLogger(slog.New(slog.DiscardHandler)),
		tangent.WithFeatures(tangent.Notes(), tangent.Leaf(tangent.ModeManual), tangent.Memory(mode, cfg)),
	}
	engine, err := tangent.New(pool, append(base, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	sink := &recordingDispatcher{}
	engine.SetJobDispatcher(sink)
	return &env{t: t, ctx: tangenttest.Context(t), pool: pool, engine: engine, events: events, runner: tangenttest.NewFakeRunner()}, sink
}

func TestMemory_NewRefusesWithoutAnEmbedderOrAMigration(t *testing.T) {
	pool := tangenttest.Open(t)
	if _, err := tangent.New(pool, tangent.WithFeatures(tangent.Notes(), tangent.Memory(tangent.ModeSuggest, tangent.MemoryConfig{}))); err == nil || !strings.Contains(err.Error(), "Embedder") {
		t.Fatalf("an Embedder is required: %v", err)
	}
	_, err := tangent.New(pool, tangent.WithFeatures(tangent.Notes(), tangent.Memory(tangent.ModeSuggest, tangent.MemoryConfig{Embedder: fake.NewEmbedder(0)})))
	if err == nil || !strings.Contains(err.Error(), `feature "memory"`) {
		t.Fatalf("the extension and the migration are required: %v", err)
	}
	if _, err := tangent.New(pool, tangent.WithFeatures(tangent.Memory(tangent.ModeSuggest, tangent.MemoryConfig{Embedder: fake.NewEmbedder(0)}))); err == nil || !strings.Contains(err.Error(), "notes") {
		t.Fatalf("memory needs notes: %v", err)
	}
}

func TestMemory_TheOperatorWritesSearchesAndSupersedes(t *testing.T) {
	e, _ := memoryEnv(t, tangent.ModeManual, tangent.MemoryConfig{})
	main := e.mainLine()
	e.rollsBack("create memory", func(opt tangent.TxOption) error {
		_, err := e.engine.CreateMemory(e.ctx, scopeA, tangent.MemoryCreate{Memory: domain.MemoryInput{Kind: domain.MemoryFact, Text: "x"}}, opt)
		return err
	})
	e.events.Reset()
	created, err := e.engine.CreateMemory(e.ctx, scopeA, tangent.MemoryCreate{
		Memory: domain.MemoryInput{Kind: domain.MemoryDecision, Text: "The NAS uses a ZFS mirror", Importance: 8}, SourceLineID: main.ID,
	})
	if err != nil || created.Source.LineID != main.ID || created.Source.Label != "main" || created.Importance != 8 {
		t.Fatalf("created = %+v %v", created, err)
	}
	e.wantTypes(tangent.EventMemoryChanged)
	if _, err := e.engine.CreateMemory(e.ctx, scopeA, tangent.MemoryCreate{Memory: domain.MemoryInput{Kind: domain.MemoryFact, Text: "x"}, SourceLineID: unknownLine}); domain.CodeOf(err) != domain.CodeLineNotFound {
		t.Fatalf("an unknown source: %v", err)
	}
	other, _ := e.engine.CreateMemory(e.ctx, scopeA, tangent.MemoryCreate{Memory: domain.MemoryInput{Kind: domain.MemoryPreference, Text: "Bake sourdough on Sundays"}})
	results, err := e.engine.SearchMemories(e.ctx, scopeA, tangent.MemorySearch{Query: "which ZFS layout for the NAS?"})
	if err != nil || len(results) != 1 || results[0].Memory.ID != created.ID || results[0].Score <= 0 {
		t.Fatalf("search = %+v %v", results, err)
	}
	superseded, err := e.engine.SupersedeMemory(e.ctx, scopeA, created.ID, domain.MemoryInput{Text: "The NAS uses ZFS RAIDZ1"})
	if err != nil || superseded.New.Kind != domain.MemoryDecision || superseded.New.Importance != 8 || len(superseded.Old) != 1 || superseded.Old[0].SupersededBy != superseded.New.ID {
		t.Fatalf("superseded = %+v %v", superseded, err)
	}
	importance := 2
	if updated, err := e.engine.UpdateMemory(e.ctx, scopeA, other.ID, tangent.MemoryPatch{Importance: &importance}); err != nil || updated.Importance != 2 {
		t.Fatalf("updated = %+v %v", updated, err)
	}
	list, _ := e.engine.ListMemories(e.ctx, scopeA, tangent.MemoryQuery{Statuses: []string{domain.MemoryActive, domain.MemorySuperseded}})
	if len(list) != 3 {
		t.Fatalf("nothing is deleted: %+v", list)
	}
	all := tangent.MemoryQuery{Statuses: []string{domain.MemoryActive, domain.MemorySuperseded}, Limit: 2}
	first, err := e.engine.ListMemoriesPage(e.ctx, scopeA, all)
	if err != nil || len(first.Memories) != 2 || first.Memories[0].ID != list[0].ID || first.NextCursor == "" {
		t.Fatalf("first page = %+v %v", first, err)
	}
	all.Cursor = first.NextCursor
	if rest, err := e.engine.ListMemoriesPage(e.ctx, scopeA, all); err != nil || len(rest.Memories) != 1 || rest.Memories[0].ID != list[2].ID || rest.NextCursor != "" {
		t.Fatalf("last page = %+v %v", rest, err)
	}
	if _, err := e.engine.ListMemoriesPage(e.ctx, scopeA, tangent.MemoryQuery{Cursor: "garbage"}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("bad cursor: %v", err)
	}
	if _, err := e.engine.GetMemory(e.ctx, scopeB, other.ID); domain.CodeOf(err) != domain.CodeMemoryNotFound {
		t.Fatalf("another tenant: %v", err)
	}
}

const unknownLine = "00000000-0000-4000-8000-0000000000ff"

func TestMemory_EveryTurnRecallsTheRelevantOnesIntoThePreview(t *testing.T) {
	e, _ := memoryEnv(t, tangent.ModeManual, tangent.MemoryConfig{})
	main := e.mainLine()
	if _, err := e.engine.CreateMemory(e.ctx, scopeA, tangent.MemoryCreate{Memory: domain.MemoryInput{Kind: domain.MemoryDecision, Text: "The NAS uses a ZFS mirror"}, SourceLineID: main.ID}); err != nil {
		t.Fatal(err)
	}
	other := e.mainLine()
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, other.ID, "Should the NAS use ZFS?")
	if err != nil || len(preview.Memories) != 1 || preview.Memories[0].Memory.Text != "The NAS uses a ZFS mirror" {
		t.Fatalf("preview = %+v %v", preview.Memories, err)
	}
	block := ""
	for _, s := range preview.Prompt.Trailing {
		if s.Key == domain.SectionMemory {
			block = s.Body
		}
	}
	if !strings.Contains(block, "> [decision] The NAS uses a ZFS mirror (from: main)") {
		t.Fatalf("the trailing block = %q", block)
	}
	if unrelated, _ := e.engine.PreviewTurn(e.ctx, scopeA, other.ID, "Bake bread?"); len(unrelated.Memories) != 0 {
		t.Fatalf("nothing relevant: %+v", unrelated.Memories)
	}
	quiet, _ := memoryEnv(t, tangent.ModeManual, tangent.MemoryConfig{NoTurnRecall: true})
	line := quiet.mainLine()
	if _, err := quiet.engine.CreateMemory(quiet.ctx, scopeA, tangent.MemoryCreate{Memory: domain.MemoryInput{Kind: domain.MemoryFact, Text: "ZFS NAS"}}); err != nil {
		t.Fatal(err)
	}
	if p, _ := quiet.engine.PreviewTurn(quiet.ctx, scopeA, line.ID, "ZFS NAS?"); len(p.Memories) != 0 {
		t.Fatalf("NoTurnRecall: %+v", p.Memories)
	}
}

const extractReply = domain.MemoryExtractMarker + `{"memories":[{"action":"add","kind":"decision","text":"Use a ZFS mirror for the NAS","importance":8}]}`

func TestMemory_SuggestExtractsAfterAMergeIntoTheInbox(t *testing.T) {
	e, sink := memoryEnv(t, tangent.ModeSuggest, tangent.MemoryConfig{})
	main, branch := e.branchWithTurn("Disks")
	merged := e.mergeWithCard(branch.Line.ID, domain.BranchCard{Question: "Which layout?", Conclusion: "A ZFS mirror"})
	_ = merged
	jobs := jobsOf(tangent.JobKindMemoryExtract, sink.jobs...)
	if len(jobs) != 1 || !strings.Contains(jobs[0].Prompt.UserMessage, "## Source (card)") || !strings.Contains(jobs[0].Prompt.UserMessage, "A ZFS mirror") {
		t.Fatalf("one extraction after the merge: %+v", sink.jobs)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, extractReply, nil); err != nil {
		t.Fatal(err)
	}
	changed := e.events.OfType(tangent.EventSuggestionChanged)
	if len(changed) != 1 {
		t.Fatalf("events = %v", e.events.Types())
	}
	s := changed[0].Data.(tangent.SuggestionChange).Suggestion
	if s.Kind != tangent.SuggestionKindMemory || s.RootLineID != main.ID {
		t.Fatalf("suggestion = %+v", s)
	}
	accepted, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, json.RawMessage(`{"importance":9}`))
	if err != nil {
		t.Fatal(err)
	}
	m := accepted.Result.(tangent.MemoryAccepted).Memory
	if m.Text != "Use a ZFS mirror for the NAS" || m.Importance != 9 || !m.AIDrafted || m.Source.LeafLineID != branch.Line.ID || m.Source.Label != "Disks" {
		t.Fatalf("memory = %+v", m)
	}
}

func TestMemory_AutoWritesAndUpdatesSupersede(t *testing.T) {
	e, sink := memoryEnv(t, tangent.ModeAuto, tangent.MemoryConfig{})
	main := e.mainLine()
	old, _ := e.engine.CreateMemory(e.ctx, scopeA, tangent.MemoryCreate{Memory: domain.MemoryInput{Kind: domain.MemoryDecision, Text: "Use Btrfs for the NAS"}})
	if _, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: "add", Section: domain.NoteSectionDecided, Text: "ZFS for the NAS after all"}, {Op: "add", Section: domain.NoteSectionFact, Text: "ignored"}}); err != nil {
		t.Fatal(err)
	}
	jobs := jobsOf(tangent.JobKindMemoryExtract, sink.jobs...)
	if len(jobs) != 1 || !strings.Contains(jobs[0].Prompt.UserMessage, "ZFS for the NAS after all") || strings.Contains(jobs[0].Prompt.UserMessage, "ignored") ||
		!strings.Contains(jobs[0].Prompt.UserMessage, "> K1 [decision]: Use Btrfs for the NAS") {
		t.Fatalf("an extraction of the decided note, shown the related memory: %+v", sink.jobs)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, domain.MemoryExtractMarker+`{"memories":[{"action":"update","target":"K1","kind":"decision","text":"Use ZFS for the NAS","importance":7}]}`, nil); err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventMemoryChanged)
	got, _ := e.engine.GetMemory(e.ctx, scopeA, old.ID)
	if got.Status != domain.MemorySuperseded || got.SupersededBy == "" {
		t.Fatalf("the update superseded it: %+v", got)
	}
	leafJobs := len(sink.jobs)
	_, branch := e.branchWithTurn("Fans")
	if _, err := e.engine.PutLeaf(e.ctx, scopeA, branch.Line.ID, domain.LeafInput{Kind: domain.LeafKindConclusion, Line: "Quiet fans matter"}); err != nil {
		t.Fatal(err)
	}
	if got := jobsOf(tangent.JobKindMemoryExtract, sink.jobs[leafJobs:]...); len(got) != 1 || !strings.Contains(got[0].Prompt.UserMessage, "## Source (leaf)") {
		t.Fatalf("a confirmed leaf starts an extraction: %+v", sink.jobs[leafJobs:])
	}
}

func TestMemory_AFailedExtractionPublishesJobFailed(t *testing.T) {
	e, sink := memoryEnv(t, tangent.ModeAuto, tangent.MemoryConfig{})
	main := e.mainLine()
	if _, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: "add", Section: domain.NoteSectionDecided, Text: "Something"}}); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobsOf(tangent.JobKindMemoryExtract, sink.jobs...)[0].ID, "no marker", nil); err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventJobFailed)
}

func TestMemory_ConsolidationProposesAMerge(t *testing.T) {
	e, sink := memoryEnv(t, tangent.ModeSuggest, tangent.MemoryConfig{})
	main := e.mainLine()
	a, _ := e.engine.CreateMemory(e.ctx, scopeA, tangent.MemoryCreate{Memory: domain.MemoryInput{Kind: domain.MemoryDecision, Text: "Use a ZFS mirror"}, SourceLineID: main.ID})
	b, _ := e.engine.CreateMemory(e.ctx, scopeA, tangent.MemoryCreate{Memory: domain.MemoryInput{Kind: domain.MemoryDecision, Text: "use a zfs mirror"}, SourceLineID: main.ID})
	report, err := e.engine.Maintain(e.ctx)
	if err != nil || report.Tasks[tangent.TaskConsolidateMemories] != 1 {
		t.Fatalf("report = %+v %v", report, err)
	}
	jobs := jobsOf(tangent.JobKindMemoryConsolidate, sink.jobs...)
	if len(jobs) != 1 || !strings.Contains(jobs[0].Prompt.UserMessage, "> A [decision]") {
		t.Fatalf("jobs = %+v", sink.jobs)
	}
	if again, _ := e.engine.Maintain(e.ctx); again.Tasks[tangent.TaskConsolidateMemories] != 0 {
		t.Fatal("a pair with a job is not picked again")
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, domain.MemoryConsolidateMarker+`{"action":"merge","kind":"decision","text":"Use a ZFS mirror","importance":7,"reason":"the same"}`, nil); err != nil {
		t.Fatal(err)
	}
	s := e.events.OfType(tangent.EventSuggestionChanged)[0].Data.(tangent.SuggestionChange).Suggestion
	accepted, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	result := accepted.Result.(tangent.MemoryAccepted)
	if len(result.Superseded) != 2 || result.Memory.Text != "Use a ZFS mirror" {
		t.Fatalf("result = %+v", result)
	}
	for _, id := range []string{a.ID, b.ID} {
		if m, _ := e.engine.GetMemory(e.ctx, scopeA, id); m.Status != domain.MemorySuperseded {
			t.Fatalf("superseded = %+v", m)
		}
	}
}

func TestMemory_OffRefuses(t *testing.T) {
	policy := &switchPolicy{off: map[string]bool{}}
	e, _ := memoryEnv(t, tangent.ModeManual, tangent.MemoryConfig{}, tangent.WithFeaturePolicy(policy))
	policy.set(tangent.FeatureMemory, true)
	if _, err := e.engine.SearchMemories(e.ctx, scopeA, tangent.MemorySearch{Query: "x"}); domain.CodeOf(err) != domain.CodeFeatureDisabled {
		t.Fatalf("off: %v", err)
	}
	if _, err := e.engine.ListMemories(e.ctx, scopeA, tangent.MemoryQuery{}); domain.CodeOf(err) != domain.CodeFeatureDisabled {
		t.Fatalf("off: %v", err)
	}
	if _, err := e.engine.ListMemoriesPage(e.ctx, scopeA, tangent.MemoryQuery{}); domain.CodeOf(err) != domain.CodeFeatureDisabled {
		t.Fatalf("off: %v", err)
	}
}

// brokenEmbedder fails, or (shape) answers with vectors of the wrong size.
type brokenEmbedder struct{ shape bool }

func (b brokenEmbedder) Dim() int { return 8 }

func (b brokenEmbedder) Embed(_ context.Context, texts []string) ([][]float32, error) {
	if b.shape {
		return [][]float32{{1}}, nil
	}
	return nil, errors.New("the embedding service is down")
}

// A failing Embedder fails the operator's writes and searches with
// embedder_unavailable (they need a vector), but a turn and a merge go on
// without their memories.
func TestMemory_AFailingEmbedderNeverFailsATurnOrAMerge(t *testing.T) {
	for _, broken := range []brokenEmbedder{{}, {shape: true}} {
		e, sink := memoryEnv(t, tangent.ModeSuggest, tangent.MemoryConfig{Embedder: broken})
		main := e.mainLine()
		_, err := e.engine.CreateMemory(e.ctx, scopeA, tangent.MemoryCreate{Memory: domain.MemoryInput{Kind: domain.MemoryFact, Text: "x"}})
		if domain.CodeOf(err) != domain.CodeEmbedderUnavailable || strings.Contains(err.Error(), "down") {
			t.Fatalf("%+v: a memory needs its vector, and the cause is only logged: %v", broken, err)
		}
		if _, err := e.engine.SearchMemories(e.ctx, scopeA, tangent.MemorySearch{Query: "x"}); domain.CodeOf(err) != domain.CodeEmbedderUnavailable {
			t.Fatalf("%+v: a search needs its vector: %v", broken, err)
		}
		if p, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "Which NAS?"); err != nil || len(p.Memories) != 0 {
			t.Fatalf("%+v: the preview goes on: %+v %v", broken, p.Memories, err)
		}
		e.turn(main.ID, "Which NAS?", "A small one.")
		_, branch := e.branchWithTurn("Disks")
		e.mergeWithCard(branch.Line.ID, domain.BranchCard{Question: "Which layout?", Conclusion: "A ZFS mirror"})
		if jobs := jobsOf(tangent.JobKindMemoryExtract, sink.jobs...); len(jobs) != 0 {
			t.Fatalf("%+v: no extraction without a vector: %+v", broken, jobs)
		}
	}
}

// A branch discarded with a leaf is a source; without a message, the
// branch's purpose is what a turn recalls for.
func TestMemory_ADiscardWithALeafIsASourceAndAPurposeRecalls(t *testing.T) {
	e, sink := memoryEnv(t, tangent.ModeSuggest, tangent.MemoryConfig{})
	_, branch := e.branchWithTurn("Quiet NAS fans")
	if _, err := e.engine.CreateMemory(e.ctx, scopeA, tangent.MemoryCreate{Memory: domain.MemoryInput{Kind: domain.MemoryLesson, Text: "Quiet NAS fans are worth the price"}}); err != nil {
		t.Fatal(err)
	}
	if p, err := e.engine.PreviewTurn(e.ctx, scopeA, branch.Line.ID, ""); err != nil || len(p.Memories) != 1 {
		t.Fatalf("the purpose recalls: %+v %v", p.Memories, err)
	}
	leaf := domain.LeafInput{Kind: domain.LeafKindDeadEnd, Line: "Fan swaps void the warranty"}
	if _, err := e.engine.DiscardBranchWith(e.ctx, scopeA, branch.Line.ID, tangent.DiscardInput{Leaf: &leaf}); err != nil {
		t.Fatal(err)
	}
	jobs := jobsOf(tangent.JobKindMemoryExtract, sink.jobs...)
	if len(jobs) != 1 || !strings.Contains(jobs[0].Prompt.UserMessage, "## Source (leaf)") || !strings.Contains(jobs[0].Prompt.UserMessage, "Fan swaps void the warranty") {
		t.Fatalf("one extraction from the leaf: %+v", sink.jobs)
	}
}
