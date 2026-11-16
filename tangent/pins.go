package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
)

// PinMessage pins (pinned true) or unpins a finished operator, assistant or
// card message. Pinning is core: it needs no feature (the fisheye context
// reads it). A message already in that state is returned unchanged and
// nothing is published; otherwise message.updated follows the commit.
// InTx hooks receive store.PinnedMessage.
func (e *Engine) PinMessage(ctx context.Context, scope Scope, messageID string, pinned bool, opts ...TxOption) (domain.Message, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return domain.Message{}, err
	}
	out, err := e.store.PinMessage(ctx, scope.Tenant, messageID, pinned, hooksOf(opts)...)
	if err != nil {
		return domain.Message{}, err
	}
	if out.Changed {
		e.publish(ctx, messageEvent(EventMessageUpdated, scope.Tenant, out.RootLineID, out.Message))
	}
	return out.Message, nil
}
