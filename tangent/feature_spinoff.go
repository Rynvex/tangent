package tangent

import (
	"context"
	"errors"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Spinoff makes a part of a conversation a new one (DESIGN §12 B8):
// detach turns an open branch, with everything below it, into a main line
// of its own; fresh starts a new main line from any finished message.
// The new main line starts every prompt with its origin capsule (the
// branch's pack, or the path to the message, and the branch's leaf while
// leaf is on); the source line keeps a marker and both are linked. Off:
// Spinoff and ListLinks return feature_disabled; spun-off lines keep their
// capsule.
func Spinoff() Feature { return onOff(FeatureSpinoff, nil) }

// SpinoffInput is one spinoff. Mode is detach or fresh; AtMessageID (fresh)
// is the message of the line to start from. Title defaults to the branch's
// purpose (detach) or the line's title (fresh). CopyNotes copies the
// conversation's active notes into the new one, each pointing at its
// original.
type SpinoffInput struct {
	Mode        string
	AtMessageID string
	Title       string
	CopyNotes   bool
}

// SpunOff is what a spinoff changed.
type SpunOff = store.SpunOff

// LinkChange is the data of link.changed: a link that touches the tree.
// Deleted is set when the link (a relation) was removed.
type LinkChange struct {
	RootLineID string      `json:"rootLineId"`
	Link       domain.Link `json:"link"`
	Deleted    bool        `json:"deleted,omitempty"`
}

// errSpinoffMode refuses a mode that is neither detach nor fresh.
var errSpinoffMode = domain.NewError(domain.CodeInvalidInput, "mode must be detach or fresh", nil)

// Spinoff spins the line (detach: the branch; fresh: the line's message)
// off into a new conversation.
// InTx hooks receive store.SpunOff.
func (e *Engine) Spinoff(ctx context.Context, scope Scope, lineID string, in SpinoffInput, opts ...TxOption) (SpunOff, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureSpinoff)
	if err != nil {
		return SpunOff{}, err
	}
	ctx = e.inbox(ctx, modes)
	in.Mode, in.Title = strings.TrimSpace(in.Mode), strings.TrimSpace(in.Title)
	if err := checkText("title", in.Title, e.limits.Text.TitleMaxRunes); err != nil {
		return SpunOff{}, err
	}
	switch in.Mode {
	case domain.SpinoffDetach:
		return e.detach(ctx, scope, modes, lineID, in, opts)
	case domain.SpinoffFresh:
		return e.spinOffFresh(ctx, scope, modes, lineID, in, opts)
	}
	return SpunOff{}, errSpinoffMode
}

func (e *Engine) detach(ctx context.Context, scope Scope, modes modeSet, lineID string, in SpinoffInput, opts []TxOption) (SpunOff, error) {
	call := newTxCall(modes, scope, commitBranchClosed, in)
	out, err := e.store.Detach(ctx, store.DetachInput{
		Tenant: scope.Tenant, LineID: lineID, Title: in.Title, Actor: scope.Actor, CopyNotes: in.CopyNotes,
		WithLeaf: e.cooperates(modes, capLeafCapsule), BuildCapsule: e.detachCapsule,
	}, e.txHooks(call, e.features.onBranchClosed, opts)...)
	if err != nil {
		return SpunOff{}, err
	}
	events := append(e.spinoffEvents(ctx, scope, out), branchEvent(scope.Tenant, BranchDetached, out.Branch))
	e.publish(ctx, append(events, e.branchEvents(ctx, scope, BranchMoved, out.Moved)...)...)
	if out.MovedSeeds > 0 {
		e.publish(ctx, e.seedEvents(ctx, scope, out.Line.ID)...)
		e.publish(ctx, e.seedEvents(ctx, scope, out.OldRootLineID)...)
	}
	for _, group := range out.DissolvedGroups {
		e.publish(ctx, groupEvent(scope.Tenant, group))
	}
	e.publish(ctx, e.suggestionEvents(ctx, scope, out.ExpiredSuggestions...)...)
	ev := &commitEvent{kind: commitBranchClosed, scope: scope, modes: modes, change: BranchDetached, branch: &out.Branch, request: in, out: call.out}
	e.dispatchOrphanJobs(ctx, e.commit(ctx, ev))
	return out, nil
}

