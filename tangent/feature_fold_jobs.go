package tangent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// foldJob is a fold job over the messages (a chapter's, with its title).
func (e *Engine) foldJob(ctx context.Context, scope Scope, record JobRecord, messages []domain.Message, title string) (Job, error) {
	text := domain.BuildFoldSummaryPrompt(domain.FoldSummaryInput{Title: title, Messages: messages, Budget: e.limits.Fold.PromptTokenBudget, ExtraMarkers: e.markers})
	return e.featureJob(ctx, scope, record, FeatureFold, text)
}

// foldFailure is the fixed text a fold job fails with ("" when it did not).
func foldFailure(runErr, parseErr error) string {
	switch {
	case runErr != nil:
		return domain.JobRunFailedText
	case parseErr != nil:
		return domain.JobUnusableText
	}
	return ""
}

// finishFoldSummary writes a drafting fold's summary, or marks it failed.
func finishFoldSummary(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
	summary, parseErr := domain.ParseFoldSummary(raw, e.limits.Fold)
	failure := foldFailure(runErr, parseErr)
	result, err := e.store.FinishFoldSummary(ctx, job.ID, summary, failure)
	if err != nil {
		return err
	}
	if result.Written {
		e.publish(ctx, foldEvent(job.TenantID, result.RootLineID, result.Fold))
	}
	if failure != "" {
		e.publishJobFailed(ctx, job, failure)
	}
	return nil
}

// staleFoldSummary marks the fold of a timed-out summary failed.
func staleFoldSummary(ctx context.Context, e *Engine, job JobRecord) {
	failed, err := e.store.FailFoldOfJob(ctx, job.ID)
	if err != nil {
		e.log.Warn("tangent: a timed-out fold summary was not marked", "job", job.ID, "error", err)
	}
	if failed != nil {
		e.publish(ctx, foldEvent(job.TenantID, failed.RootLineID, failed.Fold))
	}
	e.publishJobFailed(ctx, job, job.Error)
}

// FoldSuggestion is the payload of a fold suggestion: the chapter's range
// and title, the drafted summary, the token counts and the job that wrote
// the summary.
type FoldSuggestion struct {
	FromMessageID  string `json:"fromMessageId"`
	ToMessageID    string `json:"toMessageId"`
	FromSeq        int64  `json:"fromSeq"`
	ToSeq          int64  `json:"toSeq"`
	Title          string `json:"title"`
	Summary        string `json:"summary"`
	MessageCount   int    `json:"messageCount"`
	TokensOriginal int    `json:"tokensOriginal"`
	TokensSummary  int    `json:"tokensSummary"`
	JobID          string `json:"jobId"`
}

// foldSuggestInput is what a fold_suggest job remembers.
type foldSuggestInput struct {
	FromMessageID string `json:"fromMessageId"`
	ToMessageID   string `json:"toMessageId"`
	Title         string `json:"title"`
}

func foldTargetKey(fromID, toID string) string { return "fold:" + fromID + ":" + toID }

// foldSuggestAfterTurn looks for a chapter to fold every SuggestEvery
// replies of a line that is not an aside (Suggest, Auto).
func foldSuggestAfterTurn(ctx context.Context, e *Engine, mode Mode, ev *commitEvent) ([]Event, []Job) {
	if ev.kind != commitTurnCompleted || mode < ModeSuggest || ev.turn == nil || !repliedTurn(ev.turn.Message) {
		return nil, nil
	}
	line := ev.turn.Line
	if line.ConversationBranch != nil && line.ConversationBranch.Kind == domain.BranchKindAside {
		return nil, nil
	}
	replies, err := ev.lineReplies(ctx, e)
	if err != nil || replies%e.limits.Fold.SuggestEvery != 0 {
		return nil, nil
	}
	job, ok, err := e.startFoldSuggest(ctx, ev.scope, line.ID, ev.turn.RootLineID)
	if err != nil {
		e.log.Warn("tangent: a fold suggestion was not started", "line", line.ID, "error", err)
	}
	if !ok {
		return nil, nil
	}
	return nil, []Job{job}
}

// foldCandidate is a chapter worth proposing to fold.
type foldCandidate struct {
	from, to, title string
	messages        []domain.Message
}

// startFoldSuggest records a fold_suggest job for the line's oldest closed
// chapter worth folding; ok is false when there is none.
func (e *Engine) startFoldSuggest(ctx context.Context, scope Scope, lineID, rootID string) (Job, bool, error) {
	candidate, ok, err := e.foldCandidate(ctx, scope, lineID, rootID)
	if err != nil || !ok {
		return Job{}, false, err
	}
	input, _ := json.Marshal(foldSuggestInput{FromMessageID: candidate.from, ToMessageID: candidate.to, Title: candidate.title})
	record, err := e.startJob(ctx, scope, store.CreateJobInput{Kind: JobKindFoldSuggest, Feature: FeatureFold, LineID: lineID, Input: input, Supersede: true}, nil)
	if err != nil {
		return Job{}, false, err
	}
	job, err := e.foldJob(ctx, scope, record, candidate.messages, candidate.title)
	return job, err == nil, err
}

