package embedding

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// snippet:contributor
// PlanContributor adds the host's "plan" (kept in the main line's host_meta)
// to every turn prompt of the conversation.
type PlanContributor struct {
	Plans func(ctx context.Context, tenant, rootLineID string) (string, error)
}

func (p PlanContributor) Contribute(ctx context.Context, scope tangent.Scope, line domain.LineView) ([]domain.PromptSection, error) {
	root := line.ID
	if line.ConversationBranch != nil {
		root = line.ConversationBranch.RootLineID
	}
	plan, err := p.Plans(ctx, scope.Tenant, root)
	if err != nil || plan == "" {
		// The prompt is built after the turn was stored: an error fails the turn.
		return nil, err
	}
	// The plan was typed by a user: quote it so it reads as data, not instructions.
	return []domain.PromptSection{{Key: "host.plan", Title: "Plan", Body: domain.QuoteUntrusted(plan)}}, nil
}

// endsnippet

// CodeQuotaExceeded is the host's own error code for QuotaGate.
const CodeQuotaExceeded = "quota_exceeded"

// snippet:gate
// QuotaGate refuses a turn when the tenant used up its monthly tokens. It
// runs before the turn's transaction: an advisory check, not a lock.
type QuotaGate struct {
	Remaining func(ctx context.Context, tenant string) (int64, error)
}

func (g QuotaGate) AllowTurn(ctx context.Context, scope tangent.Scope, _ domain.LineView) error {
	left, err := g.Remaining(ctx, scope.Tenant)
	if err != nil {
		return err // not a domain error: httpapi answers 500 and logs it
	}
	if left <= 0 {
		return domain.NewError(CodeQuotaExceeded, "this month's token quota is used up", map[string]any{"remaining": 0})
	}
	return nil
}

// QuotaStatus maps the host's codes for httpapi.Config.StatusFor; codes it
// does not know stay 409.
func QuotaStatus(code string) (int, bool) {
	if code == CodeQuotaExceeded {
		return http.StatusPaymentRequired, true
	}
	return 0, false
}

// endsnippet

// snippet:publisher
// Relay forwards events to the host's own realtime channel under the host's
// event names. Publish runs on the writer's goroutine after the commit, so
// it hands the event over and returns; it never blocks or calls back into
// the engine.
type Relay struct {
	Send func(tenant, name string, payload []byte) // must not block
}

func (r Relay) Publish(_ context.Context, ev tangent.Event) {
	payload, err := json.Marshal(ev.Data)
	if err != nil {
		return
	}
	r.Send(ev.Tenant, "conversation:"+ev.Type, payload)
}

// endsnippet

// snippet:intx
// Attachment is what the host keeps in a message's host_meta.
type Attachment struct {
	FileID string `json:"fileId"`
}

// SendWithAttachments starts a turn whose user message carries host data,
// and records an audit row in the same transaction: if the audit insert
// fails, no turn exists. The host then hands the turn to its dispatcher.
func SendWithAttachments(ctx context.Context, engine *tangent.Engine, d tangent.Dispatcher, scope tangent.Scope, lineID, text string, files []Attachment) (tangent.Turn, error) {
	meta, err := json.Marshal(map[string]any{"attachments": files})
	if err != nil {
		return tangent.Turn{}, err
	}
	audit := tangent.InTx(func(ctx context.Context, tx store.Tx, result any) error {
		begun, ok := result.(store.BegunTurn) // the ids this write created
		if !ok {
			return fmt.Errorf("audit hook: unexpected result %T", result)
		}
		_, err := tx.Exec(ctx, `INSERT INTO host_turn_audit (tenant, turn_id, actor) VALUES ($1, $2, $3)`,
			scope.Tenant, begun.Pending.ID, scope.Actor)
		return err
	})
	turn, err := engine.BeginTurn(ctx, scope, lineID, tangent.TurnInput{Content: text, HostMeta: meta}, audit)
	if err != nil {
		return tangent.Turn{}, err
	}
	if err := d.DispatchTurn(ctx, turn); err != nil {
		// Nobody will run it: fail it now instead of leaving it pending.
		_, _ = engine.CompleteTurn(context.WithoutCancel(ctx), turn.ID, tangent.TurnResult{Error: "the turn could not be started"})
		return tangent.Turn{}, fmt.Errorf("dispatch turn: %w", err)
	}
	return turn, nil
}

// DeleteWithFiles deletes a conversation and, in the same transaction,
// queues the host's files for removal. The hook runs before the rows go, and
// the result already lists the host data of every deleted line and message.
func DeleteWithFiles(ctx context.Context, engine *tangent.Engine, scope tangent.Scope, rootLineID string) error {
	cleanup := tangent.InTx(func(ctx context.Context, tx store.Tx, result any) error {
		deleted, ok := result.(store.DeletedTree)
		if !ok {
			return fmt.Errorf("cleanup hook: unexpected result %T", result)
		}
		for _, m := range deleted.Messages {
			var meta struct{ Attachments []Attachment }
			if json.Unmarshal(m.HostMeta, &meta) != nil {
				continue
			}
			for _, f := range meta.Attachments {
				if _, err := tx.Exec(ctx, `INSERT INTO host_file_gc (tenant, file_id) VALUES ($1, $2)`, scope.Tenant, f.FileID); err != nil {
					return err
				}
			}
		}
		return nil
	})
	_, err := engine.DeleteTree(ctx, scope, rootLineID, cleanup)
	return err
}

// endsnippet
