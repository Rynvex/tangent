package embedding

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// snippet:system-notices
// FinishRemoteTurn records what a remote runner (a daemon) reported for a
// turn: the reply, and the status lines it produced along the way as host
// system messages right after the reply, in the same transaction. A status
// the daemon reports on every turn is written once (SkipRepeat). When the
// turn ended meanwhile (the operator cancelled it), the reply is gone but
// the statuses are still recorded on the line.
func FinishRemoteTurn(ctx context.Context, engine *tangent.Engine, scope tangent.Scope, lineID, turnID, content string, statuses []string) error {
	notices := make([]tangent.SystemNotice, 0, len(statuses))
	for _, status := range statuses {
		notices = append(notices, tangent.SystemNotice{
			Content: status, HostMeta: json.RawMessage(`{"source":"daemon"}`), SkipRepeat: true,
		})
	}
	_, err := engine.CompleteTurn(ctx, turnID, tangent.TurnResult{Content: content, Notices: notices})
	if !errors.Is(err, domain.ErrTurnNotPending) {
		return err
	}
	for _, notice := range notices {
		_, err := engine.AppendSystemMessage(ctx, scope, lineID, notice)
		// A status that cleans to nothing is skipped, as CompleteTurn skips it.
		if err != nil && domain.CodeOf(err) != domain.CodeInvalidInput {
			return err
		}
	}
	return nil
}

// endsnippet

// snippet:delta-filter
// OperatorDeltas is httpapi.Config.DeltaFilter: tool deltas (a runner's
// tool input: commands, paths) reach only members who may write; read-only
// members still see the reply's text and reasoning. It runs for every delta
// of GET /stream and every message.delta of GET /events, so it only looks
// at the request.
func OperatorDeltas(r *http.Request, _ string, d domain.Delta) (domain.Delta, bool) {
	return d, d.Kind != domain.DeltaTool || UserCanWrite(r)
}

// endsnippet