// foldCandidate is the oldest closed chapter (not the line's last) with
// enough messages and tokens, not overlapping a fold and not proposed
// before (open or dismissed).
func (e *Engine) foldCandidate(ctx context.Context, scope Scope, lineID, rootID string) (foldCandidate, bool, error) {
	view, err := e.store.ListChapters(ctx, scope.Tenant, lineID)
	if err != nil || len(view.Chapters) < 2 {
		return foldCandidate{}, false, err
	}
	l := e.limits.Fold
	closed, keys := []domain.Chapter{}, []string{}
	for _, chapter := range view.Chapters[:len(view.Chapters)-1] {
		if chapter.MessageCount >= l.SuggestMinMessages && chapter.MessageCount <= l.MaxMessages {
			closed, keys = append(closed, chapter), append(keys, foldTargetKey(chapter.StartMessageID, chapter.EndMessageID))
		}
	}
	if len(closed) == 0 {
		return foldCandidate{}, false, nil
	}
	taken, err := e.store.TakenSuggestionTargets(ctx, rootID, FeatureFold, SuggestionKindFold, keys)
	if err != nil {
		return foldCandidate{}, false, err
	}
	live, err := e.store.LiveFolds(ctx, lineID)
	if err != nil {
		return foldCandidate{}, false, err
	}
	for i, chapter := range closed {
		if taken[keys[i]] {
			continue
		}
		if c, ok, err := e.chapterCandidate(ctx, scope, lineID, chapter, live); err != nil || ok {
			return c, ok, err
		}
	}
	return foldCandidate{}, false, nil
}

// chapterCandidate reads a chapter's messages: a candidate unless they
// overlap a fold or are too few tokens to be worth it.
func (e *Engine) chapterCandidate(ctx context.Context, scope Scope, lineID string, chapter domain.Chapter, live []domain.Fold) (foldCandidate, bool, error) {
	messages, err := e.store.LineMessagesBetween(ctx, scope.Tenant, lineID, chapter.StartMessageID, chapter.EndMessageID, e.limits.Fold.MaxMessages)
	if err != nil || len(messages) == 0 {
		return foldCandidate{}, false, err
	}
	from, to := messages[0].Seq, messages[len(messages)-1].Seq
	for _, fold := range live {
		if domain.FoldsOverlap(fold.FromSeq, fold.ToSeq, from, to) {
			return foldCandidate{}, false, nil
		}
	}
	if domain.FoldTokens(messages) < e.limits.Fold.SuggestMinTokens {
		return foldCandidate{}, false, nil
	}
	return foldCandidate{from: chapter.StartMessageID, to: chapter.EndMessageID, title: chapter.Title, messages: messages}, true, nil
}

// finishFoldSuggest raises the fold suggestion with the drafted summary.
func finishFoldSuggest(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
	summary, parseErr := domain.ParseFoldSummary(raw, e.limits.Fold)
	if ok, err := e.finishFeatureJob(ctx, job, runErr, parseErr); !ok {
		return err
	}
	scope := Scope{Tenant: job.TenantID}
	if e.modesFor(ctx, scope).of(FeatureFold) < ModeSuggest {
		return nil
	}
	var in foldSuggestInput
	_ = json.Unmarshal(job.Input, &in)
	messages, err := e.store.LineMessagesBetween(ctx, job.TenantID, job.LineID, in.FromMessageID, in.ToMessageID, e.limits.Fold.MaxMessages)
	if err != nil || len(messages) == 0 {
		e.log.Info("tangent: a chapter to fold is gone", "job", job.ID, "error", err)
		return nil
	}
	payload, _ := json.Marshal(FoldSuggestion{
		FromMessageID: in.FromMessageID, ToMessageID: in.ToMessageID, FromSeq: messages[0].Seq, ToSeq: messages[len(messages)-1].Seq,
		Title: in.Title, Summary: summary, MessageCount: len(messages), TokensOriginal: domain.FoldTokens(messages),
		TokensSummary: domain.EstimateTokens(summary), JobID: job.ID,
	})
	e.publish(ctx, e.proposeSuggestion(ctx, scope, suggestionProposal{
		lineID: job.LineID, kind: SuggestionKindFold, targetKey: foldTargetKey(in.FromMessageID, in.ToMessageID), payload: payload,
	})...)
	return nil
}

// FoldAccepted is what accepting a fold suggestion did: the new fold.
type FoldAccepted struct {
	Fold domain.Fold `json:"fold"`
}

// foldChoice is the body of accepting a fold: Summary replaces the drafted
// one (the summary is then the operator's).
type foldChoice struct {
	Summary string `json:"summary"`
}

func acceptFold(ctx context.Context, e *Engine, scope Scope, s domain.Suggestion, body json.RawMessage, mark TxOption, opts []TxOption) (any, error) {
	var payload FoldSuggestion
	var choice foldChoice
	if err := decodeChoice(s.Payload, &payload); err != nil {
		return nil, err
	}
	if err := decodeChoice(body, &choice); err != nil {
		return nil, err
	}
	summary, sourceJob := payload.Summary, payload.JobID
	if own := strings.TrimSpace(choice.Summary); own != "" && own != payload.Summary {
		summary, sourceJob = own, ""
	}
	created, err := e.createFold(ctx, scope, s.LineID, FoldInput{FromMessageID: payload.FromMessageID, ToMessageID: payload.ToMessageID, Summary: summary}, sourceJob, append([]TxOption{mark}, opts...))
	if err != nil {
		return nil, err
	}
	return FoldAccepted{Fold: created.Fold}, nil
}
