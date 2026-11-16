package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

const (
	// defaultLinePage and maxLinePage bound one ListLines page.
	defaultLinePage = 50
	maxLinePage     = 200
	// uniqueViolation is Postgres' SQLSTATE for a duplicate key.
	uniqueViolation = "23505"
)

// CreateLineInput is a new main line. ID may be set by the host (the host
// uses its session id); empty means a new random id. Folder and Tags are
// normalised here (domain.NormalizeFolder, domain.NormalizeTags).
type CreateLineInput struct {
	ID        string
	Tenant    string
	Title     string
	Provider  string
	Model     string
	CreatedBy string
	HostMeta  json.RawMessage
	Folder    string
	Tags      []string
}

// CreateLine inserts a main line.
func (s *Store) CreateLine(ctx context.Context, in CreateLineInput, hooks ...TxHook) (domain.LineView, error) {
	tenant := strings.TrimSpace(in.Tenant)
	if tenant == "" {
		return domain.LineView{}, invalidInput("tenant is required")
	}
	id := uuid.New()
	if strings.TrimSpace(in.ID) != "" {
		parsed, ok := parseID(in.ID)
		if !ok {
			return domain.LineView{}, invalidInput("id must be a UUID")
		}
		id = parsed
	}
	meta, err := jsonObject(in.HostMeta, "hostMeta")
	if err != nil {
		return domain.LineView{}, err
	}
	org, err := domain.NormalizeOrganization(&in.Folder, &in.Tags)
	if err != nil {
		return domain.LineView{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.LineView, error) {
		row, err := q.InsertLine(ctx, db.InsertLineParams{
			ID: id, TenantID: tenant, Title: strings.TrimSpace(in.Title), Provider: strings.TrimSpace(in.Provider),
			Model: strings.TrimSpace(in.Model), HostMeta: meta, CreatedBy: strings.TrimSpace(in.CreatedBy),
			Folder: org.Folder, Tags: org.Tags,
		})
		if pgErr := (*pgconn.PgError)(nil); errors.As(err, &pgErr) && pgErr.Code == uniqueViolation {
			// The same answer whoever owns the id, so it says nothing about other tenants.
			return domain.LineView{}, domain.ErrIDUnavailable
		}
		if err != nil {
			return domain.LineView{}, fmt.Errorf("insert line: %w", err)
		}
		return s.hydrateOne(ctx, q, row)
	})
}

// GetLine loads one line of the tenant with its place in the tree.
func (s *Store) GetLine(ctx context.Context, tenant, lineID string) (domain.LineView, error) {
	row, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return domain.LineView{}, err
	}
	return s.hydrateOne(ctx, s.q, row)
}

// ListLinesInput selects one page of a tenant's main lines. Cursor is the
// NextCursor of the previous page. Folder ("" = any, domain.FolderUnfiled =
// only unfiled ones) and Tag ("" = any) filter the page (B18). Pinned (B25)
// lists only the pinned ones, newest pin first, in one page of at most
// Limit (no cursor); false does not filter.
type ListLinesInput struct {
	Tenant   string
	Archived bool
	Limit    int
	Cursor   string
	Folder   string
	Tag      string
	Pinned   bool
}

// LinePage is one page of main lines, newest activity first. NextCursor is
// "" on the last page.
type LinePage struct {
	Lines      []domain.LineView
	NextCursor string
}

// ListLines returns one keyset page of the tenant's main lines.
func (s *Store) ListLines(ctx context.Context, in ListLinesInput) (LinePage, error) {
	if in.Pinned {
		return s.listPinnedLines(ctx, in)
	}
	limit := clampLimit(in.Limit, defaultLinePage, maxLinePage)
	params := db.ListActiveMainLinesParams{TenantID: in.Tenant, RowLimit: limit + 1}
	if in.Cursor != "" {
		at, id, err := decodeKeysetCursor(in.Cursor)
		if err != nil {
			return LinePage{}, err
		}
		params.AfterAt = pgtype.Timestamptz{Time: at, Valid: true}
		params.AfterID = uuid.NullUUID{UUID: id, Valid: true}
	}
	filter, err := lineFilterOf(in)
	if err != nil {
		return LinePage{}, err
	}
	rows, err := s.listMainLines(ctx, in.Archived, filter, params)
	if err != nil {
		return LinePage{}, fmt.Errorf("list lines: %w", err)
	}
	page := LinePage{}
	if len(rows) > int(limit) {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		page.NextCursor = encodeKeysetCursor(last.LastActivityAt, last.ID)
	}
	if page.Lines, err = s.hydrate(ctx, s.q, rows); err != nil {
		return LinePage{}, err
	}
	return page, nil
}

