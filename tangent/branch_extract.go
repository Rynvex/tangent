package tangent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// ExtractInput moves the messages of a line from FromMessageID to
// ToMessageID (both included, seq order) into a new branch of it (B18).
// Kind is investigate (the default) or alternative. Card, when set, brings
// the branch back at once: it is checked like a merge's card and left on the
// line in the range's place, already delivered.
type ExtractInput struct {
	FromMessageID string
	ToMessageID   string
	Purpose       string
	Kind          string
	Provider      string
	Model         string
	ConfirmDeeper bool
	Card          *domain.BranchCard
	HostMeta      json.RawMessage
}

// ExtractedBranch is what an extract changed.
type ExtractedBranch = store.ExtractedBranch

// ExtractToBranch is MoveToBranch for any stretch of a line, the middle
// included: the branch hangs on the newest finished message before the
// range (an operator or assistant message, or a conclusion card), the range
// moves into it keeping its order, and the line keeps a move marker (or the
// card) where the range was, so its later prompts read on in order. Branches
// opened on moved messages go with them one level deeper; a summary that
// covered them is reset; folds cut by the range are removed and folds
// inside it move with it; when the line goes on after the range, its
// chapter keeps its start on the marker. No job is started.
// InTx hooks receive store.ExtractedBranch.
func (e *Engine) ExtractToBranch(ctx context.Context, scope Scope, lineID string, in ExtractInput, opts ...TxOption) (ExtractedBranch, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return ExtractedBranch{}, err
	}
	kind := strings.TrimSpace(in.Kind)
	if kind == "" {
		kind = domain.BranchKindInvestigate
	}
	if kind != domain.BranchKindInvestigate && kind != domain.BranchKindAlternative {
		return ExtractedBranch{}, domain.ErrKindUnsupported
	}
	purpose, ok := domain.NormalizeBranchPurpose(in.Purpose, e.limits.Branch)
	if !ok {
		return ExtractedBranch{}, domain.ErrInvalidPurpose
	}
	if err := e.branchModel(ctx, scope, lineID, in.Provider, in.Model); err != nil {
		return ExtractedBranch{}, err
	}
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	storeIn := store.ExtractInput{
		CreateBranchInput: store.CreateBranchInput{
			Tenant: scope.Tenant, ParentLineID: lineID, Purpose: purpose, Kind: kind, Provider: in.Provider,
			Model: in.Model, CreatedBy: scope.Actor, ConfirmDeeper: in.ConfirmDeeper, HostMeta: in.HostMeta,
		},
		FromMessageID: strings.TrimSpace(in.FromMessageID), ToMessageID: strings.TrimSpace(in.ToMessageID),
		BuildPack: func(base store.MovePackBase) domain.BranchPack {
			return e.extractPack(base, purpose, e.packUsesSummary(modes))
		},
	}
	if in.Card != nil {
		if err := e.extractCard(ctx, scope, modes, lineID, purpose, *in.Card, &storeIn); err != nil {
			return ExtractedBranch{}, err
		}
	}
	call := newTxCall(modes, scope, commitBranchCreated, in)
	extracted, err := e.store.ExtractToBranch(ctx, storeIn, e.txHooks(call, e.features.onBranchCreated, opts)...)
	if err != nil {
		return ExtractedBranch{}, err
	}
	e.publish(ctx, e.extractEvents(ctx, scope, modes, extracted)...)
	e.dispatchOrphanJobs(ctx, e.commit(ctx, &commitEvent{kind: commitBranchCreated, scope: scope, modes: modes, change: BranchMoved, branch: &extracted.Branch, out: call.out}))
	return extracted, nil
}

// extractPack builds an extracted branch's pack from what stays before the
// range (the anchor may be a conclusion card).
func (e *Engine) extractPack(base store.MovePackBase, purpose string, withSummary bool) domain.BranchPack {
	in := domain.BranchPackInput{
		Purpose: purpose, Messages: base.Remaining, AnchorMessageID: base.Anchor.ID, CardAnchor: true,
		ExtraMarkers: e.markers, Limits: e.limits.Pack,
	}
	if withSummary {
		in.Summary, in.SummaryUptoSeq = base.Summary, base.SummaryUptoSeq
	}
	return domain.BuildBranchPack(in)
}

