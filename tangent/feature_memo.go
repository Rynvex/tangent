package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Memo keeps notes on a node that never go to the AI (DESIGN §12.10, B13):
// it registers no ContextProvider, so a memo is in no prompt, no turn
// preview and no job. Memos are not private: every reader of a
// conversation reads its memos. Off: the memo calls return
// feature_disabled; stored memos are kept.
func Memo() Feature { return onOff(FeatureMemo, nil) }

// Changes reported by memo.changed.
const (
	MemoCreated = "created"
	MemoUpdated = "updated"
	MemoDeleted = "deleted"
)

// MemoChange is the data of memo.changed.
type MemoChange struct {
	RootLineID string `json:"rootLineId"`
	MemoID     string `json:"memoId"`
	Change     string `json:"change"`
}

func memoEvent(scope Scope, memo domain.Memo, change string) Event {
	return Event{Type: EventMemoChanged, Tenant: scope.Tenant, RootLineID: memo.RootLineID, LineID: memo.LineID, Data: MemoChange{RootLineID: memo.RootLineID, MemoID: memo.ID, Change: change}}
}

// MemoList is a conversation's memos, oldest first.
type MemoList = store.MemoList

// ListMemos lists the memos of the line's conversation; with nodeLineID,
// only those written on that node.
func (e *Engine) ListMemos(ctx context.Context, scope Scope, lineID, nodeLineID string) (MemoList, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureMemo)
	if err != nil {
		return MemoList{}, err
	}
	return e.store.ListMemos(ctx, scope.Tenant, lineID, nodeLineID)
}

// MemoInput writes a memo on NodeLineID (the path's line when empty), a
// line of the same conversation.
type MemoInput struct {
	NodeLineID string
	Text       string
}

// CreateMemo writes a memo.
// InTx hooks receive domain.Memo.
func (e *Engine) CreateMemo(ctx context.Context, scope Scope, lineID string, in MemoInput, opts ...TxOption) (domain.Memo, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureMemo)
	if err != nil {
		return domain.Memo{}, err
	}
	memo, err := e.store.CreateMemo(ctx, store.CreateMemoInput{
		Tenant: scope.Tenant, LineID: lineID, NodeLineID: in.NodeLineID, Text: in.Text, Actor: scope.Actor,
	}, hooksOf(opts)...)
	if err != nil {
		return domain.Memo{}, err
	}
	e.publish(ctx, memoEvent(scope, memo, MemoCreated))
	return memo, nil
}

// UpdateMemo replaces a memo's text.
// InTx hooks receive domain.Memo.
func (e *Engine) UpdateMemo(ctx context.Context, scope Scope, memoID, text string, opts ...TxOption) (domain.Memo, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureMemo)
	if err != nil {
		return domain.Memo{}, err
	}
	memo, err := e.store.UpdateMemo(ctx, scope.Tenant, memoID, text, hooksOf(opts)...)
	if err != nil {
		return domain.Memo{}, err
	}
	e.publish(ctx, memoEvent(scope, memo, MemoUpdated))
	return memo, nil
}

// DeleteMemo removes a memo for good and returns it as it was.
// InTx hooks receive domain.Memo.
func (e *Engine) DeleteMemo(ctx context.Context, scope Scope, memoID string, opts ...TxOption) (domain.Memo, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureMemo)
	if err != nil {
		return domain.Memo{}, err
	}
	memo, err := e.store.DeleteMemo(ctx, scope.Tenant, memoID, hooksOf(opts)...)
	if err != nil {
		return domain.Memo{}, err
	}
	e.publish(ctx, memoEvent(scope, memo, MemoDeleted))
	return memo, nil
}