// listPinnedLines is ListLines over the pinned main lines: one page, newest
// pin first (at most maxLinePage; Limit, when set, caps it), no cursor.
func (s *Store) listPinnedLines(ctx context.Context, in ListLinesInput) (LinePage, error) {
	if in.Cursor != "" {
		return LinePage{}, domain.NewError(domain.CodeInvalidInput, "the pinned list has one page: send no cursor", map[string]any{"field": "cursor"})
	}
	filter, err := lineFilterOf(in)
	if err != nil {
		return LinePage{}, err
	}
	rows, err := s.q.ListPinnedMainLines(ctx, db.ListPinnedMainLinesParams{
		TenantID: in.Tenant, Archived: in.Archived, Folder: textArg(filter.folder), Tag: textArg(filter.tag),
		RowLimit: clampLimit(in.Limit, maxLinePage, maxLinePage),
	})
	if err != nil {
		return LinePage{}, fmt.Errorf("list pinned lines: %w", err)
	}
	lines, err := s.hydrate(ctx, s.q, rows)
	if err != nil {
		return LinePage{}, err
	}
	return LinePage{Lines: lines}, nil
}

// lineFilter is a normalised folder and tag filter of a line list; nil
// pointers do not filter.
type lineFilter struct {
	folder *string
	tag    *string
}

func (f lineFilter) any() bool { return f.folder != nil || f.tag != nil }

// lineFilterOf normalises the filters of a line list: the folder like a
// folder name (domain.FolderUnfiled is the unfiled ones), the tag like a
// tag; a filter that normalises to "" does not filter.
func lineFilterOf(in ListLinesInput) (lineFilter, error) {
	out := lineFilter{}
	switch folder := strings.TrimSpace(in.Folder); folder {
	case "":
	case domain.FolderUnfiled:
		unfiled := ""
		out.folder = &unfiled
	default:
		normalized, err := domain.NormalizeFolder(folder)
		if err != nil {
			return out, err
		}
		out.folder = &normalized
	}
	if tag := domain.NormalizeTag(in.Tag); tag != "" {
		if utf8.RuneCountInString(tag) > domain.TagMaxRunes {
			return out, domain.NewError(domain.CodeInvalidInput, "the tag filter is too long", map[string]any{"field": "tag"})
		}
		out.tag = &tag
	}
	return out, nil
}

// listMainLines runs the query of the archived state asked for; each has
// literal predicates so it uses its own partial index. A folder or tag
// filter runs its own query; without one the unfiltered queries run as
// before B18.
func (s *Store) listMainLines(ctx context.Context, archived bool, filter lineFilter, params db.ListActiveMainLinesParams) ([]db.TangentLine, error) {
	if filter.any() {
		return s.q.ListFilteredMainLines(ctx, db.ListFilteredMainLinesParams{
			TenantID: params.TenantID, Archived: archived, Folder: textArg(filter.folder), Tag: textArg(filter.tag),
			AfterAt: params.AfterAt, AfterID: params.AfterID, RowLimit: params.RowLimit,
		})
	}
	if archived {
		return s.q.ListArchivedMainLines(ctx, db.ListArchivedMainLinesParams(params))
	}
	return s.q.ListActiveMainLines(ctx, params)
}

// encodeKeysetCursor packs a keyset position (a time, an id: the lines'
// activity, the memories' creation) into an opaque string.
func encodeKeysetCursor(at time.Time, id uuid.UUID) string {
	raw := strconv.FormatInt(at.UnixMicro(), 10) + "_" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeKeysetCursor(cursor string) (time.Time, uuid.UUID, error) {
	bad := invalidInput("cursor is not valid")
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, uuid.UUID{}, bad
	}
	micros, idText, found := strings.Cut(string(raw), "_")
	at, err := strconv.ParseInt(micros, 10, 64)
	id, ok := parseID(idText)
	if !found || err != nil || !ok {
		return time.Time{}, uuid.UUID{}, bad
	}
	return time.UnixMicro(at), id, nil
}

