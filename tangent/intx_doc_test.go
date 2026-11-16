package tangent_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// intxRow is a row of the guide's InTx table: "| `Method` | types |".
var intxRow = regexp.MustCompile("(?m)^\\| `([A-Z][A-Za-z]+)` \\| (.+) \\|$")

// intxTable reads the InTx result table of docs/EMBEDDING.md §4.4.
func intxTable(t *testing.T) map[string]string {
	t.Helper()
	raw, err := os.ReadFile("../docs/EMBEDDING.md")
	if err != nil {
		t.Fatal(err)
	}
	doc := string(raw)
	start := strings.Index(doc, "### 4.4 ")
	end := strings.Index(doc[start+1:], "\n### ")
	if start < 0 || end < 0 {
		t.Fatal("no §4.4 in the guide")
	}
	rows := map[string]string{}
	for _, m := range intxRow.FindAllStringSubmatch(doc[start:start+1+end], -1) {
		rows[m[1]] = m[2]
	}
	return rows
}

// capture is an InTx hook that records the result type a write passes.
type capture struct{ got map[string]string }

func (c *capture) opt(method string) tangent.TxOption {
	return tangent.InTx(func(_ context.Context, _ store.Tx, result any) error {
		c.got[method] = fmt.Sprintf("%T", result)
		return nil
	})
}

// TestInTx_TheGuideListsTheResultEveryWritePasses runs every Engine write
// that takes a TxOption with a hook, and checks the guide's table names the
// type the hook received (and lists no method that is not run here).
func TestInTx_TheGuideListsTheResultEveryWritePasses(t *testing.T) {
	e := newEnvWith(t, append(p2Features(tangent.ModeSuggest), tangent.Group(tangent.ModeManual), tangent.Ibis(tangent.ModeManual), tangent.Fold(tangent.ModeManual), tangent.Diverge(tangent.ModeManual), tangent.Memo()))
	c := &capture{got: map[string]string{}}
	runIntxLines(t, e, c)
	runIntxBranches(t, e, c)
	runIntxP1(t, e, c)
	runIntxP2(t, e, c)
	runIntxGroups(t, e, c)
	runIntxP3(t, e, c)
	runIntxDiverge(t, e, c)
	memory := t.Run("memory", func(t *testing.T) { runIntxMemory(t, c) })
	table := intxTable(t)
	for method, got := range c.got {
		if row, ok := table[method]; !ok || !strings.Contains(row, "`"+got+"`") {
			t.Errorf("%s passes %s; the guide's InTx table says %q", method, got, row)
		}
	}
	for method := range table {
		if _, ok := c.got[method]; !ok && (memory || !memoryMethods[method]) {
			t.Errorf("the guide lists %s, which this test does not run", method)
		}
	}
}

func must[T any](t *testing.T) func(T, error) T {
	return func(v T, err error) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
}