// extractCard checks an extract's card the way a merge checks one (shape
// first, then every message it cites) and fills in what the store writes:
// the card, its rendering and, with the leaf feature on, the conclusion
// leaf a merge would write.
func (e *Engine) extractCard(ctx context.Context, scope Scope, modes modeSet, lineID, purpose string, card domain.BranchCard, out *store.ExtractInput) error {
	if problems := domain.CheckBranchCardShape(card); len(problems) > 0 {
		return domain.CardError(problems)
	}
	refs, err := e.extractCardRefs(ctx, scope, lineID, out.FromMessageID, out.ToMessageID, card)
	if err != nil {
		return err
	}
	checked, problems := domain.ValidateBranchCard(card, refs)
	if len(problems) > 0 {
		return domain.CardError(problems)
	}
	out.Card, out.CardContent = &checked, domain.RenderBranchCardMarkdown(checked, purpose)
	if modes.of(FeatureLeaf) != ModeOff {
		leaf := domain.LeafFromCard(checked, e.limits.Leaf)
		out.Leaf = &leaf
	}
	return nil
}

// extractCardRefs loads what an extract's card cites (at most
// BranchCardMaxReferences ids): branch-side ids must be finished operator
// or assistant messages of the range (they become the branch's), parent-side
// ids relevant finished messages of the line after the range (what stays
// after the anchor). The ends are read here too, so an end that is not on
// the line is message_not_found before anything else.
func (e *Engine) extractCardRefs(ctx context.Context, scope Scope, lineID, fromID, toID string, card domain.BranchCard) (domain.BranchCardRefs, error) {
	refs := domain.BranchCardRefs{Messages: map[string]string{}, ParentAfterAnchor: map[string]bool{}}
	from, err := e.store.GetMessage(ctx, scope.Tenant, lineID, fromID)
	if err != nil {
		return refs, err
	}
	to, err := e.store.GetMessage(ctx, scope.Tenant, lineID, toID)
	if err != nil {
		return refs, err
	}
	branchIDs, parentIDs := card.CappedReferencedIDs()
	for _, id := range branchIDs {
		message, found, err := e.lineMessage(ctx, scope, lineID, id)
		if err != nil {
			return refs, err
		}
		if found && message.Seq >= from.Seq && message.Seq <= to.Seq && domain.ExtractableMessage(message.Role, message.Kind, message.Status) {
			refs.Messages[id] = message.Content
		}
	}
	for _, id := range parentIDs {
		message, found, err := e.lineMessage(ctx, scope, lineID, id)
		if err != nil {
			return refs, err
		}
		relevant := message.Role != domain.RoleSystem || message.IsCard()
		if found && message.Status == domain.MessageDone && relevant && message.Seq > to.Seq {
			refs.ParentAfterAnchor[id] = true
		}
	}
	return refs, nil
}

// lineMessage reads a message of the line; found is false when it is not one.
func (e *Engine) lineMessage(ctx context.Context, scope Scope, lineID, id string) (domain.Message, bool, error) {
	message, err := e.store.GetMessage(ctx, scope.Tenant, lineID, id)
	if errors.Is(err, domain.ErrMessageNotFound) {
		return domain.Message{}, false, nil
	}
	if err != nil {
		return domain.Message{}, false, err
	}
	return message, true, nil
}

// extractEvents: the new branch line, the marker or card on the source, the
// source line, the new branch and every branch that moved along with the
// messages, then (with their features on) the folds that changed, the leaf
// a card wrote and the source's chapters when a cut moved onto the marker.
func (e *Engine) extractEvents(ctx context.Context, scope Scope, modes modeSet, out ExtractedBranch) []Event {
	events := []Event{
		lineEvent(EventLineCreated, out.Line),
		messageEvent(EventMessageCreated, scope.Tenant, out.RootLineID, out.Marker),
	}
	events = append(events, e.lineEvents(ctx, scope, out.SourceLineID)...)
	events = append(events, branchEvent(scope.Tenant, BranchMoved, out.Branch))
	events = append(events, e.branchEvents(ctx, scope, BranchMoved, out.Reparented)...)
	if modes.of(FeatureFold) != ModeOff {
		for _, fold := range out.Folds {
			events = append(events, foldEvent(scope.Tenant, out.RootLineID, fold))
		}
	}
	if out.Leaf != nil {
		events = append(events, leafEvent(scope, out.Leaf.LineID, out.RootLineID, out.Leaf))
	}
	if out.MovedCuts > 0 && modes.of(FeatureChapters) != ModeOff {
		events = append(events, chaptersChanged(scope, out.RootLineID, out.SourceLineID))
	}
	return events
}
