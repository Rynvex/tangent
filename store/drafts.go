package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Drafting a conclusion card. A draft is a card_draft job: claiming it stops
// the branch from taking turns, and only that job's result, in time and
// while the branch is open, is stored. The stored draft is the neutralised
// outcome, never the model's raw output.

// draftInput is the card_draft job's input: the cursors at the claim.
type draftInput struct {
	UptoSeq            int64  `json:"uptoSeq"`
	ParentTipMessageID string `json:"parentTipMessageId"`
}

// DraftClaim is a started draft: its job, the branch (now drafting), the
// newest branch message the draft reads and the parent's tip at the claim
// (the baseline for "the parent moved on").
type DraftClaim struct {
	Job                Job
	Branch             domain.BranchView
	UptoSeq            int64
	ParentTipMessageID string
}

// ClaimBranchDraft marks the branch drafting under its line's row lock, so
// no turn can start while the draft reads the conversation, and records a
// card_draft job (a timed-out earlier draft's job is superseded).
func (s *Store) ClaimBranchDraft(ctx context.Context, tenant, lineID string, hooks ...TxHook) (DraftClaim, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (DraftClaim, error) {
		held, err := s.lockBranch(ctx, q, tenant, lineID, false)
		if err != nil {
			return DraftClaim{}, err
		}
		if err := s.requireDraftable(ctx, q, held); err != nil {
			return DraftClaim{}, err
		}
		upto, err := q.LatestRelevantMessage(ctx, held.child.ID)
		if err != nil {
			return DraftClaim{}, lookup(err, domain.ErrBranchNoMessages, "latest branch message")
		}
		tip, err := latestRelevant(ctx, q, held.row.ParentLineID)
		if err != nil {
			return DraftClaim{}, err
		}
		input, err := json.Marshal(draftInput{UptoSeq: upto.Seq, ParentTipMessageID: tip})
		if err != nil {
			return DraftClaim{}, fmt.Errorf("marshal draft input: %w", err)
		}
		job, err := s.createJob(ctx, q, CreateJobInput{
			Tenant: tenant, Kind: JobKindCardDraft, LineID: lineID, Input: input, Supersede: true,
		})
		if err != nil {
			return DraftClaim{}, err
		}
		if _, err := q.ClaimBranchDraft(ctx, db.ClaimBranchDraftParams{
			LineID: held.child.ID, DraftJobID: job.ID, DraftStartedAt: pgtype.Timestamptz{Time: s.now(), Valid: true},
			DraftUptoSeq: pgtype.Int8{Int64: upto.Seq, Valid: true}, DraftParentTipMessageID: nullID(tip),
		}); err != nil {
			return DraftClaim{}, fmt.Errorf("claim draft: %w", err)
		}
		out := DraftClaim{Job: jobFromRow(job), UptoSeq: upto.Seq, ParentTipMessageID: tip}
		out.Branch, err = s.branchViewOf(ctx, q, tenant, held.child.ID)
		return out, err
	})
}

// requireDraftable refuses a draft of a closed, busy, already drafting or
// empty branch.
func (s *Store) requireDraftable(ctx context.Context, q *db.Queries, held lockedBranch) error {
	if held.row.Status != domain.BranchStatusOpen {
		return domain.ErrBranchClosed
	}
	if err := s.requireBranchAcceptsTurn(ctx, q, held.child); err != nil {
		return err
	}
	if err := requireNoPendingTurn(ctx, q, held.child.ID, domain.ErrBranchBusy); err != nil {
		return err
	}
	has, err := q.HasConversationMessage(ctx, held.child.ID)
	if err != nil {
		return fmt.Errorf("check branch messages: %w", err)
	}
	if !has {
		return domain.ErrBranchNoMessages
	}
	return nil
}

// FinishBranchDraft stores the outcome of the draft the job was started for
// and finishes the job (done for a ready card, failed otherwise). Nothing is
// written, and ErrDraftNotPending returned, when the job is not a pending
// draft, was superseded by a newer claim, ran past the draft timeout, or the
// branch is no longer open; the job is then marked superseded or failed.
func (s *Store) FinishBranchDraft(ctx context.Context, jobID string, outcome domain.BranchDraftOutcome, hooks ...TxHook) (domain.BranchView, error) {
	if outcome.Status != domain.BranchDraftReady && outcome.Status != domain.BranchDraftFailed {
		return domain.BranchView{}, invalidInput("a draft finishes as ready or failed")
	}
	payload, err := draftPayload(outcome)
	if err != nil {
		return domain.BranchView{}, err
	}
	peek, err := s.GetJob(ctx, jobID)
	if err != nil {
		return domain.BranchView{}, err
	}
	if peek.Kind != JobKindCardDraft || peek.LineID == "" || peek.Status != JobPending {
		return domain.BranchView{}, domain.ErrDraftNotPending
	}
	view, err := runTx(ctx, s, hooks, func(q *db.Queries) (domain.BranchView, error) {
		held, job, err := s.lockDraftJob(ctx, q, peek, jobID)
		if err != nil {
			return domain.BranchView{}, err
		}
		_, err = q.FinishBranchDraft(ctx, db.FinishBranchDraftParams{
			LineID: held.child.ID, DraftJobID: job.ID, DraftStatus: outcome.Status, Draft: payload,
			StartedAfter: pgtype.Timestamptz{Time: s.now().Add(-s.limits.Branch.DraftTimeout), Valid: true},
		})
		if noRows(err) {
			return domain.BranchView{}, errDraftStale
		}
		if err != nil {
			return domain.BranchView{}, fmt.Errorf("finish draft: %w", err)
		}
		status := JobDone
		if outcome.Status == domain.BranchDraftFailed {
			status = JobFailed
		}
		if _, err := finishJob(ctx, q, job.ID, status, outcome.Error); err != nil {
			return domain.BranchView{}, err
		}
		return s.branchViewOf(ctx, q, peek.TenantID, held.child.ID)
	})
	if errors.Is(err, errDraftStale) {
		return domain.BranchView{}, s.retireStaleDraft(ctx, peek, jobID)
	}
	return view, err
}

