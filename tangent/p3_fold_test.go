package tangent_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// foldEnv is an engine with notes, chapters, leaf and fold in mode.
func foldEnv(t *testing.T, mode tangent.Mode, opts ...tangent.Option) *env {
	t.Helper()
	return newEnvWith(t, []tangent.Feature{tangent.Notes(), tangent.Chapters(), tangent.Leaf(tangent.ModeManual), tangent.Fold(mode)}, opts...)
}

// exchanges runs n turns on the line and returns the messages they wrote.
func (e *env) exchanges(lineID string, n int) []domain.Message {
	e.t.Helper()
	for i := range n {
		e.turn(lineID, fmt.Sprintf("question %d", i), fmt.Sprintf("answer %d", i))
	}
	messages, err := e.engine.ListMessages(e.ctx, scopeA, lineID, 0, 500)
	if err != nil {
		e.t.Fatal(err)
	}
	return messages
}

// historyTexts are the contents of a prompt's history entries.
func historyTexts(p domain.Prompt) []string {
	out := []string{}
	for _, entry := range p.History {
		out = append(out, entry.Content)
	}
	return out
}

func TestFold_ASummaryStandsForItsMessagesInThePrompt(t *testing.T) {
	e := foldEnv(t, tangent.ModeManual)
	main := e.mainLine()
	m := e.exchanges(main.ID, 3)
	e.rollsBack("create fold", func(opt tangent.TxOption) error {
		_, err := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[0].ID, ToMessageID: m[3].ID, Summary: "x"}, opt)
		return err
	})
	e.events.Reset()
	created, err := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[0].ID, ToMessageID: m[3].ID, Summary: "We compared the first two options."})
	if err != nil || created.Job != nil || created.Fold.Status != domain.FoldActive || created.Fold.MessageCount != 4 {
		t.Fatalf("created = %+v %v", created, err)
	}
	e.wantTypes(tangent.EventFoldChanged)
	change := e.events.OfType(tangent.EventFoldChanged)[0].Data.(tangent.FoldChange)
	if change.LineID != main.ID || change.RootLineID != main.ID || change.Fold.ID != created.Fold.ID {
		t.Fatalf("change = %+v", change)
	}
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next")
	if err != nil {
		t.Fatal(err)
	}
	texts := historyTexts(preview.Prompt)
	if len(texts) != 3 || !strings.Contains(texts[0], "Folded part of this conversation (4 messages)") || !strings.Contains(texts[0], "> We compared the first two options.") || texts[1] != "question 2" {
		t.Fatalf("history = %q", texts)
	}
	if len(preview.Folds) != 1 || preview.Folds[0].FoldID != created.Fold.ID || preview.Folds[0].Messages != 4 {
		t.Fatalf("the preview names the fold: %+v", preview.Folds)
	}
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "next"})
	if err != nil || !strings.Contains(turn.Prompt.History[0].Content, "Folded part") {
		t.Fatalf("the turn's prompt is folded too: %+v %v", turn.Prompt.History, err)
	}
	if _, err := e.engine.CancelTurn(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	list, err := e.engine.ListFolds(e.ctx, scopeA, main.ID)
	if err != nil || len(list.Folds) != 1 {
		t.Fatalf("list = %+v %v", list, err)
	}
	e.events.Reset()
	removed, err := e.engine.RemoveFold(e.ctx, scopeA, created.Fold.ID)
	if err != nil || removed.Status != domain.FoldRemoved {
		t.Fatalf("removed = %+v %v", removed, err)
	}
	e.wantTypes(tangent.EventFoldChanged)
	if after, _ := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next"); len(after.Folds) != 0 || strings.Contains(strings.Join(historyTexts(after.Prompt), "\n"), "Folded") {
		t.Fatalf("removed: the messages are back: %+v", after.Folds)
	}
}

