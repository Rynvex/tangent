package tangent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// JobKindIbisTag tags a line's newest messages with their argument kind.
const JobKindIbisTag = store.JobKindIbisTag

// Ibis marks messages with their role in the argument (DESIGN §12 B10,
// IBIS): question, idea, pro, con or decision. The operator tags any
// finished operator or assistant message (TagMessage, any mode). Suggest
// and Auto also ask a cheap model, every Limits.Ibis.Every (3) replies of a
// line that is not an aside, to tag its newest untagged messages (one
// ibis_tag job, at most Limits.Ibis.BatchMax after the last finished job):
// Suggest writes them as drafts the operator confirms by tagging, Auto as
// confirmed tags. A model never replaces a tag, and the operator's tags are
// the operator's. Messages and the outline (the anchor's tag) carry tags;
// with the fisheye on, a confirmed decision is a head start.
// Off: the tag calls return feature_disabled and no job runs; stored tags
// stay and still show.
func Ibis(mode Mode, opts ...FeatureOption) Feature {
	return aiFeature(FeatureIbis, mode, opts, registerIbis)
}

// capIbisFisheye is what ibis provides to the fisheye: a confirmed decision
// tag is a head start.
const capIbisFisheye = "ibis.fisheye"

func registerIbis(r *registry, _ *module) {
	r.provide(capIbisFisheye)
	r.addAfterCommit(ibisAfterTurn)
	r.addJobHandler(JobKindIbisTag, jobHandler{timeout: goalJobTimeout, finish: finishIbisTags, onStale: staleJobFailed})
}

// Tag types, as the store takes and returns them.
type (
	TagInput  = store.TagInput
	TagDrafts = store.TagDrafts
)

// TagMessage writes the operator's confirmed tag (question, idea, pro, con
// or decision) on a finished operator or assistant message; it replaces any
// tag. message.updated follows when it changed.
// InTx hooks receive store.TaggedMessage.
func (e *Engine) TagMessage(ctx context.Context, scope Scope, messageID, kind string, opts ...TxOption) (domain.Message, error) {
	return e.SetMessageTag(ctx, scope, messageID, TagInput{Kind: kind}, opts...)
}

// SetMessageTag writes a tag with a status on a finished operator or
// assistant message: confirmed (empty too) is the operator's, as
// TagMessage; draft puts it back for review as the model's (B15). It
// replaces any tag; message.updated follows when it changed.
// InTx hooks receive store.TaggedMessage.
func (e *Engine) SetMessageTag(ctx context.Context, scope Scope, messageID string, in TagInput, opts ...TxOption) (domain.Message, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureIbis)
	if err != nil {
		return domain.Message{}, err
	}
	out, err := e.store.SetMessageTag(ctx, scope.Tenant, messageID, in, scope.Actor, hooksOf(opts)...)
	return e.taggedMessage(ctx, scope, out, err)
}

// ListTagDrafts lists the draft tags of the tree of any of its lines, at
// most store.TagDraftsMax (Truncated beyond); read-only callers may ask.
func (e *Engine) ListTagDrafts(ctx context.Context, scope Scope, lineID string) (TagDrafts, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureIbis)
	if err != nil {
		return TagDrafts{}, err
	}
	return e.store.ListTagDrafts(ctx, scope.Tenant, lineID)
}

// UntagMessage removes a message's tag (nothing changes without one).
// InTx hooks receive store.TaggedMessage.
func (e *Engine) UntagMessage(ctx context.Context, scope Scope, messageID string, opts ...TxOption) (domain.Message, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureIbis)
	if err != nil {
		return domain.Message{}, err
	}
	out, err := e.store.UntagMessage(ctx, scope.Tenant, messageID, hooksOf(opts)...)
	return e.taggedMessage(ctx, scope, out, err)
}

func (e *Engine) taggedMessage(ctx context.Context, scope Scope, out store.TaggedMessage, err error) (domain.Message, error) {
	if err != nil {
		return domain.Message{}, err
	}
	if out.Changed {
		e.publish(ctx, messageEvent(EventMessageUpdated, scope.Tenant, out.RootLineID, out.Message))
	}
	return out.Message, nil
}

