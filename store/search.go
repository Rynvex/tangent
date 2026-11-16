package store

import (
	"cmp"
	"context"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/Rynvex/tangent/domain"
)

// SearchCandidates bounds how many of the newest matches of each kind
// (titles, purposes, messages) are ranked; the best Limit of them are
// returned. It keeps a common word in a large tenant cheap.
const SearchCandidates = 200

// SearchInput is one search of a tenant's conversations. Query is matched
// as a case-insensitive substring; Archived searches the archived trees
// instead of the active ones (as ListLines does). RootLineID limits the
// search to that main line's tree (B14; the caller checked it is one of
// the tenant's main lines) and then Archived is ignored.
type SearchInput struct {
	Tenant     string
	Query      string
	Limit      int
	Archived   bool
	RootLineID string
}

// SearchRow is one hit with the whole matched text (Engine cuts the
// snippet). MessageID, Seq and Role are set for message hits only.
type SearchRow struct {
	Kind       string
	LineID     string
	RootLineID string
	MessageID  string
	Seq        int64
	Role       string
	Text       string
	RootTitle  string
	Purpose    string
	At         time.Time
	Score      float64
}

// Search ranks the newest SearchCandidates matches of each kind (titles,
// purposes, messages) by their similarity to the query, then by recency.
// The similarity is the mean of pg_trgm's word_similarity (the query
// appears as whole words) and the share of the text the query covers (a
// text that is mostly the query); the second part carries Chinese, where a
// query inside a run of characters has no word boundary and word_similarity
// is about 0. Scores are computed for the candidates only. It needs pg_trgm
// (the search feature's migration).

// searchScore is the similarity of a candidate's text to the query ($3).
const searchScore = `(word_similarity($3, c.text) + least(1, char_length($3)::float8 / greatest(char_length(c.text), 1))) / 2`

// searchLinesSQL finds the title and purpose candidates (small tables, GIN
// indexes). $1 tenant, $2 ILIKE pattern, $3 query, $4 archived, $5 cap.
const searchLinesSQL = `SELECT c.*, ` + searchScore + ` FROM (
(SELECT 'title' AS kind, l.id AS line_id, l.id AS root_line_id, NULL::uuid AS message_id, 0::bigint AS seq, '' AS role,
        l.title AS text, l.title AS root_title, '' AS purpose, l.last_activity_at AS at
 FROM tangent_line l
 WHERE l.tenant_id = $1 AND l.title ILIKE $2 AND (l.archived_at IS NOT NULL) = $4
   AND NOT EXISTS (SELECT 1 FROM tangent_branch b WHERE b.line_id = l.id)
 ORDER BY l.last_activity_at DESC, l.id DESC
 LIMIT $5)
UNION ALL
(SELECT 'purpose', b.line_id, b.root_line_id, NULL::uuid, 0::bigint, '', b.purpose, r.title, b.purpose, l.last_activity_at
 FROM tangent_branch b
 JOIN tangent_line l ON l.id = b.line_id
 JOIN tangent_line r ON r.id = b.root_line_id
 WHERE b.tenant_id = $1 AND b.purpose ILIKE $2 AND (r.archived_at IS NOT NULL) = $4
 ORDER BY l.last_activity_at DESC, b.line_id DESC
 LIMIT $5)) c`

// searchMessagesSQL finds message candidates, newest first, in a seq range
// [$6, $7). $1 tenant, $2 ILIKE pattern, $3 query, $4 archived, $5 cap.
// {{order}} is "m.seq DESC" (walk the tenant's messages newest first and
// stop at the cap) or "m.seq + 0 DESC" (take the matches from the GIN
// index and sort them; the planner cannot walk the seq index instead).
const searchMessagesSQL = `SELECT c.*, ` + searchScore + ` FROM (
SELECT 'message' AS kind, m.line_id, COALESCE(b.root_line_id, m.line_id) AS root_line_id, m.id AS message_id, m.seq, m.role,
       m.content AS text, r.title AS root_title, COALESCE(b.purpose, '') AS purpose, m.created_at AS at
FROM tangent_message m
LEFT JOIN tangent_branch b ON b.line_id = m.line_id
JOIN tangent_line r ON r.id = COALESCE(b.root_line_id, m.line_id)
WHERE m.tenant_id = $1 AND m.status = 'done' AND m.kind = 'chat' AND m.role IN ('user', 'assistant')
  AND m.content ILIKE $2 AND (r.archived_at IS NOT NULL) = $4 AND m.seq >= $6 AND m.seq < $7
ORDER BY {{order}}
LIMIT $5) c`