func TestFold_ADraftIsWrittenByAJob(t *testing.T) {
	e := foldEnv(t, tangent.ModeManual)
	main := e.mainLine()
	m := e.exchanges(main.ID, 3)
	created, err := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[0].ID, ToMessageID: m[1].ID})
	if err != nil || created.Fold.Status != domain.FoldDrafting || created.Job == nil || created.Job.Kind != tangent.JobKindFoldSummary ||
		!strings.Contains(created.Job.Prompt.UserMessage, "> operator: question 0") || !strings.Contains(created.Job.Prompt.UserMessage, domain.FoldSummaryMarker) {
		t.Fatalf("created = %+v %v", created, err)
	}
	if preview, _ := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "x"); len(preview.Folds) != 0 {
		t.Fatal("a drafting fold does not apply")
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, created.Job.ID, domain.FoldSummaryMarker+`{"summary":"The first exchange."}`, nil); err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventFoldChanged)
	if fold := e.events.OfType(tangent.EventFoldChanged)[0].Data.(tangent.FoldChange).Fold; fold.Status != domain.FoldActive || !fold.AIDrafted || fold.Summary != "The first exchange." {
		t.Fatalf("fold = %+v", fold)
	}
	failing, _ := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[2].ID, ToMessageID: m[3].ID})
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, failing.Job.ID, "", fmt.Errorf("down")); err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventFoldChanged, tangent.EventJobFailed)
	timed, _ := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[4].ID, ToMessageID: m[5].ID})
	e.exec(`UPDATE tangent_job SET created_at = now() - interval '1 hour' WHERE id = $1`, timed.Job.ID)
	e.events.Reset()
	if _, err := e.engine.FailStaleJobs(e.ctx); err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventFoldChanged, tangent.EventJobFailed)
	if got := e.events.OfType(tangent.EventFoldChanged)[0].Data.(tangent.FoldChange).Fold.Status; got != domain.FoldFailed {
		t.Fatalf("timed out: %s", got)
	}
}

func TestFold_AppliesBeforeTheFisheye(t *testing.T) {
	e := newEnvWith(t, []tangent.Feature{tangent.Leaf(tangent.ModeManual), tangent.Fisheye(), tangent.Fold(tangent.ModeManual)})
	main := e.mainLine()
	m := e.exchanges(main.ID, 3)
	created, err := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[0].ID, ToMessageID: m[3].ID, Summary: "Early part."})
	if err != nil {
		t.Fatal(err)
	}
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next")
	if err != nil || preview.Fisheye == nil || len(preview.Folds) != 1 {
		t.Fatalf("preview = %+v %v", preview, err)
	}
	kinds := map[string]string{}
	for _, item := range preview.Fisheye.Items {
		kinds[item.ID] = item.Kind
	}
	if kinds[created.Fold.ID] != domain.FisheyeItemFold || kinds[m[0].ID] != "" || len(preview.Fisheye.Items) != 3 {
		t.Fatalf("the fisheye weighs the fold, not its messages: %+v", preview.Fisheye.Items)
	}
}

func TestFold_AMoveTakesTheFoldAlong(t *testing.T) {
	e := foldEnv(t, tangent.ModeManual)
	main := e.mainLine()
	m := e.exchanges(main.ID, 3)
	created, _ := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[2].ID, ToMessageID: m[5].ID, Summary: "The tail."})
	e.events.Reset()
	moved, err := e.engine.MoveToBranch(e.ctx, scopeA, main.ID, tangent.MoveInput{Count: 4, Purpose: "tail"})
	if err != nil {
		t.Fatal(err)
	}
	changes := e.events.OfType(tangent.EventFoldChanged)
	if len(changes) != 1 || changes[0].Data.(tangent.FoldChange).Fold.LineID != moved.Line.ID || changes[0].Data.(tangent.FoldChange).Fold.ID != created.Fold.ID {
		t.Fatalf("the fold moved: %v", e.events.Types())
	}
	if preview, _ := e.engine.PreviewTurn(e.ctx, scopeA, moved.Line.ID, "x"); len(preview.Folds) != 1 {
		t.Fatalf("the branch's prompt applies it: %+v", preview.Folds)
	}
}

