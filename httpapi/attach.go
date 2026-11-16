package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// attachBody is POST /lines/{id}/attach (B20). card, when present (and not
// null), is decoded as strictly as a merge's.
type attachBody struct {
	SourceLineID    string          `json:"sourceLineId"`
	AnchorMessageID string          `json:"anchorMessageId"`
	Purpose         string          `json:"purpose"`
	Kind            string          `json:"kind"`
	Status          string          `json:"status"`
	Card            json.RawMessage `json:"card"`
	ConfirmDeeper   bool            `json:"confirmDeeper"`
}

// attachedBranch is the answer of an attach: the line the source now hangs
// on, the new branch, the source line as a branch line, the card left on
// the target (null when the branch stays open) and the source's branches
// that came along.
type attachedBranch struct {
	TargetLine  domain.LineView   `json:"targetLine"`
	Branch      domain.BranchView `json:"branch"`
	BranchLine  domain.LineView   `json:"branchLine"`
	CardMessage *domain.Message   `json:"cardMessage"`
	Reparented  []string          `json:"reparented"`
}

func (a *api) attachLine(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in attachBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	input := tangent.AttachInput{
		SourceLineID: in.SourceLineID, AnchorMessageID: in.AnchorMessageID, Purpose: in.Purpose, Kind: in.Kind, Status: in.Status,
		ConfirmDeeper: in.ConfirmDeeper,
	}
	if present(in.Card) {
		card, err := domain.DecodeBranchCardJSON(in.Card)
		if err != nil {
			return 0, nil, domain.CardError([]domain.BranchCardProblem{{Field: "card", Message: err.Error()}})
		}
		input.Card = &card
	}
	attached, err := a.engine.AttachLine(c.ctx, c.scope, id, input, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, attachedBranch{
		TargetLine: attached.TargetLine, Branch: attached.Branch, BranchLine: attached.BranchLine, CardMessage: attached.CardMessage,
		Reparented: list(attached.Reparented),
	}, nil
}