func runIntxLines(t *testing.T, e *env, c *capture) {
	line := must[domain.LineView](t)(e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: "t"}, c.opt("CreateLine")))
	title := "u"
	must[domain.LineView](t)(e.engine.UpdateLine(e.ctx, scopeA, line.ID, tangent.LinePatch{Title: &title}, c.opt("UpdateLine")))
	must[domain.LineView](t)(e.engine.MarkRead(e.ctx, scopeA, line.ID, c.opt("MarkRead")))
	turn := must[tangent.Turn](t)(e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"}, c.opt("BeginTurn")))
	must[tangent.CompletedTurn](t)(e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Error: "failed"}, c.opt("CompleteTurn")))
	retried := must[tangent.Turn](t)(e.engine.RetryTurn(e.ctx, scopeA, line.ID, c.opt("RetryTurn")))
	must[tangent.CancelledTurn](t)(e.engine.CancelTurn(e.ctx, scopeA, line.ID, c.opt("CancelTurn")))
	_ = retried
	e.turn(line.ID, "a long enough question", "a long enough answer")
	must[tangent.Job](t)(e.engine.StartSummary(e.ctx, scopeA, line.ID, c.opt("StartSummary")))
	notes := must[tangent.NotesWrite](t)(e.engine.ApplyNoteChanges(e.ctx, scopeA, line.ID, []domain.NoteChange{{Op: "add", Section: "fact", Text: "x"}}, c.opt("ApplyNoteChanges")))
	text := "y"
	must[tangent.NoteUpdate](t)(e.engine.UpdateNote(e.ctx, scopeA, line.ID, notes.Created[0].ID, tangent.NotePatch{Text: &text}, c.opt("UpdateNote")))
	must[tangent.NotesWrite](t)(e.engine.SupersedeNote(e.ctx, scopeA, line.ID, notes.Created[0].ID, tangent.NoteInput{Text: "z"}, c.opt("SupersedeNote")))
	reply := e.turn(line.ID, "q", "a")
	added := must[tangent.ChapterChange](t)(e.engine.AddMilestone(e.ctx, scopeA, line.ID, tangent.MilestoneInput{MessageID: reply.Message.ID, Title: "m"}, c.opt("AddMilestone")))
	must[string](t)(e.engine.DeleteMilestone(e.ctx, scopeA, line.ID, added.Cut.ID, c.opt("DeleteMilestone")))
	must[tangent.AppendedSystemMessage](t)(e.engine.AppendSystemMessage(e.ctx, scopeA, line.ID, tangent.SystemNotice{Content: "n"}, c.opt("AppendSystemMessage")))
	folder := "f"
	must[domain.LineView](t)(e.engine.UpdateLine(e.ctx, scopeA, line.ID, tangent.LinePatch{Folder: &folder}, c.opt("UpdateLine")))
	must[tangent.RenamedFolder](t)(e.engine.RenameFolder(e.ctx, scopeA, "f", "g", c.opt("RenameFolder")))
	must[tangent.ImportedLine](t)(e.engine.ImportLine(e.ctx, scopeA, tangent.ImportInput{
		Messages: []domain.ImportMessage{{ExternalID: "1", Role: "user", Content: "q"}, {Role: "assistant", Content: "a"}},
		Branches: []domain.ImportBranch{{AnchorExternalID: "1", Messages: []domain.ImportMessage{{Role: "assistant", Content: "b"}}}},
	}, c.opt("ImportLine")))
	must[[]domain.LineView](t)(e.engine.ArchiveTree(e.ctx, scopeA, line.ID, true, c.opt("ArchiveTree")))
	must[tangent.DeletedTree](t)(e.engine.DeleteTree(e.ctx, scopeA, line.ID, c.opt("DeleteTree")))
	batch := uuid.NewString()
	must[tangent.ImportedLine](t)(e.engine.ImportLine(e.ctx, scopeA, tangent.ImportInput{
		BatchID: batch, Messages: []domain.ImportMessage{{Role: "user", Content: "q"}, {Role: "assistant", Content: "a"}},
	}))
	must[tangent.DeletedImportBatch](t)(e.engine.DeleteImportBatch(e.ctx, scopeA, batch, false, c.opt("DeleteImportBatch")))
}

func runIntxBranches(t *testing.T, e *env, c *capture) {
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	created := must[tangent.CreatedBranch](t)(e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Purpose: "p", Kind: "investigate"}, c.opt("CreateBranch")))
	must[domain.BranchView](t)(e.engine.RenameBranch(e.ctx, scopeA, created.Line.ID, "p2", c.opt("RenameBranch")))
	e.turn(created.Line.ID, "q", "a")
	job := must[tangent.Job](t)(e.engine.StartDraft(e.ctx, scopeA, created.Line.ID, c.opt("StartDraft")))
	if err := e.engine.FinishJob(e.ctx, job.ID, "", fmt.Errorf("skip")); err != nil {
		t.Fatal(err)
	}
	detail := must[domain.BranchDetail](t)(e.engine.GetBranch(e.ctx, scopeA, created.Line.ID))
	must[tangent.MergedBranch](t)(e.engine.MergeBranch(e.ctx, scopeA, created.Line.ID, tangent.MergeInput{
		Card: domain.BranchCard{Question: "q", Conclusion: "c"}, ParentTipMessageID: detail.ParentTipMessageID,
	}, c.opt("MergeBranch")))
	must[tangent.UpdatedCard](t)(e.engine.UpdateBranchCard(e.ctx, scopeA, created.Line.ID, domain.BranchCard{Question: "q", Conclusion: "c2"}, c.opt("UpdateBranchCard")))
	discard := e.branch(main.ID, anchor.Message.ID, "d")
	must[domain.BranchView](t)(e.engine.DiscardBranch(e.ctx, scopeA, discard.Line.ID, c.opt("DiscardBranch")))
	with := e.branch(main.ID, anchor.Message.ID, "w")
	must[domain.BranchView](t)(e.engine.DiscardBranchWith(e.ctx, scopeA, with.Line.ID, tangent.DiscardInput{}, c.opt("DiscardBranchWith")))
	promote := e.branch(main.ID, anchor.Message.ID, "promote")
	e.turn(promote.Line.ID, "q", "a")
	must[tangent.PromotedBranch](t)(e.engine.PromoteBranch(e.ctx, scopeA, promote.Line.ID, c.opt("PromoteBranch")))
	e.turn(main.ID, "move me", "moved")
	must[tangent.MovedBranch](t)(e.engine.MoveToBranch(e.ctx, scopeA, main.ID, tangent.MoveInput{Count: 2, Purpose: "m"}, c.opt("MoveToBranch")))
	user, reply := e.exchange(main.ID, "extract me", "extracted")
	e.turn(main.ID, "stay", "stays")
	must[tangent.ExtractedBranch](t)(e.engine.ExtractToBranch(e.ctx, scopeA, main.ID, tangent.ExtractInput{
		FromMessageID: user.ID, ToMessageID: reply.ID, Purpose: "x",
	}, c.opt("ExtractToBranch")))
	source := e.mainLine()
	e.turn(source.ID, "attach me", "attached")
	must[tangent.AttachedLine](t)(e.engine.AttachLine(e.ctx, scopeA, main.ID, tangent.AttachInput{SourceLineID: source.ID}, c.opt("AttachLine")))
	runIntxB23(t, e, c)
}