// ibisAfterTurn starts a tagging job after every Limits.Ibis.Every-th
// completed reply of a line (Suggest, Auto; not on an aside).
func ibisAfterTurn(ctx context.Context, e *Engine, mode Mode, ev *commitEvent) ([]Event, []Job) {
	if ev.kind != commitTurnCompleted || mode < ModeSuggest || ev.turn == nil || !repliedTurn(ev.turn.Message) {
		return nil, nil
	}
	line := ev.turn.Line
	if line.ConversationBranch != nil && line.ConversationBranch.Kind == domain.BranchKindAside {
		return nil, nil
	}
	if replies, err := ev.lineReplies(ctx, e); err != nil || replies%e.limits.Ibis.Every != 0 {
		return nil, nil
	}
	job, ok, err := e.startIbisTag(ctx, ev.scope, line, ev.turn.Message.Seq)
	if err != nil {
		e.log.Warn("tangent: a tagging job was not started", "line", line.ID, "error", err)
	}
	if !ok {
		return nil, nil
	}
	return nil, []Job{job}
}

// ibisJobInput is what an ibis_tag job remembers: the keys it showed and
// the newest seq it read (store reads it as the next job's cursor).
type ibisJobInput struct {
	UptoSeq int64             `json:"uptoSeq"`
	Keys    map[string]string `json:"keys"`
}

// startIbisTag records an ibis_tag job for the line's untagged messages up
// to uptoSeq (the reply that just finished); ok is false when there are
// none.
func (e *Engine) startIbisTag(ctx context.Context, scope Scope, line domain.LineView, uptoSeq int64) (Job, bool, error) {
	candidates, err := e.store.IbisCandidates(ctx, line.ID, uptoSeq, e.limits.Ibis.BatchMax)
	if err != nil || len(candidates.Messages) == 0 {
		return Job{}, false, err
	}
	in := ibisJobInput{UptoSeq: candidates.UptoSeq, Keys: map[string]string{}}
	shown := make([]domain.IbisCandidate, 0, len(candidates.Messages))
	for i, message := range candidates.Messages {
		key := fmt.Sprintf("M%d", i+1)
		in.Keys[key] = message.ID
		shown = append(shown, domain.IbisCandidate{Key: key, Role: message.Role, Content: message.Content})
	}
	input, _ := json.Marshal(in)
	record, err := e.startJob(ctx, scope, store.CreateJobInput{Kind: JobKindIbisTag, Feature: FeatureIbis, LineID: line.ID, Input: input, Supersede: true}, nil)
	if err != nil {
		return Job{}, false, err
	}
	about := line.Title
	if line.ConversationBranch != nil {
		about = line.ConversationBranch.Purpose
	}
	text := domain.BuildIbisTagPrompt(domain.IbisTagInput{Context: about, Messages: shown, MessageRunes: e.limits.Ibis.MessageRunes, ExtraMarkers: e.markers})
	provider, model := e.configOf(FeatureIbis).jobModel(line.Provider, line.Model)
	return Job{
		ID: record.ID, Kind: record.Kind, Feature: FeatureIbis, Scope: scope, LineID: line.ID, Prompt: jobPrompt(text), Provider: provider, Model: model,
	}, true, nil
}

// finishIbisTags writes the model's tags (drafts in Suggest, confirmed in
// Auto; none once the feature is off) and publishes message.updated for
// each, or fails the job.
func finishIbisTags(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
	var in ibisJobInput
	_ = json.Unmarshal(job.Input, &in)
	known := make(map[string]bool, len(in.Keys))
	for key := range in.Keys {
		known[key] = true
	}
	proposals, parseErr := domain.ParseIbisTags(raw, known)
	failure := ""
	switch {
	case runErr != nil:
		failure = domain.JobRunFailedText
	case parseErr != nil:
		failure = domain.JobUnusableText
	}
	mode := e.modesFor(ctx, Scope{Tenant: job.TenantID}).of(FeatureIbis)
	status := domain.TagStatusDraft
	if mode == ModeAuto {
		status = domain.TagStatusConfirmed
	}
	tags := make([]store.AITag, 0, len(proposals))
	for _, p := range proposals {
		if mode != ModeOff {
			tags = append(tags, store.AITag{MessageID: in.Keys[p.Message], Kind: p.Kind})
		}
	}
	done, err := e.store.FinishIbisTags(ctx, job.ID, tags, status, failure)
	if err != nil {
		return err
	}
	for _, message := range done.Messages {
		e.publish(ctx, messageEvent(EventMessageUpdated, job.TenantID, done.RootLineID, message))
	}
	if failure != "" {
		e.publishJobFailed(ctx, job, failure)
	}
	return nil
}
