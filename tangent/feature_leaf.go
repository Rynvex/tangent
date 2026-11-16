package tangent

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// JobKindLeafDraft is the leaf feature's job: a cheap model drafts a
// branch's leaf.
const JobKindLeafDraft = "leaf_draft"

// leafDraftTimeout is how long a leaf draft may stay pending.
const leafDraftTimeout = 3 * time.Minute

// Fixed failure texts of a leaf draft job (never the model's output).
const (
	leafDraftRunFailedText = domain.LeafDraftRunFailedText
	leafDraftUnusableText  = domain.LeafDraftUnusableText
)

// Leaf is the closing note of a branch (DESIGN §12 B8): a merge writes a
// conclusion leaf from its card in the same transaction; a discard may
// carry a dead-end leaf; the operator writes or confirms one at any time.
// Suggest and Auto also draft one with a job when a branch is discarded
// without a leaf and for the previous main line of a promotion (Suggest:
// a draft for the operator to confirm; Auto: confirmed, marked aiDrafted).
// Manual drafts only when asked (StartLeafDraft). A leaf never enters a
// turn prompt. Off: the leaf calls and a discard's leaf return
// feature_disabled; stored leaves are kept (the outline still shows them).
func Leaf(mode Mode, opts ...FeatureOption) Feature {
	return aiFeature(FeatureLeaf, mode, opts, registerLeaf)
}

// capLeafCapsule is the optional capability leaf provides: a spun-off
// conversation's capsule carries the branch's leaf while it is on.
const capLeafCapsule = "leaf.capsule"

func registerLeaf(r *registry, _ *module) {
	r.provide(capLeafCapsule)
	r.addOnBranchClosed(leafWhenClosed)
	r.addAfterCommit(leafAfterClose)
	r.addJobHandler(JobKindLeafDraft, jobHandler{
		timeout: leafDraftTimeout,
		finish: func(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
			return e.finishLeafDraft(ctx, job, raw, runErr)
		},
		onStale: func(ctx context.Context, e *Engine, job JobRecord) {
			e.publishDraftFailure(ctx, job.TenantID, job.LineID, job.Error)
		},
	})
}

// leafWhenClosed writes, in the closing transaction, a merge's conclusion
// leaf (from its card) or a discard's leaf (when one was given).
func leafWhenClosed(ctx context.Context, e *Engine, _ Mode, tx store.Tx, ev txEvent) error {
	var write store.LeafWrite
	switch result := ev.result.(type) {
	case store.MergedBranch:
		if result.Card.Meta.Card == nil {
			return nil
		}
		write = store.LeafWrite{LineID: result.Branch.LineID, Leaf: domain.LeafFromCard(*result.Card.Meta.Card, e.limits.Leaf)}
	case domain.BranchView:
		in, ok := ev.request.(DiscardInput)
		if !ok || in.Leaf == nil {
			return nil
		}
		leaf := *in.Leaf
		if leaf.Kind == "" {
			leaf.Kind = domain.LeafKindDeadEnd
		}
		write = store.LeafWrite{LineID: result.LineID, Leaf: leaf}
	default:
		return nil
	}
	write.Status, write.Actor = domain.LeafStatusConfirmed, ev.scope.Actor
	leaf, err := e.store.WriteLeaf(ctx, tx, write)
	if err != nil {
		return err
	}
	ev.out.after(func(context.Context) []Event {
		return []Event{leafEvent(ev.scope, leaf.LineID, leaf.RootLineID, &leaf)}
	})
	return nil
}

// leafAfterClose drafts a leaf (Suggest, Auto) for a branch discarded
// without one and for the previous main line of a promotion. Answered
// asides are left alone.
func leafAfterClose(ctx context.Context, e *Engine, mode Mode, ev *commitEvent) ([]Event, []Job) {
	if ev.kind != commitBranchClosed || mode < ModeSuggest || ev.branch == nil {
		return nil, nil
	}
	lineID := ""
	switch ev.change {
	case BranchDiscarded:
		in, _ := ev.request.(DiscardInput)
		if in.Leaf == nil && ev.branch.Kind != domain.BranchKindAside {
			lineID = ev.branch.LineID
		}
	case BranchPromoted:
		if ev.promoted != nil {
			lineID = ev.promoted.PreviousID
		}
	}
	if lineID == "" {
		return nil, nil
	}
	job, err := e.startLeafDraft(ctx, ev.scope, lineID, nil)
	if err != nil {
		if !errors.Is(err, domain.ErrBranchNoMessages) {
			e.log.Warn("tangent: a leaf draft was not started", "line", lineID, "error", err)
		}
		return nil, nil
	}
	return nil, []Job{job}
}

