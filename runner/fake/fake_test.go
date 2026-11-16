package fake_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/tangent"
)

func turn(content string, deltas *[]domain.Delta) tangent.RunRequest {
	return tangent.RunRequest{
		System: "rules", Messages: []domain.ChatMessage{{Role: "user", Content: content}},
		OnDelta: func(d domain.Delta) { *deltas = append(*deltas, d) },
	}
}

func TestRun_EchoesTheOperatorInStreamedChunks(t *testing.T) {
	r := fake.New(fake.Config{ChunkRunes: 5})
	var deltas []domain.Delta
	got, err := r.Run(context.Background(), turn("What is a tangent?", &deltas))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.Content, "What is a tangent?") || got.Model != fake.DefaultModel || got.StopReason != "end_turn" {
		t.Fatalf("result = %+v", got)
	}
	joined := ""
	for _, d := range deltas {
		if d.Kind != domain.DeltaText || len([]rune(d.Text)) > 5 {
			t.Fatalf("delta = %+v", d)
		}
		joined += d.Text
	}
	if joined != got.Content || len(deltas) < 2 {
		t.Fatalf("the deltas add up to the reply: %q vs %q", joined, got.Content)
	}
	if got.Usage.InputTokens <= 0 || got.Usage.OutputTokens <= 0 {
		t.Fatalf("usage = %+v", got.Usage)
	}
}

func TestRun_DirectivesScriptFailuresRetriesReasoningAndSuggestions(t *testing.T) {
	r := fake.New(fake.Config{})
	var deltas []domain.Delta
	_, err := r.Run(context.Background(), turn("please [fake:error]", &deltas))
	var public *tangent.RunnerError
	if !errors.As(err, &public) || public.Public == "" {
		t.Fatalf("err = %v", err)
	}
	retried := 0
	req := turn("[fake:retry] [fake:reasoning] [fake:suggest]", &deltas)
	req.OnRetry = func(tangent.Retry) { retried++ }
	deltas = nil
	got, err := r.Run(context.Background(), req)
	if err != nil || retried != 1 || deltas[0].Kind != domain.DeltaReasoning {
		t.Fatalf("got %+v err %v retried %d deltas %+v", got, err, retried, deltas)
	}
	_, suggestions := domain.ExtractBranchSuggestions(got.Content, domain.DefaultLimits().Branch)
	if len(suggestions) != 1 {
		t.Fatalf("a [fake:suggest] reply carries a parseable suggestion: %q", got.Content)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.Run(ctx, turn("[fake:slow]", &deltas)); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled slow run ends with the context: %v", err)
	}
	slow := fake.New(fake.Config{SlowDelay: time.Millisecond, ChunkDelay: time.Microsecond})
	if _, err := slow.Run(context.Background(), turn("[fake:slow]", &deltas)); err != nil {
		t.Fatal(err)
	}
}

func TestRun_TopicAndChapterDirectivesEndTheReplyWithParseableLines(t *testing.T) {
	var deltas []domain.Delta
	got, err := fake.New(fake.Config{}).Run(context.Background(), turn("NAS? [fake:topic] [fake:chapter]", &deltas))
	if err != nil {
		t.Fatal(err)
	}
	text, topic := domain.ExtractTopicSummary(got.Content, domain.DefaultLimits().Text)
	text, chapter := domain.ExtractChapterCut(text, domain.DefaultLimits().Chapters)
	if topic != "Fake topic" || chapter != "Fake chapter" || strings.Contains(text, "[TOPIC]") || strings.Contains(text, "[CHAPTER]") {
		t.Fatalf("reply %q: topic %q chapter %q", got.Content, topic, chapter)
	}
}

