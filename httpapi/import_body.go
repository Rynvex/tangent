package httpapi

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// The B19 fields of POST /lines/import: a date that is not an RFC 3339
// string is refused naming its field (invalid_input), and a branch's card
// is decoded as strictly as a merge's (invalid_card, its field under the
// branch's). The engine checks everything else (domain.PlanImport).

// importMessageBody is one message of an import.
type importMessageBody struct {
	ExternalID string          `json:"externalId"`
	Role       string          `json:"role"`
	Content    string          `json:"content"`
	CreatedAt  json.RawMessage `json:"createdAt"`
}

// importBranchBody is one branch of an import.
type importBranchBody struct {
	AnchorExternalID string              `json:"anchorExternalId"`
	Purpose          string              `json:"purpose"`
	Kind             string              `json:"kind"`
	Status           string              `json:"status"`
	Card             json.RawMessage     `json:"card"`
	CreatedAt        json.RawMessage     `json:"createdAt"`
	Messages         []importMessageBody `json:"messages"`
}

// importInput reads the body into the engine's input.
func (in importBody) importInput() (tangent.ImportInput, error) {
	out := tangent.ImportInput{
		Title: in.Title, Provider: in.Provider, Model: in.Model, Folder: in.Folder, Tags: in.Tags, Source: in.Source,
		ChapterCuts: in.ChapterCuts, BatchID: in.BatchID, BatchLabel: in.BatchLabel,
	}
	var err error
	if out.CreatedAt, err = importTime("createdAt", in.CreatedAt); err != nil {
		return tangent.ImportInput{}, err
	}
	if out.Messages, err = importMessages("messages", in.Messages); err != nil {
		return tangent.ImportInput{}, err
	}
	for i, branch := range in.Branches {
		field := fmt.Sprintf("branches[%d]", i)
		converted := domain.ImportBranch{AnchorExternalID: branch.AnchorExternalID, Purpose: branch.Purpose, Kind: branch.Kind, Status: branch.Status}
		if converted.CreatedAt, err = importTime(field+".createdAt", branch.CreatedAt); err != nil {
			return tangent.ImportInput{}, err
		}
		if converted.Messages, err = importMessages(field+".messages", branch.Messages); err != nil {
			return tangent.ImportInput{}, err
		}
		if present(branch.Card) {
			card, err := domain.DecodeBranchCardJSON(branch.Card)
			if err != nil {
				return tangent.ImportInput{}, domain.CardError([]domain.BranchCardProblem{{Field: field + ".card", Message: err.Error()}})
			}
			converted.Card = &card
		}
		out.Branches = append(out.Branches, converted)
	}
	return out, nil
}

func importMessages(field string, in []importMessageBody) ([]domain.ImportMessage, error) {
	if in == nil {
		return nil, nil
	}
	out := make([]domain.ImportMessage, 0, len(in))
	for i, message := range in {
		at, err := importTime(fmt.Sprintf("%s[%d].createdAt", field, i), message.CreatedAt)
		if err != nil {
			return nil, err
		}
		out = append(out, domain.ImportMessage{ExternalID: message.ExternalID, Role: message.Role, Content: message.Content, CreatedAt: at})
	}
	return out, nil
}

// importTime reads an optional date: absent or null is none.
func importTime(field string, raw json.RawMessage) (*time.Time, error) {
	if !present(raw) {
		return nil, nil
	}
	var at time.Time
	if err := json.Unmarshal(raw, &at); err != nil {
		return nil, domain.NewError(domain.CodeInvalidInput, field+": the date is an RFC 3339 date-time string", map[string]any{"field": field})
	}
	return &at, nil
}