// LeafChange is the data of leaf.changed; Leaf is nil once it was deleted
// (or while the branch has none). DraftError is set when a leaf draft just
// failed (Leaf is then the branch's current leaf).
type LeafChange struct {
	LineID     string                 `json:"lineId"`
	RootLineID string                 `json:"rootLineId"`
	Leaf       *domain.Leaf           `json:"leaf"`
	DraftError *domain.LeafDraftError `json:"draftError,omitempty"`
}

func leafEvent(scope Scope, lineID, rootLineID string, leaf *domain.Leaf) Event {
	return Event{
		Type: EventLeafChanged, Tenant: scope.Tenant, RootLineID: rootLineID, LineID: lineID,
		Data: LeafChange{LineID: lineID, RootLineID: rootLineID, Leaf: leaf},
	}
}

// GetLeaf reads a branch's leaf; nil when it has none.
func (e *Engine) GetLeaf(ctx context.Context, scope Scope, lineID string) (*domain.Leaf, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureLeaf)
	if err != nil {
		return nil, err
	}
	return e.store.GetLeaf(ctx, scope.Tenant, lineID)
}

// PutLeaf writes the operator's leaf (confirmed) over whatever the branch
// had; a later draft never replaces it.
// InTx hooks receive domain.Leaf.
func (e *Engine) PutLeaf(ctx context.Context, scope Scope, lineID string, in domain.LeafInput, opts ...TxOption) (domain.Leaf, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureLeaf)
	if err != nil {
		return domain.Leaf{}, err
	}
	leaf, err := e.store.PutLeaf(ctx, store.PutLeafInput{Tenant: scope.Tenant, LineID: lineID, Leaf: in, Actor: scope.Actor}, hooksOf(opts)...)
	if err != nil {
		return domain.Leaf{}, err
	}
	e.publish(ctx, leafEvent(scope, leaf.LineID, leaf.RootLineID, &leaf))
	e.dispatchOrphanJobs(ctx, e.commit(ctx, &commitEvent{kind: commitLeafWritten, scope: scope, modes: modes, leaf: &leaf, out: &txOutbox{}}))
	return leaf, nil
}

// DeleteLeaf removes a branch's leaf.
// InTx hooks receive domain.Leaf (the deleted one).
func (e *Engine) DeleteLeaf(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (domain.Leaf, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureLeaf)
	if err != nil {
		return domain.Leaf{}, err
	}
	leaf, err := e.store.DeleteLeaf(ctx, scope.Tenant, lineID, hooksOf(opts)...)
	if err != nil {
		return domain.Leaf{}, err
	}
	e.publish(ctx, leafEvent(scope, leaf.LineID, leaf.RootLineID, nil))
	return leaf, nil
}

// StartLeafDraft starts a leaf_draft job for a branch (any mode, the
// operator asked); a pending draft of the branch is superseded. The draft
// is written when the job finishes, unless the operator's leaf is there.
// InTx hooks receive store.Job.
func (e *Engine) StartLeafDraft(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (Job, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureLeaf)
	if err != nil {
		return Job{}, err
	}
	return e.startLeafDraft(ctx, scope, lineID, opts)
}

func (e *Engine) startLeafDraft(ctx context.Context, scope Scope, lineID string, opts []TxOption) (Job, error) {
	detail, err := e.store.GetBranch(ctx, scope.Tenant, lineID)
	if err != nil {
		return Job{}, err
	}
	recent, err := e.store.RecentMessages(ctx, scope.Tenant, lineID, e.limits.HistoryScan)
	if err != nil {
		return Job{}, err
	}
	messages := make([]domain.Message, 0, len(recent))
	for _, message := range recent {
		if conversationMessage(message) {
			messages = append(messages, message)
		}
	}
	if len(messages) == 0 {
		return Job{}, domain.ErrBranchNoMessages
	}
	record, err := e.startJob(ctx, scope, store.CreateJobInput{Kind: JobKindLeafDraft, Feature: FeatureLeaf, LineID: lineID, Supersede: true}, opts)
	if err != nil {
		return Job{}, err
	}
	// The first message is always quoted (BuildLeafDraftPrompt), so the
	// previous main line, which has no selection, still shows where it began.
	text := domain.BuildLeafDraftPrompt(domain.LeafDraftInput{
		Purpose: detail.Branch.Purpose, Excerpt: detail.Branch.Excerpt, Status: detail.Branch.Status, Origin: detail.Branch.Origin,
		Messages: messages, ExtraMarkers: e.markers,
	})
	provider, model := e.configOf(FeatureLeaf).jobModel(detail.Branch.Provider, detail.Branch.Model)
	return Job{
		ID: record.ID, Kind: JobKindLeafDraft, Feature: FeatureLeaf, Scope: scope, LineID: lineID,
		Prompt: jobPrompt(text), Provider: provider, Model: model,
	}, nil
}

