package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// FreshInput starts a new main line from a message of a line. The capsule
// is built by the caller outside the lock (from the line's messages up to
// the message, its pack and its leaf); the transaction re-checks that the
// message is still a finished chat message of the line. Title is required.
type FreshInput struct {
	Tenant      string
	LineID      string
	AtMessageID string
	Title       string
	Actor       string
	CopyNotes   bool
	Capsule     domain.OriginCapsule
}

// SpinOffFresh creates the new main line (the source's provider and model)
// with its capsule, copies the notes (CopyNotes), and leaves a marker on the
// source line, under the locks main line → source line. The source tree is
// otherwise untouched. Refusals: an archived conversation, the source line
// answering (source_busy), a message that is not a finished chat message of
// the line (anchor_not_found).
func (s *Store) SpinOffFresh(ctx context.Context, in FreshInput, hooks ...TxHook) (SpunOff, error) {
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return SpunOff{}, invalidInput("a new conversation needs a title")
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (SpunOff, error) {
		source, rootID, err := s.lockFreshSource(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return SpunOff{}, err
		}
		at, ok, err := treeChatMessage(ctx, q, rootID, in.AtMessageID)
		if err != nil {
			return SpunOff{}, err
		}
		if !ok || at.LineID != source.ID {
			return SpunOff{}, domain.ErrBranchAnchorNotFound
		}
		created, err := q.InsertLine(ctx, db.InsertLineParams{
			ID: uuid.New(), TenantID: source.TenantID, Title: title, Provider: source.Provider, Model: source.Model,
			HostMeta: []byte("{}"), CreatedBy: strings.TrimSpace(in.Actor), Tags: noTags(),
		})
		if err != nil {
			return SpunOff{}, fmt.Errorf("insert the new main line: %w", err)
		}
		out := SpunOff{Mode: domain.SpinoffFresh, SourceLineID: source.ID.String(), OldRootLineID: rootID.String(), Moved: []string{}}
		return s.finishSpinoff(ctx, q, spinoffEnd{
			out: out, source: source, sourceMessage: at.ID, newLine: created.ID, oldRoot: rootID,
			title: title, capsule: in.Capsule, copyNotes: in.CopyNotes, actor: in.Actor,
		})
	})
}

// lockFreshSource locks the source line's main line, then the line, and
// refuses an archived or answering source.
func (s *Store) lockFreshSource(ctx context.Context, q *db.Queries, tenant, lineID string) (db.TangentLine, uuid.UUID, error) {
	peek, err := s.lineRow(ctx, q, tenant, lineID)
	if err != nil {
		return db.TangentLine{}, uuid.UUID{}, err
	}
	root, err := lockRootOf(ctx, q, peek.ID)
	if err != nil {
		return db.TangentLine{}, uuid.UUID{}, err
	}
	rootID := root.ID
	source := root
	if rootID != peek.ID {
		if source, err = lockLineByID(ctx, q, peek.ID); err != nil {
			return db.TangentLine{}, uuid.UUID{}, err
		}
	}
	if source.ArchivedAt.Valid || root.ArchivedAt.Valid {
		return db.TangentLine{}, uuid.UUID{}, domain.ErrLineArchived
	}
	if err := requireNoPendingTurn(ctx, q, source.ID, domain.ErrBranchSourceBusy); err != nil {
		return db.TangentLine{}, uuid.UUID{}, err
	}
	return source, rootID, nil
}

// linkListCap bounds one links listing.
const linkListCap = 200

// ListLinks lists the links of the kinds from or to any line of the line's
// tree, newest first (at most 200). A message end is reported on the line
// its message is on now.
func (s *Store) ListLinks(ctx context.Context, tenant, lineID string, kinds []string) ([]domain.Link, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return nil, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return nil, err
	}
	below, err := treeLineIDs(ctx, s.q, root)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListLinksOfLines(ctx, db.ListLinksOfLinesParams{
		TenantID: tenant, Kinds: append([]string{}, kinds...), LineIds: append([]uuid.UUID{root}, below...), RowLimit: linkListCap,
	})
	if err != nil {
		return nil, fmt.Errorf("list links: %w", err)
	}
	out := make([]domain.Link, 0, len(rows))
	for _, row := range rows {
		out = append(out, linkFromRow(row.TangentLink, linkEnds{row.FromAt, row.FromTitle, row.ToAt, row.ToTitle}))
	}
	return out, nil
}

func linkView(ctx context.Context, q *db.Queries, id uuid.UUID) (domain.Link, error) {
	row, err := q.GetLinkView(ctx, id)
	if err != nil {
		return domain.Link{}, lookup(err, domain.ErrRelationNotFound, "read the link")
	}
	return linkFromRow(row.TangentLink, linkEnds{row.FromAt, row.FromTitle, row.ToAt, row.ToTitle}), nil
}

// linkEnds are the lines a link's ends are on now and their titles.
type linkEnds struct {
	fromAt    uuid.UUID
	fromTitle string
	toAt      uuid.UUID
	toTitle   string
}

func linkFromRow(row db.TangentLink, ends linkEnds) domain.Link {
	link := domain.Link{
		ID: row.ID.String(), Kind: row.Kind, FromLineID: ends.fromAt.String(), FromMessageID: idString(row.FromMessageID),
		ToLineID: ends.toAt.String(), ToMessageID: idString(row.ToMessageID), Label: row.Label, FromTitle: ends.fromTitle, ToTitle: ends.toTitle,
		CreatedBy: row.CreatedBy, CreatedAt: row.CreatedAt.UTC(),
	}
	if row.Kind == domain.LinkKindRelation {
		link.RelationKind = row.RelationKind
	}
	return link
}