// runIntxB23 keeps and continues an answered aside and deletes a discarded
// branch (B23).
func runIntxB23(t *testing.T, e *env, c *capture) {
	_, _, aside := e.answeredAside()
	must[domain.BranchView](t)(e.engine.KeepBranch(e.ctx, scopeA, aside.Line.ID, true, c.opt("KeepBranch")))
	continued := must[tangent.ContinuedAside](t)(e.engine.ContinueAside(e.ctx, scopeA, aside.Line.ID, tangent.ContinueAsideInput{}, c.opt("ContinueAside")))
	must[domain.BranchView](t)(e.engine.DiscardBranch(e.ctx, scopeA, continued.Line.ID))
	must[tangent.DeletedBranch](t)(e.engine.DeleteBranch(e.ctx, scopeA, continued.Line.ID, c.opt("DeleteBranch")))
}

func runIntxP1(t *testing.T, e *env, c *capture) {
	main, branch := e.branchWithTurn("p1")
	must[domain.Leaf](t)(e.engine.PutLeaf(e.ctx, scopeA, branch.Line.ID, domain.LeafInput{Kind: "answer", Line: "x"}, c.opt("PutLeaf")))
	must[domain.Leaf](t)(e.engine.DeleteLeaf(e.ctx, scopeA, branch.Line.ID, c.opt("DeleteLeaf")))
	must[tangent.Job](t)(e.engine.StartLeafDraft(e.ctx, scopeA, branch.Line.ID, c.opt("StartLeafDraft")))
	seed := must[domain.Seed](t)(e.engine.CreateSeed(e.ctx, scopeA, main.ID, tangent.SeedInput{Text: "a"}, c.opt("CreateSeed")))
	must[domain.Seed](t)(e.engine.DropSeed(e.ctx, scopeA, seed.ID, c.opt("DropSeed")))
	noted := must[domain.Seed](t)(e.engine.CreateSeed(e.ctx, scopeA, main.ID, tangent.SeedInput{Text: "b"}))
	must[tangent.NotedSeed](t)(e.engine.NoteSeed(e.ctx, scopeA, noted.ID, "", c.opt("NoteSeed")))
	expand := must[domain.Seed](t)(e.engine.CreateSeed(e.ctx, scopeA, main.ID, tangent.SeedInput{Text: "c"}))
	must[tangent.ExpandedSeed](t)(e.engine.ExpandSeed(e.ctx, scopeA, expand.ID, tangent.ExpandInput{}, c.opt("ExpandSeed")))
	must[tangent.CreatedSeeds](t)(e.engine.CreateSeeds(e.ctx, scopeA, main.ID, tangent.SeedsInput{Texts: []string{"d", "e"}}, c.opt("CreateSeeds")))
	accept := e.probed(main.ID, tangent.ProbeDirective)
	must[tangent.AcceptedSuggestion](t)(e.engine.AcceptSuggestion(e.ctx, scopeA, accept.ID, json.RawMessage(`{}`), c.opt("AcceptSuggestion")))
	dismiss := e.probed(branch.Line.ID, tangent.ProbeDirective)
	must[domain.Suggestion](t)(e.engine.DismissSuggestion(e.ctx, scopeA, dismiss.ID, c.opt("DismissSuggestion")))
	must[tangent.SuggestionList](t)(e.engine.DismissAllSuggestions(e.ctx, scopeA, main.ID, c.opt("DismissAllSuggestions")))
	memo := must[domain.Memo](t)(e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{Text: "m"}, c.opt("CreateMemo")))
	must[domain.Memo](t)(e.engine.UpdateMemo(e.ctx, scopeA, memo.ID, "m2", c.opt("UpdateMemo")))
	must[domain.Memo](t)(e.engine.DeleteMemo(e.ctx, scopeA, memo.ID, c.opt("DeleteMemo")))
	text := "t2"
	term := must[tangent.TermChange](t)(e.engine.CreateTerm(e.ctx, scopeA, main.ID, tangent.TermInput{Term: "t", Explanation: "x"}, c.opt("CreateTerm")))
	must[tangent.TermChange](t)(e.engine.UpdateTerm(e.ctx, scopeA, term.Term.ID, tangent.TermPatch{Explanation: &text}, c.opt("UpdateTerm")))
	must[tangent.TermChange](t)(e.engine.DeleteTerm(e.ctx, scopeA, term.Term.ID, c.opt("DeleteTerm")))
	must[tangent.SpunOff](t)(e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach}, c.opt("Spinoff")))
}