// errDraftStale rolls back a draft result that may not be written.
var errDraftStale = errors.New("the draft result is stale")

// lockDraftJob locks the draft's branch line, then its job, and checks the
// job is still pending.
func (s *Store) lockDraftJob(ctx context.Context, q *db.Queries, peek Job, jobID string) (lockedBranch, db.TangentJob, error) {
	held, err := s.lockBranch(ctx, q, peek.TenantID, peek.LineID, false)
	if errors.Is(err, domain.ErrBranchNotFound) {
		return lockedBranch{}, db.TangentJob{}, domain.ErrDraftNotPending // the branch went away
	}
	if err != nil {
		return lockedBranch{}, db.TangentJob{}, err
	}
	job, err := lockJob(ctx, q, jobID)
	if errors.Is(err, domain.ErrJobNotFound) {
		return lockedBranch{}, db.TangentJob{}, domain.ErrDraftNotPending
	}
	if err != nil {
		return lockedBranch{}, db.TangentJob{}, err
	}
	if job.Status != JobPending {
		return lockedBranch{}, db.TangentJob{}, domain.ErrDraftNotPending
	}
	return held, job, nil
}

// retireStaleDraft ends, in its own transaction, the job of a draft result
// that came too late, and reports ErrDraftNotPending.
func (s *Store) retireStaleDraft(ctx context.Context, peek Job, jobID string) error {
	_, err := runTx(ctx, s, nil, func(q *db.Queries) (struct{}, error) {
		held, job, err := s.lockDraftJob(ctx, q, peek, jobID)
		if err != nil {
			return struct{}{}, err
		}
		return struct{}{}, s.retireDraftJob(ctx, q, held, job)
	})
	if err != nil && !errors.Is(err, domain.ErrDraftNotPending) {
		return err
	}
	return domain.ErrDraftNotPending
}

// retireDraftJob ends a draft job whose result came too late: failed when it
// is still the branch's draft and timed out, superseded otherwise.
func (s *Store) retireDraftJob(ctx context.Context, q *db.Queries, held lockedBranch, job db.TangentJob) error {
	current := held.row.Status == domain.BranchStatusOpen && held.row.DraftJobID.Valid && held.row.DraftJobID.UUID == job.ID && held.row.DraftStatus == domain.BranchDraftDrafting
	if current {
		_, err := finishJob(ctx, q, job.ID, JobFailed, domain.DraftTimeoutText)
		return err
	}
	_, err := q.FinishJob(ctx, db.FinishJobParams{ID: job.ID, Status: JobSuperseded})
	if err != nil {
		return fmt.Errorf("supersede draft job: %w", err)
	}
	return nil
}

func draftPayload(outcome domain.BranchDraftOutcome) ([]byte, error) {
	if outcome.Warnings == nil {
		outcome.Warnings = []string{}
	}
	payload, err := json.Marshal(outcome)
	if err != nil {
		return nil, fmt.Errorf("marshal draft: %w", err)
	}
	return payload, nil
}

// GetBranchDraft reads a branch's draft state.
func (s *Store) GetBranchDraft(ctx context.Context, tenant, lineID string) (domain.BranchDraft, error) {
	id, ok := parseID(lineID)
	if !ok {
		return domain.BranchDraft{}, domain.ErrBranchNotFound
	}
	row, err := s.q.GetBranch(ctx, id)
	if err != nil {
		return domain.BranchDraft{}, lookup(err, domain.ErrBranchNotFound, "get branch draft")
	}
	if row.TenantID != tenant {
		return domain.BranchDraft{}, domain.ErrBranchNotFound
	}
	return s.draftFromRow(row)
}

// draftFromRow is the draft as the operator reads it: an overdue draft is
// failed with the fixed timeout reason, a card only when ready. A stored
// draft that does not decode is an error, never an empty draft.
func (s *Store) draftFromRow(row db.TangentBranch) (domain.BranchDraft, error) {
	var payload domain.BranchDraftOutcome
	if len(row.Draft) > 0 {
		if err := json.Unmarshal(row.Draft, &payload); err != nil {
			return domain.BranchDraft{}, fmt.Errorf("decode the stored draft of branch %s: %w", row.LineID, err)
		}
	}
	draft := domain.BranchDraft{
		Status: s.draftStatus(row), Warnings: payload.Warnings, Error: payload.Error, Provider: payload.Provider, Model: payload.Model,
		StartedAt: timePtr(row.DraftStartedAt), UptoSeq: row.DraftUptoSeq.Int64,
		ParentTipMessageID: idString(row.DraftParentTipMessageID), ManualCardAvailable: true,
	}
	if draft.Warnings == nil {
		draft.Warnings = []string{}
	}
	draft.NoteChanges = []domain.NoteChange{}
	if draft.Status == domain.BranchDraftReady {
		draft.Card = payload.Card
		if payload.NoteChanges != nil {
			draft.NoteChanges = payload.NoteChanges
		}
	}
	if draft.Status == domain.BranchDraftFailed && draft.Error == "" && row.DraftStatus == domain.BranchDraftDrafting {
		draft.Error = domain.DraftTimeoutText
	}
	return draft, nil
}