func TestFold_OffCreatesNothingAndThePromptIsWhole(t *testing.T) {
	policy := &switchPolicy{off: map[string]bool{}}
	e := foldEnv(t, tangent.ModeManual, tangent.WithFeaturePolicy(policy))
	main := e.mainLine()
	m := e.exchanges(main.ID, 2)
	if _, err := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[0].ID, ToMessageID: m[1].ID, Summary: "s"}); err != nil {
		t.Fatal(err)
	}
	policy.set(tangent.FeatureFold, true)
	if _, err := e.engine.ListFolds(e.ctx, scopeA, main.ID); domain.CodeOf(err) != domain.CodeFeatureDisabled {
		t.Fatalf("off: %v", err)
	}
	if preview, _ := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "x"); len(preview.Folds) != 0 || len(preview.Prompt.History) != 4 {
		t.Fatalf("off: the prompt is whole: %+v", preview.Prompt.History)
	}
	policy.set(tangent.FeatureFold, false)
	if preview, _ := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "x"); len(preview.Folds) != 1 {
		t.Fatal("on again: the stored fold applies")
	}
}

// suggestLimits makes a chapter of 4 messages worth folding, looked for
// every second reply.
func suggestLimits() domain.Limits {
	l := domain.DefaultLimits()
	l.Fold.SuggestEvery, l.Fold.SuggestMinMessages, l.Fold.SuggestMinTokens = 2, 4, 1
	return l
}

func TestFold_SuggestProposesAClosedChapter(t *testing.T) {
	e := foldEnv(t, tangent.ModeSuggest, tangent.WithLimits(suggestLimits()))
	main := e.mainLine()
	m := e.exchanges(main.ID, 3)
	if _, err := e.engine.AddMilestone(e.ctx, scopeA, main.ID, tangent.MilestoneInput{MessageID: m[4].ID, Title: "Disks"}); err != nil {
		t.Fatal(err)
	}
	done := e.turn(main.ID, "go on", "going")
	jobs := jobsOf(tangent.JobKindFoldSuggest, done.Jobs...)
	if len(jobs) != 1 || !strings.Contains(jobs[0].Prompt.UserMessage, "> operator: question 0") || strings.Contains(jobs[0].Prompt.UserMessage, "go on") {
		t.Fatalf("one fold_suggest job over the first chapter: %+v", done.Jobs)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, domain.FoldSummaryMarker+`{"summary":"How it started."}`, nil); err != nil {
		t.Fatal(err)
	}
	changed := e.events.OfType(tangent.EventSuggestionChanged)
	if len(changed) != 1 {
		t.Fatalf("events = %v", e.events.Types())
	}
	s := changed[0].Data.(tangent.SuggestionChange).Suggestion
	var payload tangent.FoldSuggestion
	if err := json.Unmarshal(s.Payload, &payload); err != nil || s.Kind != tangent.SuggestionKindFold || payload.FromMessageID != m[0].ID || payload.ToMessageID != m[3].ID ||
		payload.Summary != "How it started." || payload.MessageCount != 4 || payload.Title == "" {
		t.Fatalf("suggestion = %+v payload %+v %v", s, payload, err)
	}
	accepted, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	fold := accepted.Result.(tangent.FoldAccepted).Fold
	if fold.Status != domain.FoldActive || !fold.AIDrafted || fold.Summary != "How it started." || fold.FromMessageID != m[0].ID {
		t.Fatalf("fold = %+v", fold)
	}
	e.turn(main.ID, "more", "more")
	if later := e.turn(main.ID, "still more", "more"); len(jobsOf(tangent.JobKindFoldSuggest, later.Jobs...)) != 0 {
		t.Fatal("nothing left to propose")
	}
}

func TestFold_ADismissedChapterIsNotProposedAgain(t *testing.T) {
	e := foldEnv(t, tangent.ModeAuto, tangent.WithLimits(suggestLimits()))
	main := e.mainLine()
	m := e.exchanges(main.ID, 3)
	if _, err := e.engine.AddMilestone(e.ctx, scopeA, main.ID, tangent.MilestoneInput{MessageID: m[4].ID, Title: "Next"}); err != nil {
		t.Fatal(err)
	}
	done := e.turn(main.ID, "go on", "going")
	jobs := jobsOf(tangent.JobKindFoldSuggest, done.Jobs...)
	if len(jobs) != 1 {
		t.Fatalf("auto proposes like suggest: %+v", done.Jobs)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, domain.FoldSummaryMarker+`{"summary":"Start."}`, nil); err != nil {
		t.Fatal(err)
	}
	s := e.events.OfType(tangent.EventSuggestionChanged)[0].Data.(tangent.SuggestionChange).Suggestion
	if _, err := e.engine.DismissSuggestion(e.ctx, scopeA, s.ID); err != nil {
		t.Fatal(err)
	}
	e.turn(main.ID, "one", "two")
	if again := e.turn(main.ID, "three", "four"); len(jobsOf(tangent.JobKindFoldSuggest, again.Jobs...)) != 0 {
		t.Fatalf("a dismissed chapter is not proposed again: %+v", again.Jobs)
	}
}

