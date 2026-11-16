package tangent

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Jobs of the diverge feature.
const (
	// JobKindDiverge proposes directions that become sibling branches.
	JobKindDiverge = store.JobKindDiverge
	// JobKindConverge fills a comparison's criteria × options matrix.
	JobKindConverge = store.JobKindConverge
)

// Diverge explores and settles alternatives (DESIGN §12 B10): diverging
// asks a model for N (2–5) distinct directions from a message, and each
// becomes a sibling branch hanging on it (kind alternative, origin
// diverge; its pack names its direction and the others). Converging
// compares open sibling branches in a criteria × options matrix with
// scores, reasons and a recommendation (a converge job → a comparison);
// deciding, in one transaction, gives the chosen branch a decision leaf and
// discards the other compared branches with a dead-end leaf. Every step is
// the operator's (any mode; nothing happens by itself). Needs leaf. Off:
// the calls return feature_disabled; comparisons are kept.
func Diverge(mode Mode, opts ...FeatureOption) Feature {
	return &module{name: FeatureDiverge, ai: true, configured: mode, requires: []string{FeatureLeaf}, cfg: newFeatureConfig(opts), attach: registerDiverge}
}

func registerDiverge(r *registry, _ *module) {
	r.addJobHandler(JobKindDiverge, jobHandler{timeout: goalJobTimeout, finish: finishDiverge, onStale: staleJobFailed})
	r.addJobHandler(JobKindConverge, jobHandler{timeout: goalJobTimeout, finish: finishConverge, onStale: staleConverge})
}

// DivergeInput asks for Count directions from a finished message of the
// line.
type DivergeInput struct {
	AnchorMessageID string
	Count           int
}

// divergeJobInput is what a diverge job remembers.
type divergeJobInput struct {
	AnchorMessageID string `json:"anchorMessageId"`
	Count           int    `json:"count"`
	Actor           string `json:"actor"`
}

// StartDiverge starts a diverge job: Count (2–5) directions from the
// anchor, a finished operator or assistant message of the line
// (anchor_not_found), with room for that many more open branches under it
// (branch_limit). Its branches are opened when the job finishes.
// InTx hooks receive store.Job.
func (e *Engine) StartDiverge(ctx context.Context, scope Scope, lineID string, in DivergeInput, opts ...TxOption) (Job, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureDiverge)
	if err != nil {
		return Job{}, err
	}
	if err := domain.CheckDivergeCount(in.Count, e.limits.Diverge); err != nil {
		return Job{}, err
	}
	line, messages, err := e.divergeContext(ctx, scope, lineID, in)
	if err != nil {
		return Job{}, err
	}
	input, _ := json.Marshal(divergeJobInput{AnchorMessageID: in.AnchorMessageID, Count: in.Count, Actor: scope.Actor})
	record, err := e.startJob(ctx, scope, store.CreateJobInput{Kind: JobKindDiverge, Feature: FeatureDiverge, LineID: line.ID, Input: input}, opts)
	if err != nil {
		return Job{}, err
	}
	about := line.Title
	if line.ConversationBranch != nil {
		about = line.ConversationBranch.Purpose
	}
	text := domain.BuildDivergePrompt(domain.DivergeInput{Context: about, Messages: messages, Count: in.Count, ExtraMarkers: e.markers})
	return e.lineJob(record, scope, FeatureDiverge, line, text), nil
}

// divergeContext checks the anchor and the room for the branches and reads
// the conversation up to the anchor.
func (e *Engine) divergeContext(ctx context.Context, scope Scope, lineID string, in DivergeInput) (domain.LineView, []domain.Message, error) {
	line, err := e.store.GetLine(ctx, scope.Tenant, lineID)
	if err != nil {
		return domain.LineView{}, nil, err
	}
	anchor, err := e.store.GetMessage(ctx, scope.Tenant, lineID, in.AnchorMessageID)
	if err != nil || !conversationMessage(anchor) || anchor.Kind != domain.MessageKindChat {
		return domain.LineView{}, nil, domain.ErrBranchAnchorNotFound
	}
	if line.BranchCounts.Open+in.Count > e.limits.Branch.MaxOpenPerParent {
		return domain.LineView{}, nil, domain.ErrBranchLimit
	}
	upTo, err := e.store.MessagesUpToAnchor(ctx, scope.Tenant, lineID, anchor.ID)
	if err != nil {
		return domain.LineView{}, nil, err
	}
	messages := conversationOnly(upTo)
	if n := e.limits.Diverge.ContextMessages; len(messages) > n {
		messages = messages[len(messages)-n:]
	}
	return line, messages, nil
}

