package tangent

import (
	"context"
	"fmt"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Host system messages (role system, kind chat) are the host's records in
// a line that are not conversation: a daemon's notice, a sync report, a
// shell audit. They are written in the right place, never by rewriting
// messages (DESIGN §5: seq never changes): after a turn's reply in the
// same transaction (TurnResult.Notices), or on their own
// (AppendSystemMessage). Later prompts show them in the history as
// "system: …" entries; they never count as a turn.

// maxTurnNotices caps the notices one turn result may carry.
const maxTurnNotices = 16

// SystemNotice is one host system message: its text (cleaned with
// domain.CleanSystemText, then at most Limits.Text.MessageMaxRunes), the
// host's JSON object kept as the message's host_meta (shown to every reader
// of the line like any message's hostMeta), and SkipRepeat, which leaves it
// out when the line's newest host system message among its last 30 has the
// same text.
type SystemNotice = store.SystemNotice

// AppendedSystemMessage is what AppendSystemMessage did; Written is false
// when SkipRepeat left the message out.
type AppendedSystemMessage = store.AppendedSystemMessage

// AppendSystemMessage appends a host system message to a line: under the
// line's lock, after everything the line holds (also while a turn is
// pending: the notice then follows the pending reply, and that turn's
// prompt, built already, does not show it). An archived line, an ended
// branch (or one below an ended branch) and a line that is gone refuse it;
// blank text is invalid_input. message.created and line.updated are
// published after the commit; a skipped repeat writes and publishes
// nothing and its hooks do not run.
// InTx hooks receive store.AppendedSystemMessage.
func (e *Engine) AppendSystemMessage(ctx context.Context, scope Scope, lineID string, n SystemNotice, opts ...TxOption) (AppendedSystemMessage, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return AppendedSystemMessage{}, err
	}
	n, keep, err := e.cleanNotice(n)
	if err != nil {
		return AppendedSystemMessage{}, err
	}
	if !keep {
		return AppendedSystemMessage{}, errEmptyContent
	}
	out, err := e.store.AppendSystemMessage(ctx, scope.Tenant, lineID, n, hooksOf(opts)...)
	if err != nil || !out.Written {
		return out, err
	}
	root := rootOfView(out.Line)
	e.publish(ctx, messageEvent(EventMessageCreated, scope.Tenant, root, out.Message), lineEvent(EventLineUpdated, out.Line))
	return out, nil
}

// cleanNotices cleans a turn result's notices, leaving the blank ones out.
func (e *Engine) cleanNotices(notices []SystemNotice) ([]SystemNotice, error) {
	if len(notices) > maxTurnNotices {
		return nil, domain.NewError(domain.CodeInvalidInput, fmt.Sprintf("a turn carries at most %d notices", maxTurnNotices), nil)
	}
	out := make([]SystemNotice, 0, len(notices))
	for _, n := range notices {
		cleaned, keep, err := e.cleanNotice(n)
		if err != nil {
			return nil, err
		}
		if keep {
			out = append(out, cleaned)
		}
	}
	return out, nil
}

// cleanNotice cleans one notice's text and checks its length; keep is false
// when nothing is left of it.
func (e *Engine) cleanNotice(n SystemNotice) (SystemNotice, bool, error) {
	n.Content = domain.CleanSystemText(n.Content, e.markers)
	if n.Content == "" {
		return n, false, nil
	}
	return n, true, checkText("content", n.Content, e.limits.Text.MessageMaxRunes)
}
