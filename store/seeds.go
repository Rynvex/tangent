package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Parked thoughts (seeds) belong to the main line of their conversation:
// every write locks that row first, then the seed (an expansion locks main
// line → parent → seed), so the open-seed cap holds under concurrent
// writers and a seed ends exactly once.

// seedListCap bounds one listing.
const seedListCap = 200

// CreateSeedInput parks a thought on a line. AnchorMessageID is optional:
// without it the seed anchors on the line's newest chat message (none on an
// empty line).
type CreateSeedInput struct {
	Tenant          string
	LineID          string
	AnchorMessageID string
	Text            string
	Actor           string
}

// CreateSeed parks a thought. Refusals: an empty or long text, an archived
// conversation, the open-seed cap, an anchor that is not a finished chat
// message of the conversation.
func (s *Store) CreateSeed(ctx context.Context, in CreateSeedInput, hooks ...TxHook) (domain.Seed, error) {
	text, err := domain.NormalizeSeedText(in.Text, s.limits.Parking)
	if err != nil {
		return domain.Seed{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.Seed, error) {
		line, err := s.lineRow(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return domain.Seed{}, err
		}
		root, err := lockOpenRootOf(ctx, q, line.ID)
		if err != nil {
			return domain.Seed{}, err
		}
		if open, err := q.CountOpenSeeds(ctx, root.ID); err != nil {
			return domain.Seed{}, fmt.Errorf("count open seeds: %w", err)
		} else if int(open) >= s.limits.Parking.MaxOpenPerTree {
			return domain.Seed{}, domain.ErrSeedLimit
		}
		anchor, anchorLine, err := seedAnchor(ctx, q, root.ID, line.ID, in.AnchorMessageID)
		if err != nil {
			return domain.Seed{}, err
		}
		label, err := s.sourceLabel(ctx, q, root.ID, anchorLine, anchor, uuid.NullUUID{})
		if err != nil {
			return domain.Seed{}, err
		}
		row, err := q.InsertSeed(ctx, db.InsertSeedParams{
			TenantID: root.TenantID, RootLineID: root.ID, AnchorMessageID: anchor, Text: text, SourceLabel: label, CreatedBy: strings.TrimSpace(in.Actor),
		})
		if err != nil {
			return domain.Seed{}, fmt.Errorf("insert seed: %w", err)
		}
		return seedView(ctx, q, row)
	})
}

// seedAnchor checks a given anchor (a finished chat message of the
// conversation) or picks the line's newest chat message; it returns the
// anchor and the line it is on.
func seedAnchor(ctx context.Context, q *db.Queries, rootID, lineID uuid.UUID, anchorID string) (uuid.NullUUID, uuid.NullUUID, error) {
	none := uuid.NullUUID{}
	if strings.TrimSpace(anchorID) == "" {
		latest, err := q.LatestChatMessage(ctx, lineID)
		if noRows(err) {
			return none, none, nil
		}
		if err != nil {
			return none, none, fmt.Errorf("newest message: %w", err)
		}
		return uuid.NullUUID{UUID: latest.ID, Valid: true}, uuid.NullUUID{UUID: latest.LineID, Valid: true}, nil
	}
	message, ok, err := treeChatMessage(ctx, q, rootID, anchorID)
	if err != nil {
		return none, none, err
	}
	if !ok {
		return none, none, domain.ErrBranchAnchorNotFound
	}
	return uuid.NullUUID{UUID: message.ID, Valid: true}, uuid.NullUUID{UUID: message.LineID, Valid: true}, nil
}

// treeChatMessage loads a finished operator or assistant chat message that
// sits on a line of the root's tree; ok is false for anything else.
func treeChatMessage(ctx context.Context, q *db.Queries, rootID uuid.UUID, messageID string) (db.TangentMessage, bool, error) {
	id, ok := parseID(messageID)
	if !ok {
		return db.TangentMessage{}, false, nil
	}
	where, err := q.MessageLineInTree(ctx, db.MessageLineInTreeParams{RootID: rootID, MessageID: id})
	if noRows(err) || (err == nil && !where.InTree) {
		return db.TangentMessage{}, false, nil
	}
	if err != nil {
		return db.TangentMessage{}, false, fmt.Errorf("find message: %w", err)
	}
	message, err := q.GetMessage(ctx, id)
	if err != nil {
		return db.TangentMessage{}, false, fmt.Errorf("get message: %w", err)
	}
	chat := message.Kind == domain.MessageKindChat && (message.Role == domain.RoleUser || message.Role == domain.RoleAssistant)
	return message, chat && message.Status == domain.MessageDone, nil
}

// SeedQuery lists a conversation's seeds; Statuses defaults to open.
type SeedQuery struct {
	Tenant   string
	LineID   string
	Statuses []string
}

// SeedList is a conversation's seeds, newest first (at most 200).
type SeedList struct {
	RootLineID string
	Seeds      []domain.Seed
}