func TestFold_TheOperatorRewritesASummary(t *testing.T) {
	e := foldEnv(t, tangent.ModeManual)
	main := e.mainLine()
	m := e.exchanges(main.ID, 3)
	drafted, err := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[0].ID, ToMessageID: m[1].ID})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.engine.FinishJob(e.ctx, drafted.Job.ID, domain.FoldSummaryMarker+`{"summary":"AI words."}`, nil); err != nil {
		t.Fatal(err)
	}
	e.rollsBack("update fold", func(opt tangent.TxOption) error {
		_, err := e.engine.UpdateFold(e.ctx, scopeA, drafted.Fold.ID, "x", opt)
		return err
	})
	e.events.Reset()
	updated, err := e.engine.UpdateFold(e.ctx, scopeA, drafted.Fold.ID, "  My words.  ")
	if err != nil || updated.Summary != "My words." || updated.AIDrafted || updated.Status != domain.FoldActive || updated.TokensSummary != domain.EstimateTokens("My words.") {
		t.Fatalf("updated = %+v %v", updated, err)
	}
	e.wantTypes(tangent.EventFoldChanged)
	failing, _ := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[2].ID, ToMessageID: m[3].ID})
	if err := e.engine.FinishJob(e.ctx, failing.Job.ID, "", fmt.Errorf("down")); err != nil {
		t.Fatal(err)
	}
	if fixed, err := e.engine.UpdateFold(e.ctx, scopeA, failing.Fold.ID, "Written by hand."); err != nil || fixed.Status != domain.FoldActive {
		t.Fatalf("a failed draft is fixed by hand: %+v %v", fixed, err)
	}
	if _, err := e.engine.UpdateFold(e.ctx, scopeA, failing.Fold.ID, " "); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("empty: %v", err)
	}
	if _, err := e.engine.UpdateFold(e.ctx, scopeA, failing.Fold.ID, strings.Repeat("s", 1001)); domain.CodeOf(err) != domain.CodeTooLong {
		t.Fatalf("too long: %v", err)
	}
	if _, err := e.engine.RemoveFold(e.ctx, scopeA, failing.Fold.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.UpdateFold(e.ctx, scopeA, failing.Fold.ID, "late"); domain.CodeOf(err) != domain.CodeFoldNotFound {
		t.Fatalf("removed: %v", err)
	}
	if _, err := e.engine.UpdateFold(e.ctx, scopeB, drafted.Fold.ID, "theirs"); domain.CodeOf(err) != domain.CodeFoldNotFound {
		t.Fatalf("another tenant: %v", err)
	}
}

func TestFold_AnEditedDraftIsNotOverwrittenByItsJob(t *testing.T) {
	e := foldEnv(t, tangent.ModeManual)
	main := e.mainLine()
	m := e.exchanges(main.ID, 2)
	drafted, _ := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[0].ID, ToMessageID: m[1].ID})
	if _, err := e.engine.UpdateFold(e.ctx, scopeA, drafted.Fold.ID, "Mine first."); err != nil {
		t.Fatal(err)
	}
	if err := e.engine.FinishJob(e.ctx, drafted.Job.ID, domain.FoldSummaryMarker+`{"summary":"Late AI."}`, nil); err != nil {
		t.Fatal(err)
	}
	list, _ := e.engine.ListFolds(e.ctx, scopeA, main.ID)
	if list.Folds[0].Summary != "Mine first." || list.Folds[0].AIDrafted {
		t.Fatalf("the operator's summary stays: %+v", list.Folds[0])
	}
}
