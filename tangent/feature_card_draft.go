package tangent

import (
	"context"
	"errors"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// CardDraft drafts a branch's conclusion card with a tool-free job; the
// operator edits and confirms it before merging. It is on or off (DESIGN
// §12): clients decide when to call StartDraft. Off: StartDraft returns
// feature_disabled and cards are written by hand.
func CardDraft(opts ...FeatureOption) Feature {
	return &module{name: FeatureCardDraft, ai: true, configured: ModeAuto, cfg: newFeatureConfig(opts), attach: registerCardDraft}
}

func registerCardDraft(r *registry, _ *module) {
	// Timeout 0: FailStaleJobs keeps the store's Limits.Branch.DraftTimeout.
	r.addJobHandler(JobKindCardDraft, jobHandler{
		finish: func(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
			return e.finishDraft(ctx, job, raw, runErr)
		},
		onStale: func(ctx context.Context, e *Engine, job JobRecord) {
			if job.LineID != "" {
				e.publish(ctx, e.branchEvents(ctx, Scope{Tenant: job.TenantID}, BranchDraft, []string{job.LineID})...)
			}
		},
	})
}

// StartDraft starts drafting the branch's conclusion card: the branch is
// marked drafting (it takes no turns until the draft ends) and the
// card_draft job is returned for the host to run.
// InTx hooks receive store.DraftClaim.
func (e *Engine) StartDraft(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (Job, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureCardDraft)
	if err != nil {
		return Job{}, err
	}
	claim, err := e.store.ClaimBranchDraft(ctx, scope.Tenant, lineID, hooksOf(opts)...)
	if err != nil {
		return Job{}, err
	}
	e.publish(ctx, branchEvent(scope.Tenant, BranchDraft, claim.Branch))
	text, err := e.draftPrompt(ctx, scope, modes.of(FeatureNotes) != ModeOff, claim)
	if err != nil {
		e.abandonDraft(ctx, scope, claim.Job.ID)
		return Job{}, err
	}
	provider, model := e.configOf(FeatureCardDraft).jobModel(claim.Branch.Provider, claim.Branch.Model)
	return Job{
		ID: claim.Job.ID, Kind: JobKindCardDraft, Feature: FeatureCardDraft, Scope: scope, LineID: claim.Branch.LineID,
		Prompt: jobPrompt(text), Provider: provider, Model: model,
	}, nil
}

// abandonDraft ends a claimed draft whose prompt could not be built, on a
// context the caller's cancellation does not stop.
func (e *Engine) abandonDraft(ctx context.Context, scope Scope, jobID string) {
	writeCtx, done := detached(ctx)
	defer done()
	if err := e.finishDraftOutcome(writeCtx, scope, jobID, domain.DraftFailed(domain.DraftRunFailedText)); err != nil {
		e.log.Error("tangent: an abandoned draft could not be ended", "job", jobID, "error", err)
	}
}

// draftPrompt renders the drafting prompt from the claimed state: the
// branch's conversation up to the claim, the parent since the fork up to
// its tip at the claim, the selected text and the anchor; with notes on,
// the tree's active notes and the request for proposals.
func (e *Engine) draftPrompt(ctx context.Context, scope Scope, withNotes bool, claim store.DraftClaim) (string, error) {
	detail, err := e.store.GetBranch(ctx, scope.Tenant, claim.Branch.LineID)
	if err != nil {
		return "", err
	}
	branchMessages, since, err := e.draftSources(ctx, scope, detail, claim.UptoSeq, claim.ParentTipMessageID)
	if err != nil {
		return "", err
	}
	anchor, err := e.draftAnchor(ctx, scope, detail.Branch)
	if err != nil {
		return "", err
	}
	in := domain.BranchDraftInput{
		Purpose: detail.Branch.Purpose, Excerpt: detail.Branch.Excerpt, Anchor: anchor, Pack: detail.Pack.Rendered,
		BranchMessages: branchMessages, ParentSince: since, ExtraMarkers: e.markers, ProposeNotes: withNotes,
	}
	if withNotes {
		if in.Notes, err = e.store.ActiveNotes(ctx, detail.Branch.RootLineID); err != nil {
			return "", err
		}
	}
	return domain.BuildBranchDraftPrompt(in), nil
}

// draftSources reads what a draft is built from as of its claim: the
// branch's finished operator and assistant messages up to uptoSeq, and the
// parent's messages after the anchor up to its tip at the claim. The branch
// takes no turn while it drafts, so reading the same claim again when the
// run finishes gives the same messages, and the prompt's short ids
// (domain.DraftShortIDs) map back to the same message ids.
func (e *Engine) draftSources(ctx context.Context, scope Scope, detail domain.BranchDetail, uptoSeq int64, parentTipID string) ([]domain.Message, []domain.Message, error) {
	recent, err := e.store.RecentMessages(ctx, scope.Tenant, detail.Branch.LineID, e.limits.HistoryScan)
	if err != nil {
		return nil, nil, err
	}
	branchMessages := make([]domain.Message, 0, len(recent))
	for _, message := range recent {
		if message.Seq <= uptoSeq && conversationMessage(message) {
			branchMessages = append(branchMessages, message)
		}
	}
	since, err := e.store.MessagesAfterAnchor(ctx, scope.Tenant, detail.Branch.ParentLineID, detail.Branch.AnchorMessageID)
	if err != nil && !errors.Is(err, domain.ErrMessageNotFound) {
		return nil, nil, err
	}
	return branchMessages, messagesUpTo(since, parentTipID), nil
}

// messagesUpTo keeps the messages up to the one with id tipID (by seq):
// none when tipID is not among them (the tip was the anchor itself, or the
// parent had nothing after the anchor).
func messagesUpTo(messages []domain.Message, tipID string) []domain.Message {
	tipSeq, found := int64(0), false
	for _, message := range messages {
		if message.ID == tipID {
			tipSeq, found = message.Seq, true
		}
	}
	out := []domain.Message{}
	for _, message := range messages {
		if found && message.Seq <= tipSeq {
			out = append(out, message)
		}
	}
	return out
}

// draftAnchor reads the parent message the branch hangs on; nil when it is
// no longer there.
func (e *Engine) draftAnchor(ctx context.Context, scope Scope, branch domain.BranchView) (*domain.Message, error) {
	message, err := e.store.GetMessage(ctx, scope.Tenant, branch.ParentLineID, branch.AnchorMessageID)
	if errors.Is(err, domain.ErrMessageNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &message, nil
}

// finishDraft turns a draft run into what is stored: a neutralised card, or
// a failure with a fixed reason. The model's raw output is never kept.
func (e *Engine) finishDraft(ctx context.Context, job JobRecord, raw string, runErr error) error {
	scope := Scope{Tenant: job.TenantID}
	detail, err := e.store.GetBranch(ctx, scope.Tenant, job.LineID)
	if errors.Is(err, domain.ErrBranchNotFound) {
		return domain.ErrDraftNotPending
	}
	if err != nil {
		return err
	}
	outcome, err := e.draftOutcome(ctx, scope, detail, raw, runErr)
	if err != nil {
		return err
	}
	return e.finishDraftOutcome(ctx, scope, job.ID, outcome)
}

// draftOutcome judges a draft run against the messages the card may cite.
func (e *Engine) draftOutcome(ctx context.Context, scope Scope, detail domain.BranchDetail, raw string, runErr error) (domain.BranchDraftOutcome, error) {
	if runErr != nil {
		return domain.DraftFailed(domain.DraftRunFailedText), nil
	}
	draft, proposals, err := domain.ParseBranchDraftProposal(raw)
	if err != nil {
		return domain.DraftFailed(domain.DraftUnusableText), nil
	}
	if draft, proposals, err = e.resolveDraftIDs(ctx, scope, detail, draft, proposals); err != nil {
		return domain.BranchDraftOutcome{}, err
	}
	refs, err := e.cardRefs(ctx, scope, detail, draft)
	if err != nil {
		return domain.BranchDraftOutcome{}, err
	}
	outcome := domain.DraftOutcome(draft, refs)
	if outcome.Status != domain.BranchDraftReady {
		return outcome, nil
	}
	outcome.Provider, outcome.Model = e.configOf(FeatureCardDraft).jobModel(detail.Branch.Provider, detail.Branch.Model)
	if e.modesFor(ctx, scope).of(FeatureNotes) == ModeOff || len(proposals) == 0 {
		return outcome, nil
	}
	changes, warnings, err := e.draftNoteChanges(ctx, scope, detail, proposals)
	if err != nil {
		return domain.BranchDraftOutcome{}, err
	}
	outcome.NoteChanges, outcome.Warnings = changes, append(outcome.Warnings, warnings...)
	return outcome, nil
}

// resolveDraftIDs turns the prompt's short ids (B1, M1, …) in a drafted
// card and its note proposals back into message ids, rebuilding the
// numbering from the claim the draft ran on. Ids that are not short ids of
// that prompt (a real message id, an unknown code) are kept and checked
// like any other id.
func (e *Engine) resolveDraftIDs(ctx context.Context, scope Scope, detail domain.BranchDetail, draft domain.BranchCard, proposals []domain.NoteChange) (domain.BranchCard, []domain.NoteChange, error) {
	branchMessages, since, err := e.draftSources(ctx, scope, detail, detail.Draft.UptoSeq, detail.Draft.ParentTipMessageID)
	if err != nil {
		return domain.BranchCard{}, nil, err
	}
	ids := domain.NewDraftShortIDs(domain.BranchDraftInput{BranchMessages: branchMessages, ParentSince: since})
	return ids.ResolveCard(draft), ids.ResolveNoteChanges(proposals), nil
}

// draftNoteChanges keeps the proposals a merge of this branch would accept:
// supersedes of the tree's active notes, sources among the branch's
// finished messages.
func (e *Engine) draftNoteChanges(ctx context.Context, scope Scope, detail domain.BranchDetail, proposals []domain.NoteChange) ([]domain.NoteChange, []string, error) {
	notes, err := e.store.ActiveNotes(ctx, detail.Branch.RootLineID)
	if err != nil {
		return nil, nil, err
	}
	nc := domain.DraftNoteContext{
		BranchLineID: detail.Branch.LineID, ActiveNotes: map[string]bool{}, BranchMessages: map[string]bool{}, Limits: e.limits.Notes,
	}
	for _, note := range notes {
		nc.ActiveNotes[note.ID] = true
	}
	for i, proposal := range proposals {
		source := strings.TrimSpace(proposal.SourceMessageID)
		if i >= e.limits.Notes.MaxChangesPerMerge || source == "" || nc.BranchMessages[source] {
			continue
		}
		if _, found, err := e.citable(ctx, scope, detail.Branch.LineID, source); err != nil {
			return nil, nil, err
		} else if found {
			nc.BranchMessages[source] = true
		}
	}
	changes, warnings := domain.SanitizeDraftNoteChanges(proposals, nc)
	return changes, warnings, nil
}

// finishDraftOutcome stores a draft outcome and publishes the branch.
func (e *Engine) finishDraftOutcome(ctx context.Context, scope Scope, jobID string, outcome domain.BranchDraftOutcome) error {
	view, err := e.store.FinishBranchDraft(ctx, jobID, outcome)
	if err != nil {
		if errors.Is(err, domain.ErrDraftNotPending) {
			// The job was retired (timed out or superseded): the draft state changed.
			e.publishDraftState(ctx, scope, jobID)
		}
		return err
	}
	e.publish(ctx, branchEvent(scope.Tenant, BranchDraft, view))
	return nil
}

// publishDraftState republishes the branch of a draft job.
func (e *Engine) publishDraftState(ctx context.Context, scope Scope, jobID string) {
	job, err := e.store.GetJob(ctx, jobID)
	if err != nil || job.LineID == "" {
		return
	}
	e.publish(ctx, e.branchEvents(ctx, scope, BranchDraft, []string{job.LineID})...)
}