// ListSeeds lists the seeds of the line's conversation.
func (s *Store) ListSeeds(ctx context.Context, in SeedQuery) (SeedList, error) {
	line, err := s.lineRow(ctx, s.q, in.Tenant, in.LineID)
	if err != nil {
		return SeedList{}, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return SeedList{}, err
	}
	statuses := in.Statuses
	if len(statuses) == 0 {
		statuses = []string{domain.SeedStatusOpen}
	}
	rows, err := s.q.ListSeeds(ctx, db.ListSeedsParams{RootLineID: root, Statuses: statuses, RowLimit: seedListCap})
	if err != nil {
		return SeedList{}, fmt.Errorf("list seeds: %w", err)
	}
	seeds, err := seedViews(ctx, s.q, rows)
	return SeedList{RootLineID: root.String(), Seeds: seeds}, err
}

// GetSeed reads one seed of the tenant.
func (s *Store) GetSeed(ctx context.Context, tenant, seedID string) (domain.Seed, error) {
	row, err := seedOfTenant(ctx, s.q, tenant, seedID)
	if err != nil {
		return domain.Seed{}, err
	}
	return seedView(ctx, s.q, row)
}

func seedOfTenant(ctx context.Context, q *db.Queries, tenant, seedID string) (db.TangentSeed, error) {
	id, ok := parseID(seedID)
	if !ok {
		return db.TangentSeed{}, domain.ErrSeedNotFound
	}
	row, err := q.GetSeed(ctx, id)
	if err != nil {
		return db.TangentSeed{}, lookup(err, domain.ErrSeedNotFound, "get seed")
	}
	if row.TenantID != tenant {
		return db.TangentSeed{}, domain.ErrSeedNotFound
	}
	return row, nil
}

// lockOpenSeed locks a seed (its main line is already locked) and refuses
// one that has ended or moved to another tree meanwhile.
func lockOpenSeed(ctx context.Context, q *db.Queries, id, rootID uuid.UUID) (db.TangentSeed, error) {
	row, err := q.GetSeedForUpdate(ctx, id)
	if err != nil {
		return db.TangentSeed{}, lookup(err, domain.ErrSeedNotFound, "lock seed")
	}
	if row.RootLineID != rootID {
		return db.TangentSeed{}, errBranchMoved
	}
	if row.Status != domain.SeedStatusOpen {
		return db.TangentSeed{}, domain.ErrSeedNotOpen
	}
	return row, nil
}

// DropSeed ends an open seed without doing anything with it.
func (s *Store) DropSeed(ctx context.Context, tenant, seedID string, hooks ...TxHook) (domain.Seed, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.Seed, error) {
		peek, err := seedOfTenant(ctx, q, tenant, seedID)
		if err != nil {
			return domain.Seed{}, err
		}
		root, err := lockOpenRootOf(ctx, q, peek.RootLineID)
		if err != nil {
			return domain.Seed{}, err
		}
		if _, err := lockOpenSeed(ctx, q, peek.ID, root.ID); err != nil {
			return domain.Seed{}, err
		}
		return finishSeed(ctx, q, peek.ID, domain.SeedStatusDropped, uuid.NullUUID{}, uuid.NullUUID{})
	})
}

func finishSeed(ctx context.Context, q *db.Queries, id uuid.UUID, status string, line, note uuid.NullUUID) (domain.Seed, error) {
	row, err := q.FinishSeed(ctx, db.FinishSeedParams{ID: id, Status: status, ExpandedLineID: line, NoteID: note})
	if err != nil {
		return domain.Seed{}, lookup(err, domain.ErrSeedNotOpen, "end seed")
	}
	return seedView(ctx, q, row)
}

// seedView is one seed with the line its anchor is on now.
func seedView(ctx context.Context, q *db.Queries, row db.TangentSeed) (domain.Seed, error) {
	views, err := seedViews(ctx, q, []db.TangentSeed{row})
	if err != nil {
		return domain.Seed{}, err
	}
	return views[0], nil
}

// seedViews converts seeds and finds, in one query, the lines their anchors
// are on now.
func seedViews(ctx context.Context, q *db.Queries, rows []db.TangentSeed) ([]domain.Seed, error) {
	out := make([]domain.Seed, 0, len(rows))
	anchors := []uuid.UUID{}
	for _, row := range rows {
		if row.AnchorMessageID.Valid {
			anchors = append(anchors, row.AnchorMessageID.UUID)
		}
	}
	lines := map[uuid.UUID]uuid.UUID{}
	if len(anchors) > 0 {
		found, err := q.MessageLines(ctx, anchors)
		if err != nil {
			return nil, fmt.Errorf("find the seeds' anchors: %w", err)
		}
		for _, m := range found {
			lines[m.ID] = m.LineID
		}
	}
	for _, row := range rows {
		seed := seedFromRow(row)
		if line, ok := lines[row.AnchorMessageID.UUID]; ok && row.AnchorMessageID.Valid {
			seed.AnchorLineID = line.String()
		}
		out = append(out, seed)
	}
	return out, nil
}

func seedFromRow(row db.TangentSeed) domain.Seed {
	return domain.Seed{
		ID: row.ID.String(), RootLineID: row.RootLineID.String(), AnchorMessageID: idString(row.AnchorMessageID), Text: row.Text,
		SourceLabel: row.SourceLabel, Status: row.Status, ExpandedLineID: idString(row.ExpandedLineID), NoteID: idString(row.NoteID), CreatedBy: row.CreatedBy,
		CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(),
	}
}
