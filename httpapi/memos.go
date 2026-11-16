package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// Memo routes (the memo feature, B13): notes on a node that never go to
// the AI. {id} is any line of the conversation; {mid} a memo id.

func (a *api) memoRoutes() []route {
	return []route{
		{pattern: "GET /lines/{id}/memos", feature: tangent.FeatureMemo, serve: a.listMemos},
		{pattern: "POST /lines/{id}/memos", write: true, op: OpMemosCreate, feature: tangent.FeatureMemo, serve: a.createMemo},
		{pattern: "PATCH /memos/{mid}", write: true, op: OpMemosUpdate, feature: tangent.FeatureMemo, serve: a.updateMemo},
		{pattern: "DELETE /memos/{mid}", write: true, op: OpMemosDelete, feature: tangent.FeatureMemo, serve: a.deleteMemo},
	}
}

type memoList struct {
	RootLineID string        `json:"rootLineId"`
	Memos      []domain.Memo `json:"memos"`
	Limits     memoLimits    `json:"limits"`
}

// memoLimits are the memo bounds (domain.Limits.Memo).
type memoLimits struct {
	// MaxTotal caps the memos of one conversation; MaxRunes one memo's text.
	MaxTotal int `json:"maxTotal"`
	MaxRunes int `json:"maxRunes"`
}

type memoView struct {
	Memo domain.Memo `json:"memo"`
}

// listMemos is GET /lines/{id}/memos?lineId=: the conversation's memos,
// oldest first, or only those of one node.
func (a *api) listMemos(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	memos, err := a.engine.ListMemos(c.ctx, c.scope, id, c.r.URL.Query().Get("lineId"))
	if err != nil {
		return 0, nil, err
	}
	l := a.limits.Memo
	return http.StatusOK, memoList{RootLineID: memos.RootLineID, Memos: list(memos.Memos), Limits: memoLimits{MaxTotal: l.MaxPerTree, MaxRunes: l.TextMaxRunes}}, nil
}

// memoBody is POST /lines/{id}/memos and PATCH /memos/{mid}.
type memoBody struct {
	LineID string `json:"lineId"`
	Text   string `json:"text"`
}

func (a *api) createMemo(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in memoBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	memo, err := a.engine.CreateMemo(c.ctx, c.scope, id, tangent.MemoInput{NodeLineID: in.LineID, Text: in.Text}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, memoView{Memo: memo}, nil
}

func (a *api) updateMemo(c *call) (int, any, error) {
	id, err := c.pathID("mid", domain.ErrMemoNotFound)
	if err != nil {
		return 0, nil, err
	}
	var in memoBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	memo, err := a.engine.UpdateMemo(c.ctx, c.scope, id, in.Text, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, memoView{Memo: memo}, nil
}

func (a *api) deleteMemo(c *call) (int, any, error) {
	id, err := c.pathID("mid", domain.ErrMemoNotFound)
	if err != nil {
		return 0, nil, err
	}
	memo, err := a.engine.DeleteMemo(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, memoView{Memo: memo}, nil
}