func TestRun_AnswersJobsWithParseableOutput(t *testing.T) {
	r := fake.New(fake.Config{Model: "fake-x"})
	draft := tangent.RunRequest{Messages: []domain.ChatMessage{{Role: "user", Content: "Draft the card. Reply with " + domain.BranchCardMarker + " and JSON."}}}
	got, err := r.Run(context.Background(), draft)
	if err != nil {
		t.Fatal(err)
	}
	card, err := domain.ParseBranchDraft(got.Content)
	if err != nil || len(domain.CheckBranchCardShape(card)) != 0 || got.Model != "fake-x" {
		t.Fatalf("draft %q: %v", got.Content, err)
	}
	withNotes := tangent.RunRequest{Messages: []domain.ChatMessage{{Role: "user", Content: "Reply with " + domain.BranchCardMarker + "; noteChanges (optional)"}}}
	got, err = r.Run(context.Background(), withNotes)
	if err != nil {
		t.Fatal(err)
	}
	if _, changes, err := domain.ParseBranchDraftProposal(got.Content); err != nil || len(changes) != 1 || changes[0].Op != domain.NoteOpAdd {
		t.Fatalf("a draft asked for note proposals proposes one: %q %v", got.Content, err)
	}
	summary := tangent.RunRequest{Model: "m", Messages: []domain.ChatMessage{{Role: "user", Content: "Summarise. Answer with " + domain.SummaryMarker}}}
	got, err = r.Run(context.Background(), summary)
	if err != nil {
		t.Fatal(err)
	}
	if parsed, ok := domain.ParseSummary(got.Content); !ok || parsed.Topic == "" || got.Model != "m" {
		t.Fatalf("summary %q", got.Content)
	}
	leaf := tangent.RunRequest{Messages: []domain.ChatMessage{{Role: "user", Content: domain.BuildLeafDraftPrompt(domain.LeafDraftInput{Purpose: "p"})}}}
	if got, err = r.Run(context.Background(), leaf); err != nil {
		t.Fatal(err)
	}
	if parsed, err := domain.ParseLeafDraft(got.Content, domain.LeafLimits{}); err != nil || parsed.Kind != domain.LeafKindConclusion {
		t.Fatalf("leaf %q: %v", got.Content, err)
	}
	other := tangent.RunRequest{Messages: []domain.ChatMessage{{Role: "user", Content: "some other job"}}}
	if got, err = r.Run(context.Background(), other); err != nil || got.Content == "" {
		t.Fatalf("other job: %+v %v", got, err)
	}
	if got, err = r.Run(context.Background(), tangent.RunRequest{}); err != nil || got.Content == "" {
		t.Fatalf("an empty request is still answered: %+v %v", got, err)
	}
}

func TestRun_OnlyTheNewestParagraphCarriesDirectives(t *testing.T) {
	var deltas []domain.Delta
	req := turn("[fake:error] an earlier message\n\nthe new one", &deltas)
	got, err := fake.New(fake.Config{}).Run(context.Background(), req)
	if err != nil || got.Content != "Fake reply to: the new one" {
		t.Fatalf("got %q %v", got.Content, err)
	}
}