// searchTreeLinesSQL is searchLinesSQL within one tree, archived or not.
// $1 tenant, $2 ILIKE pattern, $3 query, $4 root line, $5 cap.
const searchTreeLinesSQL = `SELECT c.*, ` + searchScore + ` FROM (
(SELECT 'title' AS kind, l.id AS line_id, l.id AS root_line_id, NULL::uuid AS message_id, 0::bigint AS seq, '' AS role,
        l.title AS text, l.title AS root_title, '' AS purpose, l.last_activity_at AS at
 FROM tangent_line l
 WHERE l.tenant_id = $1 AND l.id = $4::uuid AND l.title ILIKE $2)
UNION ALL
(SELECT 'purpose', b.line_id, b.root_line_id, NULL::uuid, 0::bigint, '', b.purpose, r.title, b.purpose, l.last_activity_at
 FROM tangent_branch b
 JOIN tangent_line l ON l.id = b.line_id
 JOIN tangent_line r ON r.id = b.root_line_id
 WHERE b.tenant_id = $1 AND b.root_line_id = $4::uuid AND b.purpose ILIKE $2
 ORDER BY l.last_activity_at DESC, b.line_id DESC
 LIMIT $5)) c`

// searchTreeMessagesSQL is searchMessagesSQL within one tree: the newest
// matches of its lines (folded messages included), with no seq window.
// $1 tenant, $2 ILIKE pattern, $3 query, $4 root line, $5 cap.
const searchTreeMessagesSQL = `SELECT c.*, ` + searchScore + ` FROM (
SELECT 'message' AS kind, m.line_id, r.id AS root_line_id, m.id AS message_id, m.seq, m.role,
       m.content AS text, r.title AS root_title, COALESCE(b.purpose, '') AS purpose, m.created_at AS at
FROM tangent_message m
LEFT JOIN tangent_branch b ON b.line_id = m.line_id
JOIN tangent_line r ON r.id = $4::uuid
WHERE m.tenant_id = $1 AND m.status = 'done' AND m.kind = 'chat' AND m.role IN ('user', 'assistant')
  AND m.line_id IN (SELECT $4::uuid UNION ALL SELECT tb.line_id FROM tangent_branch tb WHERE tb.root_line_id = $4::uuid)
  AND m.content ILIKE $2
ORDER BY m.seq DESC
LIMIT $5) c`

// searchWindowSQL is the seq of the SearchWindow-th newest searchable
// message of the tenant (0 when it has fewer), from the partial index.
const searchWindowSQL = `SELECT COALESCE((SELECT seq FROM tangent_message
WHERE tenant_id = $1 AND status = 'done' AND kind = 'chat' AND role IN ('user', 'assistant')
ORDER BY seq DESC OFFSET $2 LIMIT 1), 0)`

// SearchWindow is how many of a tenant's newest messages a search walks
// first. Walking stops at the candidate cap, so a common query is answered
// from them; only when they hold fewer candidates are the older messages
// searched, through the trigram index (a query of three characters or
// more) or by walking on (a shorter one, which has no trigram).
const SearchWindow = 4000

// searchWindow is SearchWindow; tests make it small.
var searchWindow = SearchWindow

// searchSQLFor is the message statement for older messages: through the
// GIN index for a query with trigrams, else a walk.
func searchSQLFor(query string, older bool) string {
	order := "m.seq DESC"
	if older && utf8.RuneCountInString(query) >= 3 {
		order = "m.seq + 0 DESC"
	}
	return strings.Replace(searchMessagesSQL, "{{order}}", order, 1)
}