func runIntxP2(t *testing.T, e *env, c *capture) {
	main := e.mainLine()
	reply := e.turn(main.ID, "q", "a")
	other := e.mainLine()
	must[domain.Goal](t)(e.engine.PutGoal(e.ctx, scopeA, main.ID, "g", c.opt("PutGoal")))
	must[domain.Goal](t)(e.engine.DeleteGoal(e.ctx, scopeA, main.ID, c.opt("DeleteGoal")))
	must[tangent.Job](t)(e.engine.ProposeGoal(e.ctx, scopeA, main.ID, c.opt("ProposeGoal")))
	related := must[tangent.RelationChange](t)(e.engine.CreateRelation(e.ctx, scopeA, main.ID, tangent.RelationInput{To: tangent.RelationEnd{LineID: other.ID}}, c.opt("CreateRelation")))
	must[tangent.RelationChange](t)(e.engine.DeleteRelation(e.ctx, scopeA, main.ID, related.Link.ID, c.opt("DeleteRelation")))
	must[domain.Message](t)(e.engine.PinMessage(e.ctx, scopeA, reply.Message.ID, true, c.opt("PinMessage")))
}

func runIntxGroups(t *testing.T, e *env, c *capture) {
	main := e.mainLine()
	reply := e.turn(main.ID, "q", "a")
	other := e.mainLine()
	related := must[tangent.RelationChange](t)(e.engine.CreateRelation(e.ctx, scopeA, main.ID, tangent.RelationInput{To: tangent.RelationEnd{LineID: other.ID}}))
	must[tangent.RelationChange](t)(e.engine.UpdateRelation(e.ctx, scopeA, main.ID, related.Link.ID, "x", c.opt("UpdateRelation")))
	kind := domain.RelationKindSupports
	must[tangent.RelationChange](t)(e.engine.EditRelation(e.ctx, scopeA, main.ID, related.Link.ID, tangent.RelationEdit{RelationKind: &kind}, c.opt("EditRelation")))
	a, b := e.endedWithLeaf(main.ID, reply.Message.ID, "a", "x"), e.endedWithLeaf(main.ID, reply.Message.ID, "b", "y")
	group := must[tangent.GroupCreated](t)(e.engine.CreateGroup(e.ctx, scopeA, main.ID, tangent.GroupInput{MemberLineIDs: []string{a, b}, Title: "t"}, c.opt("CreateGroup")))
	must[tangent.Job](t)(e.engine.SummarizeGroup(e.ctx, scopeA, group.Group.ID, c.opt("SummarizeGroup")))
	must[domain.Group](t)(e.engine.RenameGroup(e.ctx, scopeA, group.Group.ID, "u", c.opt("RenameGroup")))
	must[domain.Group](t)(e.engine.DissolveGroup(e.ctx, scopeA, group.Group.ID, c.opt("DissolveGroup")))
	x, y := e.branch(main.ID, reply.Message.ID, "x"), e.branch(main.ID, reply.Message.ID, "y")
	must[tangent.CombinedBranches](t)(e.engine.CombineBranches(e.ctx, scopeA, main.ID, tangent.CombineInput{LineIDs: []string{x.Line.ID, y.Line.ID}, Purpose: "p"}, c.opt("CombineBranches")))
}

