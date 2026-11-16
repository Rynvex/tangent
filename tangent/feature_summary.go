package tangent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Summary is the rolling summary of a line: it stands for the history it
// covers in every prompt and in the packs of new branches. Manual: only
// StartSummary; Suggest: CompletedTurn.SummaryDue once the unsummarized
// history passes the trigger; Auto: the summary job is started then and
// returned in CompletedTurn.Jobs. Off: prompts and packs carry no summary
// (history is cut at HistoryScan) and StartSummary returns
// feature_disabled; stored summaries are kept.
func Summary(mode Mode, opts ...FeatureOption) Feature {
	return aiFeature(FeatureSummary, mode, opts, registerSummary)
}

// summaryBackoff is how long after a failed summary job a summary is not
// reported due again (StartSummary still works).
const summaryBackoff = 10 * time.Minute

func registerSummary(r *registry, _ *module) {
	failures := &summaryFailures{at: map[string]time.Time{}}
	r.addContextProvider(func(_ context.Context, _ *Engine, _ Mode, pc *promptContext) error {
		pc.in.Summary, pc.in.SummaryUptoSeq = pc.line.Summary, pc.line.SummaryUptoSeq
		return nil
	})
	r.addPackSummary()
	r.addAfterCommit(func(ctx context.Context, e *Engine, mode Mode, ev *commitEvent) ([]Event, []Job) {
		return e.summaryAfterTurn(ctx, mode, ev, failures)
	})
	r.addJobHandler(JobKindSummary, jobHandler{
		timeout: store.DefaultSummaryJobTimeout,
		finish: func(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
			return e.finishSummary(ctx, job, raw, runErr, failures)
		},
	})
}

// summaryFailures remembers recent failed summaries per line (in this
// process), for the backoff.
type summaryFailures struct {
	mu sync.Mutex
	at map[string]time.Time
}

func (f *summaryFailures) record(lineID string, now time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id, at := range f.at {
		if now.Sub(at) > summaryBackoff {
			delete(f.at, id)
		}
	}
	f.at[lineID] = now
}

func (f *summaryFailures) recent(lineID string, now time.Time) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	at, ok := f.at[lineID]
	return ok && now.Sub(at) <= summaryBackoff
}

func (f *summaryFailures) clear(lineID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.at, lineID)
}

// SummaryDueChange is the data of summary.due: the line's unsummarized
// history passed the trigger (summary in suggest mode); POST /compact (or
// StartSummary) starts one.
type SummaryDueChange struct {
	LineID     string `json:"lineId"`
	RootLineID string `json:"rootLineId"`
}

// summaryAfterTurn reports a due summary (suggest: CompletedTurn.SummaryDue
// and summary.due) or starts it (auto), only after a turn that finished
// with a reply (not failed, not cancelled).
func (e *Engine) summaryAfterTurn(ctx context.Context, mode Mode, ev *commitEvent, failures *summaryFailures) ([]Event, []Job) {
	if ev.kind != commitTurnCompleted || mode < ModeSuggest || !repliedTurn(ev.turn.Message) || failures.recent(ev.turn.Line.ID, e.now()) {
		return nil, nil
	}
	if !e.summaryDue(ctx, ev.scope, ev.turn.Line) {
		return nil, nil
	}
	if mode == ModeSuggest {
		ev.turn.SummaryDue = true
		line, root := ev.turn.Line.ID, rootOfView(ev.turn.Line)
		return []Event{{
			Type: EventSummaryDue, Tenant: ev.scope.Tenant, RootLineID: root, LineID: line, Data: SummaryDueChange{LineID: line, RootLineID: root},
		}}, nil
	}
	job, err := e.startSummary(ctx, ev.scope, ev.turn.Line, nil)
	if err != nil {
		e.log.Warn("tangent: automatic summary not started", "line", ev.turn.Line.ID, "error", err)
		return nil, nil
	}
	return nil, []Job{job}
}

// repliedTurn reports a turn that ended with a stored reply.
func repliedTurn(message domain.Message) bool {
	return message.Status == domain.MessageDone && !message.Meta.Cancelled
}

// summaryDue reports whether the line's summarizable history passed the
// trigger while no summary job is pending. It measures the history in SQL
// first: EstimateTokens lies between characters / 4 and characters +
// messages, so the bodies are read only when the measure cannot decide. A
// failed read only logs: the turn itself is already recorded.
func (e *Engine) summaryDue(ctx context.Context, scope Scope, line domain.LineView) bool {
	size, err := e.store.UnsummarizedSize(ctx, scope.Tenant, line.ID)
	if err != nil {
		e.log.Warn("tangent: summary check failed", "line", line.ID, "error", err)
		return false
	}
	if size.Messages == 0 || size.Chars+size.Messages < int64(e.limits.History.SummaryTriggerTokens) {
		return false
	}
	_, pending, err := e.store.PendingJob(ctx, scope.Tenant, line.ID, store.JobKindSummary)
	if err != nil || pending {
		return false
	}
	if size.Chars/4 >= int64(e.limits.History.SummaryTriggerTokens) {
		return true
	}
	messages, err := e.store.MessagesAfterSummary(ctx, scope.Tenant, line.ID)
	if err != nil {
		e.log.Warn("tangent: summary check failed", "line", line.ID, "error", err)
		return false
	}
	return domain.SummaryDue(summarizable(messages), e.limits.History)
}

