package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Chapters are computed when read: idle gaps, the topic cuts summaries
// record, and milestones the operator sets. On the main line, once the
// current chapter holds domain.ChapterCutMinMessages finished messages, a
// turn's prompt also allows a [CHAPTER] line; the title it carries is
// recorded as a topic cut on that turn's operator message. A main line's
// first-turn [TOPIC] title names the first chapter the same way. Off:
// nothing is recorded (the marker lines are still removed from replies)
// and the chapter calls return feature_disabled; stored cuts are kept.
func Chapters() Feature { return onOff(FeatureChapters, registerChapters) }

// capTopicCuts is the optional capability chapters provides: summaries
// record a topic cut while it is on (summary cooperates, it does not
// require chapters).
const capTopicCuts = "chapters.topic_cuts"

func registerChapters(r *registry, _ *module) {
	r.provide(capTopicCuts)
	r.addContextProvider(chaptersContext)
	r.addAfterCommit(chaptersAfterCommit)
}

// chapterCutMinReplies is the fewest finished replies a main line needs
// before its chapters are read for the [CHAPTER] rule.
const chapterCutMinReplies = domain.ChapterCutMinMessages / 2

// chaptersContext allows a [CHAPTER] line on a main-line turn whose current
// chapter is long enough. A chapter read that fails leaves the rule out.
func chaptersContext(ctx context.Context, e *Engine, _ Mode, pc *promptContext) error {
	if pc.line.ConversationBranch != nil {
		return nil
	}
	// Cheap guard first: a cut needs two finished exchanges on the line.
	replies, err := e.store.ReplyCount(ctx, pc.line.ID)
	if err != nil {
		e.log.Warn("tangent: reply count unavailable for the prompt", "line", pc.line.ID, "error", err)
		return nil
	}
	if replies < chapterCutMinReplies {
		return nil
	}
	view, err := e.store.ListChapters(ctx, pc.scope.Tenant, pc.line.ID)
	if err != nil {
		e.log.Warn("tangent: chapters unavailable for the prompt", "line", pc.line.ID, "error", err)
		return nil
	}
	own := 0
	if pc.begun != nil {
		own = 1 // the stored operator message of this turn
	}
	pc.in.AllowChapterCut = domain.ChapterCutDue(view.Chapters, own)
	return nil
}

// chaptersAfterCommit publishes chapters.changed for a summary that
// recorded a topic cut, and records the cut a completed turn's reply
// asked for.
func chaptersAfterCommit(ctx context.Context, e *Engine, _ Mode, ev *commitEvent) ([]Event, []Job) {
	switch {
	case ev.kind == commitSummarySaved && ev.summary != nil && ev.summary.TopicCut != nil:
		return []Event{chaptersChanged(ev.scope, ev.summary.RootLineID, ev.summary.Line.ID)}, nil
	case ev.kind == commitTurnCompleted && ev.turn != nil && ev.reply != nil:
		return e.recordReplyCut(ctx, ev.scope, ev.turn, ev.reply), nil
	}
	return nil, nil
}

// recordReplyCut stores the topic cut of a main-line turn on its operator
// message: the [CHAPTER] title, else the first turn's [TOPIC] title (it
// names the first chapter; a cut on the line's first message opens no
// chapter of its own). A message that already has a topic cut keeps it.
func (e *Engine) recordReplyCut(ctx context.Context, scope Scope, turn *CompletedTurn, reply *turnReply) []Event {
	title := reply.chapter
	if title == "" {
		title = reply.topic
	}
	if title == "" || reply.userMessageID == "" || turn.Line.ConversationBranch != nil {
		return nil
	}
	cut, err := e.store.RecordTopicCut(ctx, scope.Tenant, turn.Line.ID, reply.userMessageID, title)
	if err != nil {
		e.log.Warn("tangent: chapter cut not recorded", "line", turn.Line.ID, "error", err)
		return nil
	}
	if cut.Cut == nil {
		return nil
	}
	return []Event{chaptersChanged(scope, cut.RootLineID, turn.Line.ID)}
}

func chaptersChanged(scope Scope, rootLineID, lineID string) Event {
	return Event{
		Type: EventChaptersChanged, Tenant: scope.Tenant, RootLineID: rootLineID, LineID: lineID,
		Data: ChaptersChange{RootLineID: rootLineID},
	}
}

// Chapter types, as the store returns them.
type (
	ChaptersView  = store.ChaptersView
	ChapterChange = store.ChapterChange
)

// MilestoneInput marks a message of the conversation as a chapter start.
type MilestoneInput struct {
	MessageID string
	Title     string
}

// ListChapters returns the chapters of the line and the conversation's
// milestones.
func (e *Engine) ListChapters(ctx context.Context, scope Scope, lineID string) (ChaptersView, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureChapters)
	if err != nil {
		return ChaptersView{}, err
	}
	return e.store.ListChapters(ctx, scope.Tenant, lineID)
}

// AddMilestone marks a message as the start of a chapter.
// InTx hooks receive store.ChapterChange.
func (e *Engine) AddMilestone(ctx context.Context, scope Scope, lineID string, in MilestoneInput, opts ...TxOption) (ChapterChange, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureChapters)
	if err != nil {
		return ChapterChange{}, err
	}
	change, err := e.store.AddMilestone(ctx, store.MilestoneInput{
		Tenant: scope.Tenant, LineID: lineID, MessageID: in.MessageID, Title: in.Title, Actor: scope.Actor,
	}, hooksOf(opts)...)
	if err != nil {
		return ChapterChange{}, err
	}
	e.publish(ctx, chaptersChanged(scope, change.RootLineID, lineID))
	return change, nil
}

// DeleteMilestone removes a milestone; it returns the main line's id.
// InTx hooks receive string (the milestone id).
func (e *Engine) DeleteMilestone(ctx context.Context, scope Scope, lineID, milestoneID string, opts ...TxOption) (string, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureChapters)
	if err != nil {
		return "", err
	}
	root, err := e.store.DeleteMilestone(ctx, scope.Tenant, lineID, milestoneID, hooksOf(opts)...)
	if err != nil {
		return "", err
	}
	e.publish(ctx, chaptersChanged(scope, root, lineID))
	return root, nil
}