// lineJob is a feature's job on a line the caller has read.
func (e *Engine) lineJob(record JobRecord, scope Scope, feature string, line domain.LineView, text string) Job {
	provider, model := e.configOf(feature).jobModel(line.Provider, line.Model)
	return Job{ID: record.ID, Kind: record.Kind, Feature: feature, Scope: scope, LineID: line.ID, Prompt: jobPrompt(text), Provider: provider, Model: model}
}

// finishDiverge opens the proposed directions as sibling branches, all or
// none; a refusal (the limits, the anchor gone) fails the job with its
// reason.
func finishDiverge(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
	var in divergeJobInput
	_ = json.Unmarshal(job.Input, &in)
	directions, parseErr := domain.ParseDiverge(raw, in.Count, e.limits)
	scope := Scope{Tenant: job.TenantID, Actor: in.Actor}
	modes := e.modesFor(ctx, scope)
	if runErr != nil || parseErr != nil || modes.of(FeatureDiverge) == ModeOff {
		_, err := e.finishFeatureJob(ctx, job, runErr, parseErr)
		return err
	}
	branches, err := e.divergeBranches(ctx, scope, modes, job.LineID, in.AnchorMessageID, directions)
	if err == nil {
		var out store.DivergedBranches
		out, err = e.store.CreateDivergeBranches(ctx, job.ID, store.DivergeInput{Tenant: scope.Tenant, ParentLineID: job.LineID, Branches: branches, Actor: in.Actor})
		if err == nil {
			e.publishDiverged(ctx, scope, modes, out)
			return nil
		}
	}
	return e.refuseDiverge(ctx, job, err)
}

// divergeBranches builds each direction's branch with its pack (outside
// the lock, like CreateBranch).
func (e *Engine) divergeBranches(ctx context.Context, scope Scope, modes modeSet, parentID, anchorID string, directions []domain.DivergeDirection) ([]store.CreateBranchInput, error) {
	purposes := make([]string, 0, len(directions))
	for _, d := range directions {
		purposes = append(purposes, d.Purpose)
	}
	out := make([]store.CreateBranchInput, 0, len(directions))
	for _, d := range directions {
		in, err := e.normalizeBranchInput(BranchInput{AnchorMessageID: anchorID, Purpose: d.Purpose, Kind: domain.BranchKindAlternative})
		if err != nil {
			return nil, err
		}
		pack, err := e.buildPack(ctx, scope, e.packUsesSummary(modes), parentID, in)
		if err != nil {
			return nil, err
		}
		pack.Rendered += domain.BuildDivergeNote(d, purposes)
		pack.TokenEstimate = domain.EstimatePackTokens(pack.Rendered)
		out = append(out, store.CreateBranchInput{AnchorMessageID: anchorID, Purpose: in.Purpose, Kind: in.Kind, Pack: pack})
	}
	return out, nil
}

// refuseDiverge fails a diverge job whose branches were refused: the
// refusal's message is the job's error (job.failed, code failed).
func (e *Engine) refuseDiverge(ctx context.Context, job JobRecord, err error) error {
	refusal := domain.AsError(err, e.limits)
	if refusal == nil {
		return err
	}
	reason := "the branches could not be opened: " + refusal.Message
	if _, failErr := e.store.FinishJob(ctx, job.ID, store.JobFailed, reason); failErr != nil {
		if errors.Is(failErr, domain.ErrJobNotPending) {
			return nil
		}
		return failErr
	}
	e.publishJobFailed(ctx, job, reason)
	return nil
}

// publishDiverged publishes each new branch as CreateBranch does and runs
// the AfterCommit hooks of a created branch.
func (e *Engine) publishDiverged(ctx context.Context, scope Scope, modes modeSet, out store.DivergedBranches) {
	for _, created := range out.Created {
		e.publish(ctx, e.createdEvents(ctx, scope, created.Line, created.Branch)...)
		branch := created.Branch
		e.dispatchOrphanJobs(ctx, e.commit(ctx, &commitEvent{kind: commitBranchCreated, scope: scope, modes: modes, change: BranchCreated, branch: &branch, out: &txOutbox{}}))
	}
}