// summarizable are the messages a summary may cover: those before the first
// conclusion card no turn has carried yet, so a card is never summarized
// away before the model saw it.
func summarizable(messages []domain.Message) []domain.Message {
	for i, message := range messages {
		if message.IsCard() && !message.Meta.Delivered {
			return messages[:i]
		}
	}
	return messages
}

// errNothingToSummarize refuses a summary of a line without new messages.
var errNothingToSummarize = domain.NewError(domain.CodeNoMessages, "this conversation has no new messages to summarize", nil)

// summaryInput is the summary job's input: the cursor it will record.
type summaryInput struct {
	UptoSeq int64 `json:"uptoSeq"`
}

// StartSummary starts a rolling summary of the line's messages after its
// summary cursor (up to the first undelivered card); a pending summary of
// the line is superseded.
// InTx hooks receive store.Job.
func (e *Engine) StartSummary(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (Job, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureSummary)
	if err != nil {
		return Job{}, err
	}
	line, err := e.store.GetLine(ctx, scope.Tenant, lineID)
	if err != nil {
		return Job{}, err
	}
	return e.startSummary(ctx, scope, line, opts)
}

func (e *Engine) startSummary(ctx context.Context, scope Scope, line domain.LineView, opts []TxOption) (Job, error) {
	messages, err := e.store.MessagesAfterSummary(ctx, scope.Tenant, line.ID)
	if err != nil {
		return Job{}, err
	}
	messages = summarizable(messages)
	upto := domain.SummaryUptoSeq(messages)
	if upto == 0 {
		return Job{}, errNothingToSummarize
	}
	input, err := json.Marshal(summaryInput{UptoSeq: upto})
	if err != nil {
		return Job{}, fmt.Errorf("marshal summary input: %w", err)
	}
	record, err := e.startJob(ctx, scope, store.CreateJobInput{
		Kind: JobKindSummary, Feature: FeatureSummary, LineID: line.ID, Input: input, Supersede: true,
	}, opts)
	if err != nil {
		return Job{}, err
	}
	provider, model := e.configOf(FeatureSummary).jobModel(line.Provider, line.Model)
	return Job{
		ID: record.ID, Kind: JobKindSummary, Feature: FeatureSummary, Scope: scope, LineID: line.ID,
		Prompt: jobPrompt(domain.BuildSummaryPrompt(line.Summary, messages, e.markers...)), Provider: provider, Model: model,
	}, nil
}

// Fixed failure texts of a summary job.
const (
	summaryRunFailedText = "the summary run failed"
	summaryUnusableText  = "the summary run did not return a usable summary"
)

// finishSummary stores a summary run: the summary, its cursor and the topic
// cut it implies (only while a feature provides topic cuts: chapters, as an
// optional cooperation, not a dependency); or the job's failure (the
// previous summary stays and the backoff starts, unless the job had already
// ended, for example superseded).
func (e *Engine) finishSummary(ctx context.Context, job JobRecord, raw string, runErr error, failures *summaryFailures) error {
	scope := Scope{Tenant: job.TenantID}
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	summary, reported, ok := domain.ParseSummaryWithCut(raw)
	if runErr != nil || !ok {
		reason := summaryUnusableText
		if runErr != nil {
			reason = summaryRunFailedText
		}
		if _, err := e.store.FinishJob(ctx, job.ID, store.JobFailed, reason); err != nil {
			return err // superseded or already finished: not a failure of this line's summary
		}
		failures.record(job.LineID, e.now())
		return nil
	}
	var input summaryInput
	if err := json.Unmarshal(job.Input, &input); err != nil {
		return fmt.Errorf("decode summary job input: %w", err)
	}
	saved, err := e.store.SaveSummary(ctx, store.SaveSummaryInput{
		Tenant: scope.Tenant, LineID: job.LineID, JobID: job.ID, Summary: summary, UptoSeq: input.UptoSeq,
		ReportedTopicStart: strings.TrimSpace(reported), SkipTopicCut: !e.cooperates(modes, capTopicCuts),
	})
	if err != nil {
		return err
	}
	failures.clear(job.LineID)
	e.publish(ctx, lineEvent(EventLineUpdated, saved.Line))
	e.dispatchOrphanJobs(ctx, e.commit(ctx, &commitEvent{kind: commitSummarySaved, scope: scope, modes: modes, summary: &saved}))
	return nil
}
