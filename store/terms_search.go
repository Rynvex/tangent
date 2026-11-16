package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Glossary search across a tenant's conversations (GET /terms).

// Page sizes of a term search.
const (
	termSearchDefault = 20
	termSearchMax     = 100
)

// TermQuery searches the tenant's terms: Query is matched against the
// term keys (normalised as they are: NormalizeTermKey), those that start
// with it first, then those that contain it; "" lists every term. Limit
// defaults to 20, at most 100. Cursor is a page's NextCursor.
type TermQuery struct {
	Tenant string
	Query  string
	Limit  int
	Cursor string
}

// TermPage is one page of a term search; NextCursor is "" on the last.
type TermPage struct {
	Terms      []domain.TermHit
	NextCursor string
}

// SearchTerms finds the tenant's terms outside archived conversations, in
// the order (prefix matches first, key, id).
func (s *Store) SearchTerms(ctx context.Context, in TermQuery) (TermPage, error) {
	query := domain.NormalizeTermKey(in.Query)
	params := db.SearchTermsParams{Q: query, TenantID: in.Tenant}
	if in.Cursor != "" {
		after, err := decodeTermCursor(in.Cursor)
		if err != nil {
			return TermPage{}, err
		}
		params.AfterRank, params.AfterKey, params.AfterID = after.Rank, after.Key, uuid.NullUUID{UUID: after.ID, Valid: true}
	}
	limit := clampLimit(in.Limit, termSearchDefault, termSearchMax)
	params.RowLimit = limit + 1
	rows, err := s.q.SearchTerms(ctx, params)
	if err != nil {
		return TermPage{}, fmt.Errorf("search terms: %w", err)
	}
	page := TermPage{Terms: make([]domain.TermHit, 0, min(len(rows), int(limit)))}
	if len(rows) > int(limit) {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		page.NextCursor = encodeTermCursor(termCursor{Rank: last.Rank, Key: last.TermKey, ID: last.ID})
	}
	for _, row := range rows {
		page.Terms = append(page.Terms, domain.TermHit{Term: termView(db.TangentTerm{
			ID: row.ID, TenantID: row.TenantID, RootLineID: row.RootLineID, Term: row.Term, TermKey: row.TermKey, Explanation: row.Explanation,
			SourceLineID: row.SourceLineID, SourceMessageID: row.SourceMessageID, SourceLabel: row.SourceLabel, CreatedBy: row.CreatedBy,
			CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		}), RootTitle: row.RootTitle})
	}
	return page, nil
}

// termCursor is a search's keyset position.
type termCursor struct {
	Rank int32     `json:"r"`
	Key  string    `json:"k"`
	ID   uuid.UUID `json:"i"`
}

func encodeTermCursor(c termCursor) string {
	raw, _ := json.Marshal(c) // a struct of an int, a string and a uuid always marshals
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeTermCursor(cursor string) (termCursor, error) {
	var c termCursor
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil || json.Unmarshal(raw, &c) != nil || c.ID == uuid.Nil {
		return termCursor{}, invalidInput("cursor is not valid")
	}
	return c, nil
}