// Search finds the tenant's hits for a query (see SearchInput). It returns
// invalid_input for a missing tenant or a query shorter than the minimum.
func (s *Store) Search(ctx context.Context, in SearchInput) ([]SearchRow, error) {
	in.Tenant = strings.TrimSpace(in.Tenant)
	if in.Tenant == "" {
		return nil, invalidInput("a search needs a tenant")
	}
	query, err := domain.NormalizeSearchQuery(in.Query)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.RootLineID) != "" {
		return s.searchTree(ctx, in, query)
	}
	args := []any{in.Tenant, domain.SearchLikePattern(query), query, in.Archived, SearchCandidates}
	out, err := s.searchRows(ctx, searchLinesSQL, args...)
	if err != nil {
		return nil, err
	}
	messages, err := s.searchMessages(ctx, query, args)
	if err != nil {
		return nil, err
	}
	out = append(out, messages...)
	slices.SortFunc(out, compareHits)
	return out[:min(len(out), domain.ClampSearchLimit(in.Limit))], nil
}

// searchTree is Search within one tree.
func (s *Store) searchTree(ctx context.Context, in SearchInput, query string) ([]SearchRow, error) {
	root, ok := parseID(in.RootLineID)
	if !ok {
		return nil, domain.ErrLineNotFound
	}
	args := []any{in.Tenant, domain.SearchLikePattern(query), query, root, SearchCandidates}
	out, err := s.searchRows(ctx, searchTreeLinesSQL, args...)
	if err != nil {
		return nil, err
	}
	messages, err := s.searchRows(ctx, searchTreeMessagesSQL, args...)
	if err != nil {
		return nil, err
	}
	out = append(out, messages...)
	slices.SortFunc(out, compareHits)
	return out[:min(len(out), domain.ClampSearchLimit(in.Limit))], nil
}

// searchMessages takes the candidates from the newest SearchWindow messages
// and, when they are fewer than the cap, the newest older ones.
func (s *Store) searchMessages(ctx context.Context, query string, args []any) ([]SearchRow, error) {
	var floor int64
	if err := s.pool.QueryRow(ctx, searchWindowSQL, args[0], searchWindow-1).Scan(&floor); err != nil {
		return nil, fmt.Errorf("search: %w", err)
	}
	recent, err := s.searchRows(ctx, searchSQLFor(query, false), append(args, floor, int64(math.MaxInt64))...)
	if err != nil || len(recent) >= SearchCandidates || floor == 0 {
		return recent, err
	}
	older, err := s.searchRows(ctx, searchSQLFor(query, true), append(args, int64(0), floor)...)
	if err != nil {
		return nil, err
	}
	return append(recent, older[:min(len(older), SearchCandidates-len(recent))]...), nil
}

// searchRows runs one search statement unprepared (QueryExecModeExec), so
// every run is planned with its pattern: a cached generic plan cannot know
// whether the trigram index fits and fell back to scanning the table.
func (s *Store) searchRows(ctx context.Context, sql string, args ...any) ([]SearchRow, error) {
	rows, err := s.pool.Query(ctx, sql, append([]any{pgx.QueryExecModeExec}, args...)...)
	if err != nil {
		return nil, fmt.Errorf("search: %w", err)
	}
	out, err := pgx.CollectRows(rows, scanSearchRow)
	if err != nil {
		return nil, fmt.Errorf("search: %w", err)
	}
	return out, nil
}

// compareHits orders hits by score, then the newest first, then stably.
func compareHits(a, b SearchRow) int {
	return cmp.Or(
		cmp.Compare(b.Score, a.Score), b.At.Compare(a.At), cmp.Compare(a.Kind, b.Kind),
		cmp.Compare(a.LineID, b.LineID), cmp.Compare(b.Seq, a.Seq),
	)
}

func scanSearchRow(row pgx.CollectableRow) (SearchRow, error) {
	var out SearchRow
	var lineID, rootID uuid.UUID
	var messageID uuid.NullUUID
	var score float64
	err := row.Scan(&out.Kind, &lineID, &rootID, &messageID, &out.Seq, &out.Role, &out.Text, &out.RootTitle, &out.Purpose, &out.At, &score)
	out.LineID, out.RootLineID, out.MessageID = lineID.String(), rootID.String(), idString(messageID)
	out.Score = math.Round(score*10000) / 10000
	return out, err
}
