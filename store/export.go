package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Reads of a whole tree at once for an export (B14): one query per part,
// whatever the number of lines, each also filtered by the tenant. The
// engine passes the lines of a tree it read for the tenant.

// TreeComparisonCap bounds the comparisons one export reads.
const TreeComparisonCap = 500

// TreeMessages are the oldest perLine messages of each line, in seq order,
// keyed by line id (every line given has a key); Truncated reports a line
// that has more.
type TreeMessages struct {
	ByLine    map[string][]domain.Message
	Truncated bool
}

// ListTreeMessages reads the first perLine messages of every line in one
// query, with their tags and spin-off targets as ListMessages has them.
func (s *Store) ListTreeMessages(ctx context.Context, tenant string, lineIDs []string, perLine int) (TreeMessages, error) {
	ids := parseIDs(lineIDs)
	rows, err := s.q.ListTreeMessages(ctx, db.ListTreeMessagesParams{TenantID: tenant, LineIds: ids, PerLine: int64(perLine) + 1})
	if err != nil {
		return TreeMessages{}, fmt.Errorf("list tree messages: %w", err)
	}
	out := TreeMessages{ByLine: make(map[string][]domain.Message, len(ids))}
	for _, id := range ids {
		out.ByLine[id.String()] = []domain.Message{}
	}
	kept := make([]db.TangentMessage, 0, len(rows))
	counts := map[uuid.UUID]int{}
	for _, row := range rows {
		if counts[row.LineID]++; counts[row.LineID] > perLine {
			out.Truncated = true
			continue
		}
		kept = append(kept, row)
	}
	messages := messagesFromRows(kept)
	if err := attachTags(ctx, s.q, messages); err != nil {
		return TreeMessages{}, err
	}
	if err := markSpunOffTargets(ctx, s.q, tenant, messages); err != nil {
		return TreeMessages{}, err
	}
	for _, m := range messages {
		out.ByLine[m.LineID] = append(out.ByLine[m.LineID], m)
	}
	return out, nil
}

// ListTreeFolds reads the folds of the lines that were not removed (as
// ListFolds has them), keyed by line id; lines without one have no key.
func (s *Store) ListTreeFolds(ctx context.Context, tenant string, lineIDs []string) (map[string][]domain.Fold, error) {
	rows, err := s.q.ListTreeFolds(ctx, db.ListTreeFoldsParams{TenantID: tenant, LineIds: parseIDs(lineIDs)})
	if err != nil {
		return nil, fmt.Errorf("list tree folds: %w", err)
	}
	out := map[string][]domain.Fold{}
	for _, fold := range foldsFromRows(rows) {
		out[fold.LineID] = append(out[fold.LineID], fold)
	}
	return out, nil
}

// ListTreeComparisons reads the comparisons of branches of the lines of
// the root's tree, oldest first (at most TreeComparisonCap); truncated
// reports more.
func (s *Store) ListTreeComparisons(ctx context.Context, tenant, rootLineID string, lineIDs []string) (out []domain.Comparison, truncated bool, err error) {
	rows, err := s.q.ListTreeComparisons(ctx, db.ListTreeComparisonsParams{TenantID: tenant, LineIds: parseIDs(lineIDs), RowLimit: TreeComparisonCap + 1})
	if err != nil {
		return nil, false, fmt.Errorf("list tree comparisons: %w", err)
	}
	if truncated = len(rows) > TreeComparisonCap; truncated {
		rows = rows[:TreeComparisonCap]
	}
	out = make([]domain.Comparison, 0, len(rows))
	for _, row := range rows {
		c := comparisonFromRow(row)
		c.RootLineID = rootLineID
		out = append(out, c)
	}
	return out, truncated, nil
}

// parseIDs keeps the ids that parse.
func parseIDs(raw []string) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(raw))
	for _, id := range raw {
		if parsed, ok := parseID(id); ok {
			out = append(out, parsed)
		}
	}
	return out
}