// LinePatch carries the editable fields; nil leaves a field as it is. An
// empty title is ignored; HostMeta replaces the whole object. Folder and
// Tags (B18) are normalised and belong to main lines: a branch accepts only
// "" and no tags (a no-op). Pinned (B25) pins or unpins a main line (an
// already pinned one keeps its time); a branch accepts only false (a
// no-op). Folder, tags and the pin are not activity.
type LinePatch struct {
	Title    *string
	Provider *string
	Model    *string
	HostMeta json.RawMessage
	Folder   *string
	Tags     *[]string
	Pinned   *bool
}

// UpdateLine applies the patch under the line's row lock.
func (s *Store) UpdateLine(ctx context.Context, tenant, lineID string, patch LinePatch, hooks ...TxHook) (domain.LineView, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.LineView, error) {
		current, err := s.lockLine(ctx, q, tenant, lineID)
		if err != nil {
			return domain.LineView{}, err
		}
		params := db.UpdateLineFieldsParams{
			ID: current.ID, Title: current.Title, Provider: current.Provider, Model: current.Model, HostMeta: current.HostMeta,
			Folder: current.Folder, Tags: tagsOf(current.Tags),
		}
		if err := s.patchOrganization(ctx, q, current.ID, patch, &params); err != nil {
			return domain.LineView{}, err
		}
		if err := patchPin(ctx, q, current.ID, patch.Pinned); err != nil {
			return domain.LineView{}, err
		}
		if patch.Title != nil && strings.TrimSpace(*patch.Title) != "" {
			params.Title = strings.TrimSpace(*patch.Title)
		}
		if patch.Provider != nil {
			params.Provider = strings.TrimSpace(*patch.Provider)
		}
		if patch.Model != nil {
			params.Model = strings.TrimSpace(*patch.Model)
		}
		if patch.HostMeta != nil {
			if params.HostMeta, err = jsonObject(patch.HostMeta, "hostMeta"); err != nil {
				return domain.LineView{}, err
			}
		}
		row, err := q.UpdateLineFields(ctx, params)
		if err != nil {
			return domain.LineView{}, fmt.Errorf("update line: %w", err)
		}
		return s.hydrateOne(ctx, q, row)
	})
}

// MarkRead resets the line's unread counter.
func (s *Store) MarkRead(ctx context.Context, tenant, lineID string, hooks ...TxHook) (domain.LineView, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.LineView, error) {
		current, err := s.lockLine(ctx, q, tenant, lineID)
		if err != nil {
			return domain.LineView{}, err
		}
		if err := q.ResetLineUnread(ctx, current.ID); err != nil {
			return domain.LineView{}, fmt.Errorf("reset unread: %w", err)
		}
		row, err := q.GetLine(ctx, current.ID)
		if err != nil {
			return domain.LineView{}, lookup(err, domain.ErrLineNotFound, "reload line")
		}
		return s.hydrateOne(ctx, q, row)
	})
}

// lineRow loads a line and checks the tenant; ErrLineNotFound otherwise.
func (s *Store) lineRow(ctx context.Context, q *db.Queries, tenant, lineID string) (db.TangentLine, error) {
	id, ok := parseID(lineID)
	if !ok {
		return db.TangentLine{}, domain.ErrLineNotFound
	}
	row, err := q.GetLine(ctx, id)
	if err != nil {
		return db.TangentLine{}, lookup(err, domain.ErrLineNotFound, "get line")
	}
	if row.TenantID != tenant {
		return db.TangentLine{}, domain.ErrLineNotFound
	}
	return row, nil
}

// lockLine locks a line's row (FOR NO KEY UPDATE) and checks the tenant.
func (s *Store) lockLine(ctx context.Context, q *db.Queries, tenant, lineID string) (db.TangentLine, error) {
	id, ok := parseID(lineID)
	if !ok {
		return db.TangentLine{}, domain.ErrLineNotFound
	}
	row, err := q.GetLineForUpdate(ctx, id)
	if err != nil {
		return db.TangentLine{}, lookup(err, domain.ErrLineNotFound, "lock line")
	}
	if row.TenantID != tenant {
		return db.TangentLine{}, domain.ErrLineNotFound
	}
	return row, nil
}

func lockLineByID(ctx context.Context, q *db.Queries, id uuid.UUID) (db.TangentLine, error) {
	row, err := q.GetLineForUpdate(ctx, id)
	if err != nil {
		return db.TangentLine{}, lookup(err, domain.ErrLineNotFound, "lock line")
	}
	return row, nil
}