func runIntxP3(t *testing.T, e *env, c *capture) {
	main := e.mainLine()
	first := e.turn(main.ID, "q", "a")
	second := e.turn(main.ID, "q2", "a2")
	must[domain.Message](t)(e.engine.TagMessage(e.ctx, scopeA, first.Message.ID, domain.TagIdea, c.opt("TagMessage")))
	must[domain.Message](t)(e.engine.SetMessageTag(e.ctx, scopeA, first.Message.ID, tangent.TagInput{Kind: domain.TagIdea, Status: domain.TagStatusDraft}, c.opt("SetMessageTag")))
	must[domain.Message](t)(e.engine.UntagMessage(e.ctx, scopeA, first.Message.ID, c.opt("UntagMessage")))
	fold := must[tangent.FoldCreated](t)(e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: first.Message.ID, ToMessageID: second.Message.ID, Summary: "s"}, c.opt("CreateFold")))
	must[domain.Fold](t)(e.engine.UpdateFold(e.ctx, scopeA, fold.Fold.ID, "t", c.opt("UpdateFold")))
	must[domain.Fold](t)(e.engine.RemoveFold(e.ctx, scopeA, fold.Fold.ID, c.opt("RemoveFold")))
}

func runIntxDiverge(t *testing.T, e *env, c *capture) {
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	job := must[tangent.Job](t)(e.engine.StartDiverge(e.ctx, scopeA, main.ID, tangent.DivergeInput{AnchorMessageID: anchor.Message.ID, Count: 2}, c.opt("StartDiverge")))
	if err := e.engine.FinishJob(e.ctx, job.ID, directions("Box", "arena"), nil); err != nil {
		t.Fatal(err)
	}
	ids := e.byPurpose(main.ID, "Box", "arena")
	started := must[tangent.ConvergeStarted](t)(e.engine.Converge(e.ctx, scopeA, main.ID, tangent.ConvergeInput{LineIDs: ids}, c.opt("Converge")))
	if err := e.engine.FinishJob(e.ctx, started.Job.ID, convergeReply, nil); err != nil {
		t.Fatal(err)
	}
	must[tangent.DecidedComparison](t)(e.engine.DecideComparison(e.ctx, scopeA, started.Comparison.ID, tangent.DecideInput{LineID: ids[0]}, c.opt("DecideComparison")))
	other := e.mainLine()
	at := e.turn(other.ID, "q", "a")
	targets := []tangent.DivergeTarget{{Provider: "openai", Model: "gpt-5"}, {Provider: "anthropic", Model: "haiku"}}
	must[tangent.DivergedModels](t)(e.engine.DivergeModels(e.ctx, scopeA, other.ID, tangent.DivergeModelsInput{AnchorMessageID: at.Message.ID, Targets: targets}, c.opt("DivergeModels")))
}

// memoryMethods are run on a schema with the memory migration; a server
// without the vector extension skips them.
var memoryMethods = map[string]bool{"CreateMemory": true, "UpdateMemory": true, "SupersedeMemory": true}

func runIntxMemory(t *testing.T, c *capture) {
	e, _ := memoryEnv(t, tangent.ModeManual, tangent.MemoryConfig{})
	created := must[domain.Memory](t)(e.engine.CreateMemory(e.ctx, scopeA, tangent.MemoryCreate{Memory: domain.MemoryInput{Kind: domain.MemoryFact, Text: "x"}}, c.opt("CreateMemory")))
	importance := 3
	must[domain.Memory](t)(e.engine.UpdateMemory(e.ctx, scopeA, created.ID, tangent.MemoryPatch{Importance: &importance}, c.opt("UpdateMemory")))
	must[tangent.SupersededMemories](t)(e.engine.SupersedeMemory(e.ctx, scopeA, created.ID, domain.MemoryInput{Text: "y"}, c.opt("SupersedeMemory")))
}