func TestRun_WaitAndJobErrorDirectives(t *testing.T) {
	r := fake.New(fake.Config{})
	var deltas []domain.Delta
	started := time.Now()
	if _, err := r.Run(context.Background(), turn("[fake:wait=30ms] hi", &deltas)); err != nil || time.Since(started) < 30*time.Millisecond {
		t.Fatalf("waited %v, err %v", time.Since(started), err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := r.Run(ctx, turn("[fake:wait=5s] hi", &deltas)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a cancelled wait ends: %v", err)
	}
	started = time.Now()
	capped := fake.New(fake.Config{MaxWait: 20 * time.Millisecond})
	if _, err := capped.Run(context.Background(), turn("[fake:wait=99h] hi", &deltas)); err != nil || time.Since(started) > 5*time.Second {
		t.Fatalf("a wait is capped: %v %v", time.Since(started), err)
	}
	if got, err := r.Run(context.Background(), turn("[fake:wait=nonsense] hi", &deltas)); err != nil || got.Content == "" {
		t.Fatalf("a wait that does not parse is ignored: %v", err)
	}
	job := tangent.RunRequest{Messages: []domain.ChatMessage{{Role: "user", Content: "Reply with " + domain.BranchCardMarker + " > [fake:job-error]"}}}
	var public *tangent.RunnerError
	if _, err := r.Run(context.Background(), job); !errors.As(err, &public) {
		t.Fatalf("a job whose prompt says [fake:job-error] fails: %v", err)
	}
}

func TestRun_AnswersTheGoalAndRelationJobs(t *testing.T) {
	r := fake.New(fake.Config{})
	job := func(prompt string) string {
		t.Helper()
		got, err := r.Run(context.Background(), tangent.RunRequest{Messages: []domain.ChatMessage{{Role: "user", Content: prompt}}})
		if err != nil {
			t.Fatal(err)
		}
		return got.Content
	}
	goal := job(domain.BuildGoalProposePrompt(domain.GoalProposeInput{Title: "t", Messages: []domain.Message{{Role: domain.RoleUser, Content: "q", Status: domain.MessageDone}}}))
	if text, err := domain.ParseGoalProposal(goal, domain.GoalLimits{}); err != nil || text == "" {
		t.Fatalf("goal %q: %v", goal, err)
	}
	limits := domain.DefaultLimits()
	calm := job(domain.BuildDriftCheckPrompt(domain.DriftCheckInput{Goal: "g", Messages: []domain.Message{{Role: domain.RoleUser, Content: "on topic", Status: domain.MessageDone}}}))
	if v, err := domain.ParseDriftCheck(calm, limits, true); err != nil || v.Drift {
		t.Fatalf("on topic %q: %+v %v", calm, v, err)
	}
	off := job(domain.BuildDriftCheckPrompt(domain.DriftCheckInput{Goal: "g", Messages: []domain.Message{{Role: domain.RoleUser, Content: "away " + fake.DirectiveDrift, Status: domain.MessageDone}}}))
	if v, err := domain.ParseDriftCheck(off, limits, true); err != nil || !v.Drift || v.Purpose == "" {
		t.Fatalf("drift %q: %+v %v", off, v, err)
	}
	related := job(domain.BuildRelationSuggestPrompt(domain.RelationSuggestInput{Branch: domain.RelationCandidate{Key: "B0", Purpose: "a"}, Others: []domain.RelationCandidate{{Key: "B1", Purpose: "b"}}}))
	if got, err := domain.ParseRelationSuggestions(related, map[string]bool{"B1": true}, domain.RelationLimits{}); err != nil || len(got) != 1 {
		t.Fatalf("relations %q: %+v %v", related, got, err)
	}
}

func TestRun_AnswersTheGroupJobs(t *testing.T) {
	r := fake.New(fake.Config{})
	job := func(prompt string) string {
		t.Helper()
		got, err := r.Run(context.Background(), tangent.RunRequest{Messages: []domain.ChatMessage{{Role: "user", Content: prompt}}})
		if err != nil {
			t.Fatal(err)
		}
		return got.Content
	}
	summary := job(domain.BuildGroupSummaryPrompt(domain.GroupSummaryInput{Title: "t", Members: []domain.GroupMemberInput{{Purpose: "a"}}}))
	if text, err := domain.ParseGroupSummary(summary, domain.GroupLimits{}); err != nil || text == "" {
		t.Fatalf("summary %q: %v", summary, err)
	}
	suggest := job(domain.BuildGroupSuggestPrompt(domain.GroupSuggestInput{Candidates: []domain.GroupCandidate{
		{Key: "B1", Purpose: "a", Ended: true, Leaf: "x"}, {Key: "B2", Purpose: "b"}, {Key: "B3", Purpose: "c", Ended: true, Leaf: "y"}, {Key: "B4", Purpose: "d"},
	}}))
	known := map[string]bool{"B1": true, "B2": true, "B3": true, "B4": true}
	groups, err := domain.ParseGroupSuggestions(suggest, known, domain.GroupLimits{})
	if err != nil || len(groups) != 2 || strings.Join(groups[0].Members, ",") != "B1,B3" || len(groups[0].Conflicts) != 1 || strings.Join(groups[1].Members, ",") != "B2,B4" {
		t.Fatalf("groups %q: %+v %v", suggest, groups, err)
	}
	none := job(domain.BuildGroupSuggestPrompt(domain.GroupSuggestInput{Candidates: []domain.GroupCandidate{{Key: "B1", Purpose: "a"}}}))
	if groups, err := domain.ParseGroupSuggestions(none, known, domain.GroupLimits{}); err != nil || len(groups) != 0 {
		t.Fatalf("none %q: %+v %v", none, groups, err)
	}
}

func TestRun_AnswersTheIbisAndFoldJobs(t *testing.T) {
	r := fake.New(fake.Config{})
	job := func(prompt string) string {
		t.Helper()
		got, err := r.Run(context.Background(), tangent.RunRequest{Messages: []domain.ChatMessage{{Role: "user", Content: prompt}}})
		if err != nil {
			t.Fatal(err)
		}
		return got.Content
	}
	tagged := job(domain.BuildIbisTagPrompt(domain.IbisTagInput{Messages: []domain.IbisCandidate{
		{Key: "M1", Role: domain.RoleUser, Content: "Which disks?"}, {Key: "M2", Role: domain.RoleAssistant, Content: "Two."},
	}}))
	tags, err := domain.ParseIbisTags(tagged, map[string]bool{"M1": true, "M2": true})
	if err != nil || len(tags) != 2 || tags[0].Kind != domain.TagQuestion || tags[1].Kind != domain.TagIdea {
		t.Fatalf("tags %q: %+v %v", tagged, tags, err)
	}
	summary := job(domain.BuildFoldSummaryPrompt(domain.FoldSummaryInput{Messages: []domain.Message{{Role: domain.RoleUser, Content: "q", Status: domain.MessageDone, Kind: domain.MessageKindChat}}}))
	if text, err := domain.ParseFoldSummary(summary, domain.FoldLimits{}); err != nil || text == "" {
		t.Fatalf("summary %q: %v", summary, err)
	}
}

func TestRun_AnswersTheDivergeJobs(t *testing.T) {
	r := fake.New(fake.Config{})
	job := func(prompt string) string {
		t.Helper()
		got, err := r.Run(context.Background(), tangent.RunRequest{Messages: []domain.ChatMessage{{Role: "user", Content: prompt}}})
		if err != nil {
			t.Fatal(err)
		}
		return got.Content
	}
	diverged := job(domain.BuildDivergePrompt(domain.DivergeInput{Count: 3}))
	if got, err := domain.ParseDiverge(diverged, 3, domain.DefaultLimits()); err != nil || len(got) != 3 {
		t.Fatalf("directions %q: %+v %v", diverged, got, err)
	}
	options := []domain.ConvergeOption{{Key: "O1", LineID: "a", Purpose: "A"}, {Key: "O2", LineID: "b", Purpose: "B"}}
	compared := job(domain.BuildConvergePrompt(domain.ConvergeInput{Options: options, Criteria: []string{"Speed", "Cost"}}))
	m, err := domain.ParseConvergence(compared, options, []string{"Speed", "Cost"}, domain.DefaultLimits())
	if err != nil || m.Recommendation.LineID != "a" || m.Scores[1][1].Score != 4 {
		t.Fatalf("matrix %q: %+v %v", compared, m, err)
	}
	free := job(domain.BuildConvergePrompt(domain.ConvergeInput{Options: options}))
	if m, err := domain.ParseConvergence(free, options, nil, domain.DefaultLimits()); err != nil || len(m.Criteria) != 1 {
		t.Fatalf("free %q: %+v %v", free, m, err)
	}
}

func TestRun_AnswersTheMemoryJobs(t *testing.T) {
	r := fake.New(fake.Config{})
	job := func(prompt string) string {
		t.Helper()
		got, err := r.Run(context.Background(), tangent.RunRequest{Messages: []domain.ChatMessage{{Role: "user", Content: prompt}}})
		if err != nil {
			t.Fatal(err)
		}
		return got.Content
	}
	extracted := job(domain.BuildMemoryExtractPrompt(domain.MemoryExtractSource{Kind: "card", Context: "Disks", Text: "Use ZFS"}, nil, nil))
	if got, err := domain.ParseMemoryExtract(extracted, nil, domain.DefaultLimits()); err != nil || len(got) != 1 || !strings.Contains(got[0].Text, "Disks") {
		t.Fatalf("extracted %q: %+v %v", extracted, got, err)
	}
	merged := job(domain.BuildMemoryConsolidatePrompt(domain.Memory{Kind: "fact", Text: "a"}, domain.Memory{Kind: "fact", Text: "b"}, nil))
	if got, err := domain.ParseMemoryConsolidate(merged, domain.DefaultLimits()); err != nil || got.Action != "merge" {
		t.Fatalf("merged %q: %+v %v", merged, got, err)
	}
}