// patchOrganization applies a patch's folder and tags to the update: on a
// main line as normalised, on a branch only when they leave it unfiled and
// untagged (anything else is invalid_input).
func (s *Store) patchOrganization(ctx context.Context, q *db.Queries, lineID uuid.UUID, patch LinePatch, params *db.UpdateLineFieldsParams) error {
	if patch.Folder == nil && patch.Tags == nil {
		return nil
	}
	org, err := domain.NormalizeOrganization(patch.Folder, patch.Tags)
	if err != nil {
		return err
	}
	_, isBranch, err := branchRowFor(ctx, q, lineID)
	if err != nil {
		return err
	}
	switch {
	case isBranch && org.Folder != "":
		return domain.OrganizeBranchError("folder")
	case isBranch && len(org.Tags) > 0:
		return domain.OrganizeBranchError("tags")
	case isBranch:
		return nil
	}
	if patch.Folder != nil {
		params.Folder = org.Folder
	}
	if patch.Tags != nil {
		params.Tags = org.Tags
	}
	return nil
}

// patchPin pins or unpins a main line; a branch takes only false (a no-op,
// it is never pinned) and true is invalid_input.
func patchPin(ctx context.Context, q *db.Queries, lineID uuid.UUID, pinned *bool) error {
	if pinned == nil {
		return nil
	}
	_, isBranch, err := branchRowFor(ctx, q, lineID)
	switch {
	case err != nil:
		return err
	case isBranch && *pinned:
		return domain.NewError(domain.CodeInvalidInput, "only main conversations can be pinned", map[string]any{"field": "pinned"})
	case isBranch:
		return nil
	}
	if err := q.SetLinePinned(ctx, db.SetLinePinnedParams{ID: lineID, Pinned: *pinned}); err != nil {
		return fmt.Errorf("pin the line: %w", err)
	}
	return nil
}

// textArg is an optional text query argument.
func textArg(s *string) pgtype.Text {
	if s == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *s, Valid: true}
}

// RenamedFolder is what a folder rename changed: the main lines it moved
// (id order).
type RenamedFolder struct {
	From    string
	To      string
	LineIDs []string
}

// RenameFolder moves every main line of the tenant in folder from (archived
// ones too) to folder to ("" unfiles them), under the locks of those lines
// in id order. Both names are normalised; from must not be empty. The lines'
// activity time does not change.
func (s *Store) RenameFolder(ctx context.Context, tenant, from, to string, hooks ...TxHook) (RenamedFolder, error) {
	from, err := domain.NormalizeFolder(from)
	if err != nil {
		return RenamedFolder{}, err
	}
	if from == "" {
		return RenamedFolder{}, domain.NewError(domain.CodeInvalidInput, "from names the folder to rename", map[string]any{"field": "from"})
	}
	if to, err = domain.NormalizeFolder(to); err != nil {
		return RenamedFolder{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (RenamedFolder, error) {
		out := RenamedFolder{From: from, To: to, LineIDs: []string{}}
		if from == to {
			return out, nil
		}
		ids, err := q.LockFolderLines(ctx, db.LockFolderLinesParams{TenantID: tenant, Folder: from})
		if err != nil {
			return RenamedFolder{}, fmt.Errorf("lock the folder's lines: %w", err)
		}
		if len(ids) == 0 {
			return out, nil
		}
		if _, err := q.SetLinesFolder(ctx, db.SetLinesFolderParams{TenantID: tenant, Folder: to, LineIds: ids}); err != nil {
			return RenamedFolder{}, fmt.Errorf("rename the folder: %w", err)
		}
		out.LineIDs = idStrings(ids)
		return out, nil
	})
}

// LineViews hydrates many lines of the tenant in one pass, in the order of
// lineIDs; ids that name no line of the tenant are skipped.
func (s *Store) LineViews(ctx context.Context, tenant string, lineIDs []string) ([]domain.LineView, error) {
	ids := make([]uuid.UUID, 0, len(lineIDs))
	for _, id := range lineIDs {
		if parsed, ok := parseID(id); ok {
			ids = append(ids, parsed)
		}
	}
	if len(ids) == 0 {
		return []domain.LineView{}, nil
	}
	views, err := s.hydrateIDs(ctx, s.q, ids)
	if err != nil {
		return nil, err
	}
	out := make([]domain.LineView, 0, len(views))
	for _, view := range views {
		if view.TenantID == tenant {
			out = append(out, view)
		}
	}
	return out, nil
}