// finishLeafDraft stores a leaf draft: a draft in Manual and Suggest, a
// confirmed (aiDrafted) leaf in Auto; never over the operator's leaf. A
// failed or unusable run fails the job and writes nothing.
func (e *Engine) finishLeafDraft(ctx context.Context, job JobRecord, raw string, runErr error) error {
	scope := Scope{Tenant: job.TenantID}
	leaf, parseErr := domain.ParseLeafDraft(raw, e.limits.Leaf)
	if runErr != nil || parseErr != nil {
		reason := leafDraftUnusableText
		if runErr != nil {
			reason = leafDraftRunFailedText
		}
		if _, err := e.store.FinishJob(ctx, job.ID, store.JobFailed, reason); err != nil {
			return err
		}
		e.publishDraftFailure(ctx, job.TenantID, job.LineID, reason)
		return nil
	}
	status := domain.LeafStatusDraft
	if e.modesFor(ctx, scope).of(FeatureLeaf) == ModeAuto {
		status = domain.LeafStatusConfirmed
	}
	result, err := e.store.FinishLeafDraft(ctx, job.ID, leaf, status)
	if err != nil {
		return err
	}
	if result.Written {
		e.publish(ctx, leafEvent(scope, result.Leaf.LineID, result.Leaf.RootLineID, &result.Leaf))
	}
	return nil
}

// publishDraftFailure publishes leaf.changed with the branch's current leaf
// and why its draft failed.
func (e *Engine) publishDraftFailure(ctx context.Context, tenant, lineID, reason string) {
	scope := Scope{Tenant: tenant}
	detail, err := e.store.GetBranch(ctx, tenant, lineID)
	if err != nil {
		e.log.Warn("tangent: a failed leaf draft's branch could not be read", "line", lineID, "error", err)
		return
	}
	leaf, err := e.store.GetLeaf(ctx, tenant, lineID)
	if err != nil {
		e.log.Warn("tangent: a failed leaf draft's leaf could not be read", "line", lineID, "error", err)
		return
	}
	failure := domain.LeafDraftErrorFor(reason)
	ev := leafEvent(scope, lineID, detail.Branch.RootLineID, leaf)
	ev.Data = LeafChange{LineID: lineID, RootLineID: detail.Branch.RootLineID, Leaf: leaf, DraftError: &failure}
	e.publish(ctx, ev)
}

// LeafState is a branch's leaf and, when the branch's newest leaf draft
// failed after the leaf was last written, why.
type LeafState struct {
	Leaf       *domain.Leaf           `json:"leaf"`
	DraftError *domain.LeafDraftError `json:"draftError,omitempty"`
}

// GetLeafState reads a branch's leaf with the failure of its newest leaf
// draft (none while a draft runs, after a successful one, or once the leaf
// was written after the failure).
func (e *Engine) GetLeafState(ctx context.Context, scope Scope, lineID string) (LeafState, error) {
	leaf, err := e.GetLeaf(ctx, scope, lineID)
	if err != nil {
		return LeafState{}, err
	}
	out := LeafState{Leaf: leaf}
	job, ok, err := e.store.LatestJob(ctx, strings.TrimSpace(scope.Tenant), lineID, JobKindLeafDraft)
	if err != nil || !ok || job.Status != store.JobFailed || job.FinishedAt == nil {
		return out, err
	}
	if leaf == nil || leaf.UpdatedAt.Before(*job.FinishedAt) {
		failure := domain.LeafDraftErrorFor(job.Error)
		out.DraftError = &failure
	}
	return out, nil
}
