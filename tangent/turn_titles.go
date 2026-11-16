package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
)

// A reply's [TOPIC] and [CHAPTER] lines (domain/topic_marker.go) are core:
// they are always removed from a successful reply. A topic title renames
// the line (main line: its title; branch: its purpose) through the same
// calls a manual rename uses, after the turn committed; a chapter title is
// recorded by the chapters feature's AfterCommit. Either is used only when
// this process built the turn's prompt and it asked for it.

// turnReply is what a completed reply carried beyond its text, kept only
// where the prompt asked for it, and the operator message it answered.
type turnReply struct {
	topic         string
	chapter       string
	userMessageID string
	// seen is the title or purpose the prompt saw (turnAsks.seen).
	seen string
}

// extractTitleLines removes the [TOPIC] and [CHAPTER] lines from the reply.
func (e *Engine) extractTitleLines(reply *replyParts, asks turnAsks) *turnReply {
	var topic, chapter string
	reply.content, topic = domain.ExtractTopicSummary(reply.content, e.limits.Text)
	reply.content, chapter = domain.ExtractChapterCut(reply.content, e.limits.Chapters)
	out := &turnReply{userMessageID: asks.userMessageID, seen: asks.seen}
	if asks.topic {
		out.topic = topic
	}
	if asks.chapterCut {
		out.chapter = chapter
	}
	return out
}

// applyTopic renames the turn's line to the topic title (UpdateLine for a
// main line, RenameBranch for a branch, with their events) unless the
// operator renamed it while the turn ran, and returns the line as it is
// now. A main line the prompt saw without a title takes the topic whatever
// it is called now (a client names a new conversation after its first
// message while the turn runs); a titled one only while it still has the
// title the prompt saw. A branch only while its purpose is the one the
// prompt saw. A refused rename is logged and leaves the line as it was.
func (e *Engine) applyTopic(ctx context.Context, scope Scope, line domain.LineView, reply *turnReply) domain.LineView {
	current, err := e.store.GetLine(ctx, scope.Tenant, line.ID)
	if err != nil {
		e.log.Warn("tangent: topic title not applied", "line", line.ID, "error", err)
		return line
	}
	if current.ConversationBranch == nil {
		if reply.seen != "" && current.Title != reply.seen {
			return current
		}
		renamed, err := e.UpdateLine(ctx, scope, line.ID, LinePatch{Title: &reply.topic})
		if err != nil {
			e.log.Warn("tangent: topic title not applied", "line", line.ID, "error", err)
			return current
		}
		return renamed
	}
	if current.ConversationBranch.Kind == domain.BranchKindAside || current.ConversationBranch.Purpose != reply.seen {
		return current
	}
	if _, err := e.RenameBranch(ctx, scope, line.ID, reply.topic); err != nil {
		e.log.Warn("tangent: topic purpose not applied", "line", line.ID, "error", err)
		return current
	}
	if renamed, err := e.store.GetLine(ctx, scope.Tenant, line.ID); err == nil {
		return renamed
	}
	return current
}