func (e *Engine) spinOffFresh(ctx context.Context, scope Scope, modes modeSet, lineID string, in SpinoffInput, opts []TxOption) (SpunOff, error) {
	source, err := e.store.GetLine(ctx, scope.Tenant, lineID)
	if err != nil {
		return SpunOff{}, err
	}
	if in.Title == "" {
		in.Title = source.Title
	}
	capsule, err := e.freshCapsule(ctx, scope, modes, source, in)
	if err != nil {
		return SpunOff{}, err
	}
	out, err := e.store.SpinOffFresh(ctx, store.FreshInput{
		Tenant: scope.Tenant, LineID: lineID, AtMessageID: in.AtMessageID, Title: in.Title, Actor: scope.Actor, CopyNotes: in.CopyNotes, Capsule: capsule,
	}, hooksOf(opts)...)
	if err != nil {
		return SpunOff{}, err
	}
	e.publish(ctx, e.spinoffEvents(ctx, scope, out)...)
	return out, nil
}

// freshCapsule builds a fresh spinoff's capsule outside the lock: the
// source branch's pack, the source line's conversation up to the message
// (as a pack would quote it) and the branch's leaf.
func (e *Engine) freshCapsule(ctx context.Context, scope Scope, modes modeSet, source domain.LineView, in SpinoffInput) (domain.OriginCapsule, error) {
	messages, err := e.store.MessagesUpToAnchor(ctx, scope.Tenant, source.ID, strings.TrimSpace(in.AtMessageID))
	if errors.Is(err, domain.ErrMessageNotFound) {
		return domain.OriginCapsule{}, domain.ErrBranchAnchorNotFound
	}
	if err != nil {
		return domain.OriginCapsule{}, err
	}
	packIn := domain.BranchPackInput{
		Purpose: in.Title, Messages: messages, AnchorMessageID: strings.TrimSpace(in.AtMessageID), ExtraMarkers: e.markers, Limits: e.limits.Pack,
	}
	if e.packUsesSummary(modes) {
		packIn.Summary, packIn.SummaryUptoSeq = source.Summary, source.SummaryUptoSeq
	}
	if err := packIn.Check(); err != nil {
		return domain.OriginCapsule{}, err
	}
	capsuleIn := domain.OriginCapsuleInput{
		Mode: domain.SpinoffFresh, From: domain.SpunOffRef{LineID: source.ID, MessageID: packIn.AnchorMessageID, Title: source.Title},
		Path: domain.BuildBranchPack(packIn).Rendered, TokenBudget: e.limits.Spinoff.CapsuleTokenBudget, ExtraMarkers: e.markers,
	}
	if source.ConversationBranch != nil {
		if capsuleIn.Background, capsuleIn.Leaf, err = e.branchBackground(ctx, scope, modes, source.ID); err != nil {
			return domain.OriginCapsule{}, err
		}
	}
	return domain.BuildOriginCapsule(capsuleIn), nil
}

// branchBackground is a branch's stored pack and, while leaf is on, its leaf.
func (e *Engine) branchBackground(ctx context.Context, scope Scope, modes modeSet, lineID string) (string, *domain.Leaf, error) {
	detail, err := e.store.GetBranch(ctx, scope.Tenant, lineID)
	if err != nil {
		return "", nil, err
	}
	if !e.cooperates(modes, capLeafCapsule) {
		return detail.Pack.Rendered, nil, nil
	}
	leaf, err := e.store.GetLeaf(ctx, scope.Tenant, lineID)
	return detail.Pack.Rendered, leaf, err
}

// spinoffEvents: the new main line, the marker on the source line, the
// source line (and the old main line), the link in both trees and the
// copied notes.
func (e *Engine) spinoffEvents(ctx context.Context, scope Scope, out SpunOff) []Event {
	events := []Event{
		lineEvent(EventLineCreated, out.Line),
		messageEvent(EventMessageCreated, scope.Tenant, out.OldRootLineID, out.Marker),
	}
	reload := []string{out.SourceLineID}
	if out.OldRootLineID != out.SourceLineID {
		reload = append(reload, out.OldRootLineID)
	}
	events = append(events, e.lineEvents(ctx, scope, reload...)...)
	for _, root := range []string{out.OldRootLineID, out.Line.ID} {
		events = append(events, Event{
			Type: EventLinkChanged, Tenant: scope.Tenant, RootLineID: root, LineID: root, Data: LinkChange{RootLineID: root, Link: out.Link},
		})
	}
	return append(events, notesEvents(scope, out.Notes)...)
}

