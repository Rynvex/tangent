package tangent

import (
	"context"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// AttachInput attaches another conversation of the tenant (SourceLineID, a
// main line) as a branch of a line (B20), the inverse of a detach.
// AnchorMessageID empty picks the newest anchorable message of the line
// dated no later than the source's start (else its newest). Purpose empty
// is the source's title (else its first question). Kind is investigate (the
// default) or alternative; Status open (the default) or merged, which
// needs Card (an empty question is the purpose) and leaves it on the line
// already delivered.
type AttachInput struct {
	SourceLineID    string
	AnchorMessageID string
	Purpose         string
	Kind            string
	Status          string
	Card            *domain.BranchCard
	ConfirmDeeper   bool
}

// errAttachNoSource refuses an attach that names no source.
var errAttachNoSource = domain.NewError(domain.CodeInvalidInput, "sourceLineId is required", map[string]any{"field": "sourceLineId"})

// AttachedLine is what an attach changed.
type AttachedLine = store.AttachedLine

// AttachLine hangs the source conversation, with its whole tree, on the
// line: the source keeps its messages (and their seq) and becomes a branch
// line (its folder, tags and origin capsule go), its branches go one level
// deeper per the new branch's depth, and its notes, memos, seeds, leaves,
// chapter cuts, suggestions and groups move to the line's conversation (its
// goal goes). The branch limits count the source's tree. With a card, the
// branch is merged at once and, while leaf is on, the card is written as its
// confirmed leaf. No feature hook runs and no job is started.
// InTx hooks receive store.AttachedLine.
func (e *Engine) AttachLine(ctx context.Context, scope Scope, lineID string, in AttachInput, opts ...TxOption) (AttachedLine, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return AttachedLine{}, err
	}
	if strings.TrimSpace(in.SourceLineID) == "" {
		return AttachedLine{}, errAttachNoSource
	}
	kind, err := domain.NormalizeAttachKind(in.Kind)
	if err != nil {
		return AttachedLine{}, err
	}
	status, err := domain.NormalizeAttachStatus(in.Status)
	if err != nil {
		return AttachedLine{}, err
	}
	if strings.TrimSpace(in.Purpose) != "" {
		if _, ok := domain.NormalizeBranchPurpose(in.Purpose, e.limits.Branch); !ok {
			return AttachedLine{}, domain.ErrInvalidPurpose
		}
	}
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	out, err := e.store.AttachLine(ctx, store.AttachInput{
		Tenant: scope.Tenant, TargetLineID: lineID, SourceLineID: strings.TrimSpace(in.SourceLineID),
		AnchorMessageID: strings.TrimSpace(in.AnchorMessageID), Purpose: in.Purpose, Kind: kind, Status: status, Card: in.Card,
		Leaf: modes.of(FeatureLeaf) != ModeOff, ConfirmDeeper: in.ConfirmDeeper, CreatedBy: scope.Actor,
		BuildPack: func(base store.MovePackBase, purpose string) domain.BranchPack {
			return e.extractPack(base, purpose, e.packUsesSummary(modes))
		},
	}, hooksOf(opts)...)
	if err != nil {
		return AttachedLine{}, err
	}
	e.publish(ctx, e.attachEvents(ctx, scope, modes, out)...)
	e.dispatchOrphanJobs(ctx, e.commit(ctx, &commitEvent{kind: commitBranchCreated, scope: scope, modes: modes, change: BranchCreated, branch: &out.Branch, out: &txOutbox{}}))
	return out, nil
}

// attachEvents: the source line (now a branch line), the card on the
// target, the target line (and its main line), the new branch (created,
// then merged with a card) and the branches that came along (moved), then
// what moved with the tree: the leaf a card wrote, the notes, the seeds,
// the chapters, the groups and the suggestions that expired.
func (e *Engine) attachEvents(ctx context.Context, scope Scope, modes modeSet, out AttachedLine) []Event {
	events := []Event{lineEvent(EventLineUpdated, out.BranchLine)}
	if out.CardMessage != nil {
		events = append(events, messageEvent(EventMessageCreated, scope.Tenant, out.RootLineID, *out.CardMessage))
	}
	reload := []string{out.TargetLine.ID}
	if out.RootLineID != out.TargetLine.ID {
		reload = append(reload, out.RootLineID)
	}
	events = append(events, e.lineEvents(ctx, scope, reload...)...)
	events = append(events, branchEvent(scope.Tenant, BranchCreated, out.Branch))
	if out.CardMessage != nil {
		events = append(events, branchEvent(scope.Tenant, BranchMerged, out.Branch))
	}
	events = append(events, e.branchEvents(ctx, scope, BranchMoved, out.Reparented)...)
	if out.Leaf != nil {
		events = append(events, leafEvent(scope, out.Leaf.LineID, out.RootLineID, out.Leaf))
	}
	return append(events, e.attachTreeEvents(ctx, scope, modes, out)...)
}

// attachTreeEvents are the events of the rows that moved with the tree.
func (e *Engine) attachTreeEvents(ctx context.Context, scope Scope, modes modeSet, out AttachedLine) []Event {
	var events []Event
	if out.NotesRevision > 0 {
		events = append(events, notesChanged(scope, out.RootLineID, out.NotesRevision))
	}
	if out.Moved.Seeds > 0 {
		events = append(events, e.seedEvents(ctx, scope, out.RootLineID)...)
	}
	if out.Moved.ChapterCuts > 0 && modes.of(FeatureChapters) != ModeOff {
		events = append(events, chaptersChanged(scope, out.RootLineID, out.BranchLine.ID))
	}
	for _, group := range out.Groups {
		events = append(events, groupEvent(scope.Tenant, group))
	}
	return append(events, e.suggestionEvents(ctx, scope, out.ExpiredSuggestions...)...)
}
