package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// A suggestion is about one line (line_id), but some name other lines of
// their tree in the payload: a relation its two ends (fromLineId,
// toLineId), a group its members (members[].lineId). When such a line
// leaves the tree (a detach takes it, a purged aside goes) the suggestion
// can no longer be done: it expires in the same transaction, and a
// proposal naming a line outside its tree is not raised. Both run under the
// root's lock, so neither can miss the other.

// namedLines are the payload fields that name lines.
type namedLines struct {
	FromLineID string `json:"fromLineId"`
	ToLineID   string `json:"toLineId"`
	Members    []struct {
		LineID string `json:"lineId"`
	} `json:"members"`
}

// payloadLines are the lines a payload names; ok is false when one of
// them is not an id.
func payloadLines(payload json.RawMessage) ([]uuid.UUID, bool) {
	var named namedLines
	if json.Unmarshal(payload, &named) != nil {
		return nil, true // not an object of this shape: it names no line
	}
	texts := []string{named.FromLineID, named.ToLineID}
	for _, m := range named.Members {
		texts = append(texts, m.LineID)
	}
	ids := []uuid.UUID{}
	for _, text := range texts {
		if text == "" {
			continue
		}
		id, ok := parseID(text)
		if !ok {
			return nil, false
		}
		ids = append(ids, id)
	}
	return ids, true
}

// namesLinesOutside reports whether the payload names a line that is not
// in the tree of root (the root is locked).
func namesLinesOutside(ctx context.Context, q *db.Queries, root uuid.UUID, payload json.RawMessage) (bool, error) {
	ids, ok := payloadLines(payload)
	if !ok {
		return true, nil
	}
	if len(ids) == 0 {
		return false, nil
	}
	outside, err := q.CountLinesOutsideTree(ctx, db.CountLinesOutsideTreeParams{LineIds: ids, RootLineID: root})
	if err != nil {
		return false, fmt.Errorf("check the lines a suggestion names: %w", err)
	}
	return outside > 0, nil
}

// expireNamingLines expires the open suggestions of root's tree that name
// one of the lines (which are leaving it).
func expireNamingLines(ctx context.Context, q *db.Queries, root uuid.UUID, lines []uuid.UUID) ([]domain.Suggestion, error) {
	if len(lines) == 0 {
		return nil, nil
	}
	rows, err := q.ExpireSuggestionsNamingLines(ctx, db.ExpireSuggestionsNamingLinesParams{RootLineID: root, LineIds: idStrings(lines)})
	if err != nil {
		return nil, fmt.Errorf("expire the suggestions naming the lines: %w", err)
	}
	out := make([]domain.Suggestion, 0, len(rows))
	for _, row := range rows {
		out = append(out, suggestionFromRow(row))
	}
	return out, nil
}