// ListLinks lists the links from or to any line of the line's tree, of the
// kinds whose feature is on (spinoff, relations); feature_disabled while
// neither is.
func (e *Engine) ListLinks(ctx context.Context, scope Scope, lineID string) ([]domain.Link, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return nil, err
	}
	modes := e.modesFor(ctx, scope)
	kinds := []string{}
	if modes.of(FeatureSpinoff) != ModeOff {
		kinds = append(kinds, domain.LinkKindSpinoff)
	}
	if modes.of(FeatureRelations) != ModeOff {
		kinds = append(kinds, domain.LinkKindRelation)
	}
	if len(kinds) == 0 {
		if !e.FeatureConfigured(FeatureSpinoff) && e.FeatureConfigured(FeatureRelations) {
			return nil, domain.FeatureDisabled(FeatureRelations)
		}
		return nil, domain.FeatureDisabled(FeatureSpinoff)
	}
	return e.store.ListLinks(ctx, scope.Tenant, lineID, kinds)
}

// detachCapsule is the capsule of a detached branch: its pack and its leaf.
func (e *Engine) detachCapsule(base store.DetachBase) domain.OriginCapsule {
	return domain.BuildOriginCapsule(domain.OriginCapsuleInput{
		Mode: domain.SpinoffDetach, From: base.From, Background: base.Pack.Rendered, Leaf: base.Leaf,
		TokenBudget: e.limits.Spinoff.CapsuleTokenBudget, ExtraMarkers: e.markers,
	})
}

// SpinoffPreview is the capsule a spinoff would start the new conversation
// with, and how many notes CopyNotes would copy (0 without it).
type SpinoffPreview struct {
	Mode        string
	Capsule     domain.OriginCapsule
	NotesToCopy int
}

// PreviewSpinoff builds the capsule Spinoff would store for the same input,
// and writes nothing. It refuses what Spinoff refuses about the input (the
// mode, a main line or an ended branch for detach, the message for fresh);
// the locks' checks (a turn running) are Spinoff's alone.
func (e *Engine) PreviewSpinoff(ctx context.Context, scope Scope, lineID string, in SpinoffInput) (SpinoffPreview, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureSpinoff)
	if err != nil {
		return SpinoffPreview{}, err
	}
	in.Mode, in.Title = strings.TrimSpace(in.Mode), strings.TrimSpace(in.Title)
	out := SpinoffPreview{Mode: in.Mode}
	switch in.Mode {
	case domain.SpinoffDetach:
		out.Capsule, err = e.previewDetach(ctx, scope, modes, lineID)
	case domain.SpinoffFresh:
		out.Capsule, err = e.previewFresh(ctx, scope, modes, lineID, in)
	default:
		return SpinoffPreview{}, errSpinoffMode
	}
	if err != nil || !in.CopyNotes {
		return out, err
	}
	out.NotesToCopy, err = e.notesToCopy(ctx, scope, lineID)
	return out, err
}

func (e *Engine) previewDetach(ctx context.Context, scope Scope, modes modeSet, lineID string) (domain.OriginCapsule, error) {
	detail, err := e.store.GetBranch(ctx, scope.Tenant, lineID)
	if err != nil {
		return domain.OriginCapsule{}, err
	}
	if ended, err := e.store.BranchLineEnded(ctx, lineID); err != nil || ended {
		return domain.OriginCapsule{}, cmpErr(err, domain.ErrBranchClosed)
	}
	parent, err := e.store.GetLine(ctx, scope.Tenant, detail.Branch.ParentLineID)
	if err != nil {
		return domain.OriginCapsule{}, err
	}
	base := store.DetachBase{
		From: domain.SpunOffRef{LineID: parent.ID, MessageID: detail.Branch.AnchorMessageID, Title: parent.Title}, Pack: detail.Pack,
	}
	if e.cooperates(modes, capLeafCapsule) {
		if base.Leaf, err = e.store.GetLeaf(ctx, scope.Tenant, lineID); err != nil {
			return domain.OriginCapsule{}, err
		}
	}
	return e.detachCapsule(base), nil
}

func (e *Engine) previewFresh(ctx context.Context, scope Scope, modes modeSet, lineID string, in SpinoffInput) (domain.OriginCapsule, error) {
	source, err := e.store.GetLine(ctx, scope.Tenant, lineID)
	if err != nil {
		return domain.OriginCapsule{}, err
	}
	if in.Title == "" {
		in.Title = source.Title
	}
	return e.freshCapsule(ctx, scope, modes, source, in)
}

// notesToCopy counts the active notes of the line's conversation.
func (e *Engine) notesToCopy(ctx context.Context, scope Scope, lineID string) (int, error) {
	line, err := e.store.GetLine(ctx, scope.Tenant, lineID)
	if err != nil {
		return 0, err
	}
	notes, err := e.store.ActiveNotes(ctx, rootOfView(line))
	return len(notes), err
}

// cmpErr is err when there is one, else fallback.
func cmpErr(err, fallback error) error {
	if err != nil {
		return err
	}
	return fallback
}
