package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Notes belong to the main line of a conversation; every write locks that
// row, so the caps and the revision stay exact under concurrent writers.

// NotesView is the notes page of a conversation, superseded notes included,
// newest first.
type NotesView struct {
	RootLineID string
	Revision   int
	Notes      []domain.Note
}

// NotesWrite is what a write changed: the new notes in request order and the
// notes they replaced.
type NotesWrite struct {
	RootLineID string        `json:"rootLineId"`
	Revision   int           `json:"revision"`
	Created    []domain.Note `json:"created"`
	Superseded []domain.Note `json:"superseded"`
}

// TurnNotes is what a turn's prompt needs: the active notes (newest first),
// the conversation's revision and the revision the line's last finished
// turn carried.
type TurnNotes struct {
	RootLineID string
	Notes      []domain.Note
	Revision   int
	Sent       int
}

// ListNotes returns the notes page of the line's conversation.
func (s *Store) ListNotes(ctx context.Context, tenant, lineID string) (NotesView, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return NotesView{}, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return NotesView{}, err
	}
	rows, err := s.q.ListNotes(ctx, root)
	if err != nil {
		return NotesView{}, fmt.Errorf("list notes: %w", err)
	}
	revisions, err := s.q.GetNotesRevisions(ctx, db.GetNotesRevisionsParams{RootID: root, LineID: root})
	if err != nil {
		return NotesView{}, fmt.Errorf("get notes revision: %w", err)
	}
	return NotesView{RootLineID: root.String(), Revision: int(revisions.Revision), Notes: notesFromRows(rows)}, nil
}

// NotesForTurn returns the active notes and revisions for a turn of the line.
func (s *Store) NotesForTurn(ctx context.Context, tenant, lineID string) (TurnNotes, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return TurnNotes{}, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return TurnNotes{}, err
	}
	rows, err := s.q.ListActiveNotes(ctx, root)
	if err != nil {
		return TurnNotes{}, fmt.Errorf("list active notes: %w", err)
	}
	revisions, err := s.q.GetNotesRevisions(ctx, db.GetNotesRevisionsParams{RootID: root, LineID: line.ID})
	if err != nil {
		return TurnNotes{}, fmt.Errorf("get notes revisions: %w", err)
	}
	return TurnNotes{RootLineID: root.String(), Notes: notesFromRows(rows), Revision: int(revisions.Revision), Sent: int(revisions.Sent)}, nil
}

// ApplyNotesInput is a set of note changes to write in one transaction.
type ApplyNotesInput struct {
	Tenant  string
	LineID  string
	Changes []domain.NoteChange
	Actor   string
}

// ApplyNoteChanges validates and writes the changes in one transaction: a
// refused change leaves the notes as they were. The revision moves once.
func (s *Store) ApplyNoteChanges(ctx context.Context, in ApplyNotesInput, hooks ...TxHook) (NotesWrite, error) {
	changes, err := s.normaliseNotes(in.Changes)
	if err != nil {
		return NotesWrite{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (NotesWrite, error) {
		root, err := s.lockOpenRoot(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return NotesWrite{}, err
		}
		return s.applyNoteChanges(ctx, q, root, changes, noteWriteContext{actor: in.Actor})
	})
}

// normaliseNotes checks the shape of the changes and neutralises their text.
func (s *Store) normaliseNotes(changes []domain.NoteChange) ([]domain.NoteChange, error) {
	if len(changes) == 0 {
		return nil, nil
	}
	normalised, problems := domain.NormaliseNoteChanges(changes, s.limits.Notes)
	if len(problems) > 0 {
		return nil, domain.NoteError(problems)
	}
	return normalised, nil
}

// noteWriteContext is what a write adds to every change: who wrote it and,
// for a merge, the branch and the card it came from.
type noteWriteContext struct {
	actor string
	// forcedLine replaces the requested source line (a merge names its branch).
	forcedLine uuid.NullUUID
	card       uuid.NullUUID
}

// applyNoteChanges applies changes under the root's lock and bumps the
// revision once. The caller owns the transaction.
func (s *Store) applyNoteChanges(ctx context.Context, q *db.Queries, root db.TangentLine, changes []domain.NoteChange, wc noteWriteContext) (NotesWrite, error) {
	result := NotesWrite{RootLineID: root.ID.String(), Created: []domain.Note{}, Superseded: []domain.Note{}}
	if len(changes) == 0 {
		return result, nil
	}
	counts, err := q.CountNotes(ctx, root.ID)
	if err != nil {
		return result, fmt.Errorf("count notes: %w", err)
	}
	total, active := int(counts.Total), int(counts.Active)
	for _, change := range changes {
		created, replaced, err := s.applyNoteChange(ctx, q, root, change, wc, &total, &active)
		if err != nil {
			return result, err
		}
		result.Created = append(result.Created, created)
		if replaced != nil {
			result.Superseded = append(result.Superseded, *replaced)
		}
	}
	result.Revision, err = bumpNotesRevision(ctx, q, root.ID)
	return result, err
}

// applyNoteChange writes one change and keeps the running counts.
func (s *Store) applyNoteChange(ctx context.Context, q *db.Queries, root db.TangentLine, change domain.NoteChange, wc noteWriteContext, total, active *int) (domain.Note, *domain.Note, error) {
	sourceLine, sourceMessage, err := resolveNoteSource(ctx, q, root.ID, change, wc.forcedLine)
	if err != nil {
		return domain.Note{}, nil, err
	}
	if *total+1 > s.limits.Notes.MaxTotal {
		return domain.Note{}, nil, domain.ErrNoteLimit
	}
	label, err := s.sourceLabel(ctx, q, root.ID, sourceLine, sourceMessage, wc.card)
	if err != nil {
		return domain.Note{}, nil, err
	}
	insert := db.InsertNoteParams{
		TenantID: root.TenantID, RootLineID: root.ID, Section: change.Section, Text: change.Text,
		SourceLineID: sourceLine, SourceMessageID: sourceMessage, SourceCardMessageID: wc.card, SourceLabel: label, CreatedBy: strings.TrimSpace(wc.actor),
	}
	var old db.TangentNote
	if change.Op == domain.NoteOpSupersede {
		if old, err = lockNote(ctx, q, root.ID, change.NoteID); err != nil {
			return domain.Note{}, nil, err
		}
		if old.Status == domain.NoteStatusSuperseded {
			return domain.Note{}, nil, domain.ErrNoteSuperseded
		}
		if insert.Section == "" {
			insert.Section = old.Section
		}
		if old.Status == domain.NoteStatusActive {
			*active-- // the replaced note stops counting
		}
	}
	if *active+1 > s.limits.Notes.MaxActive {
		return domain.Note{}, nil, domain.ErrNoteLimit
	}
	created, err := q.InsertNote(ctx, insert)
	if err != nil {
		return domain.Note{}, nil, fmt.Errorf("insert note: %w", err)
	}
	*total, *active = *total+1, *active+1
	if change.Op != domain.NoteOpSupersede {
		return noteFromRow(created), nil, nil
	}
	replaced, err := q.SupersedeNote(ctx, db.SupersedeNoteParams{ID: old.ID, SupersededBy: uuid.NullUUID{UUID: created.ID, Valid: true}})
	if err != nil {
		return domain.Note{}, nil, fmt.Errorf("supersede note: %w", err)
	}
	note := noteFromRow(replaced)
	return noteFromRow(created), &note, nil
}

func bumpNotesRevision(ctx context.Context, q *db.Queries, rootID uuid.UUID) (int, error) {
	revision, err := q.BumpNotesRevision(ctx, rootID)
	if err != nil {
		return 0, fmt.Errorf("bump notes revision: %w", err)
	}
	return int(revision), nil
}

// lockNote loads a note of this conversation under a row lock.
func lockNote(ctx context.Context, q *db.Queries, rootID uuid.UUID, noteID string) (db.TangentNote, error) {
	id, ok := parseID(noteID)
	if !ok {
		return db.TangentNote{}, domain.ErrNoteNotFound
	}
	row, err := q.GetNoteForUpdate(ctx, db.GetNoteForUpdateParams{ID: id, RootLineID: rootID})
	if err != nil {
		return db.TangentNote{}, lookup(err, domain.ErrNoteNotFound, "get note")
	}
	return row, nil
}

// resolveNoteSource checks the change's source message and line belong to
// this conversation. A message wins over a line: the note's source line is
// the line that message sits on.
func resolveNoteSource(ctx context.Context, q *db.Queries, rootID uuid.UUID, change domain.NoteChange, forced uuid.NullUUID) (line, message uuid.NullUUID, err error) {
	line = nullID(change.SourceLineID)
	if forced.Valid {
		line = forced
	}
	if strings.TrimSpace(change.SourceMessageID) != "" {
		id, ok := parseID(change.SourceMessageID)
		if !ok {
			return line, message, domain.ErrNoteSourceNotFound
		}
		row, err := q.MessageLineInTree(ctx, db.MessageLineInTreeParams{RootID: rootID, MessageID: id})
		if noRows(err) || (err == nil && !row.InTree) {
			return line, message, domain.ErrNoteSourceNotFound
		}
		if err != nil {
			return line, message, fmt.Errorf("check note source message: %w", err)
		}
		return uuid.NullUUID{UUID: row.LineID, Valid: true}, uuid.NullUUID{UUID: id, Valid: true}, nil
	}
	if strings.TrimSpace(change.SourceLineID) == "" || forced.Valid {
		return line, message, nil
	}
	if !line.Valid {
		return line, message, domain.ErrNoteSourceNotFound
	}
	inTree, err := q.LineInTree(ctx, db.LineInTreeParams{RootID: rootID, LineID: line.UUID})
	if noRows(err) || (err == nil && !inTree) {
		return line, message, domain.ErrNoteSourceNotFound
	}
	if err != nil {
		return line, message, fmt.Errorf("check note source line: %w", err)
	}
	return line, message, nil
}

// NotePatch changes one note in place; nil fields stay as they are. Status
// may be active or done (superseding is ApplyNoteChanges' job).
type NotePatch struct {
	Text    *string
	Section *string
	Status  *string
}

// NoteUpdate is a changed note and the conversation's new notes revision.
type NoteUpdate struct {
	RootLineID string
	Revision   int
	Note       domain.Note
}

// UpdateNote changes the text, section or status of a note that has not been
// superseded.
func (s *Store) UpdateNote(ctx context.Context, tenant, lineID, noteID string, patch NotePatch, hooks ...TxHook) (NoteUpdate, error) {
	if err := s.checkNotePatch(&patch); err != nil {
		return NoteUpdate{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (NoteUpdate, error) {
		root, err := s.lockOpenRoot(ctx, q, tenant, lineID)
		if err != nil {
			return NoteUpdate{}, err
		}
		note, err := lockNote(ctx, q, root.ID, noteID)
		if err != nil {
			return NoteUpdate{}, err
		}
		if note.Status == domain.NoteStatusSuperseded {
			return NoteUpdate{}, domain.ErrNoteSuperseded
		}
		params := db.UpdateNoteParams{ID: note.ID, Section: note.Section, Text: note.Text, Status: note.Status}
		if patch.Text != nil {
			params.Text = *patch.Text
		}
		if patch.Section != nil {
			params.Section = *patch.Section
		}
		if patch.Status != nil {
			params.Status = *patch.Status
		}
		if err := s.requireRoomToReactivate(ctx, q, root.ID, note.Status, params.Status); err != nil {
			return NoteUpdate{}, err
		}
		updated, err := q.UpdateNote(ctx, params)
		if err != nil {
			return NoteUpdate{}, fmt.Errorf("update note: %w", err)
		}
		out := NoteUpdate{RootLineID: root.ID.String(), Note: noteFromRow(updated)}
		out.Revision, err = bumpNotesRevision(ctx, q, root.ID)
		return out, err
	})
}

// checkNotePatch neutralises the text and checks section and status.
func (s *Store) checkNotePatch(patch *NotePatch) error {
	problems := []domain.NoteProblem{}
	if patch.Text != nil {
		text, problem := domain.CheckNoteText("text", *patch.Text, s.limits.Notes.MaxRunes)
		if problem != nil {
			problems = append(problems, *problem)
		}
		patch.Text = &text
	}
	if patch.Section != nil && !domain.ValidNoteSection(strings.TrimSpace(*patch.Section)) {
		problems = append(problems, domain.NoteProblem{Field: "section", Message: "must be decided, fact, to_confirm or todo"})
	}
	if patch.Status != nil && *patch.Status != domain.NoteStatusActive && *patch.Status != domain.NoteStatusDone {
		problems = append(problems, domain.NoteProblem{Field: "status", Message: "must be active or done"})
	}
	if len(problems) > 0 {
		return domain.NoteError(problems)
	}
	if patch.Section != nil {
		section := strings.TrimSpace(*patch.Section)
		patch.Section = &section
	}
	return nil
}

// requireRoomToReactivate keeps the active cap when a done note comes back.
func (s *Store) requireRoomToReactivate(ctx context.Context, q *db.Queries, rootID uuid.UUID, from, to string) error {
	if to != domain.NoteStatusActive || from == domain.NoteStatusActive {
		return nil
	}
	counts, err := q.CountNotes(ctx, rootID)
	if err != nil {
		return fmt.Errorf("count notes: %w", err)
	}
	if int(counts.Active)+1 > s.limits.Notes.MaxActive {
		return domain.ErrNoteLimit
	}
	return nil
}

// sourceLabel is the text snapshot of a note's source (NoteSourceLabels):
// the main line with the source message's "#n" among its chat messages, or
// the source branch's kind and purpose, or its card.
func (s *Store) sourceLabel(ctx context.Context, q *db.Queries, rootID uuid.UUID, line, message, card uuid.NullUUID) (string, error) {
	if !line.Valid {
		return "", nil
	}
	facts := domain.NoteSourceFacts{HasLine: true, Card: card.Valid}
	if line.UUID == rootID && !card.Valid {
		facts.OnRoot = true
		n, err := mainNumber(ctx, q, rootID, message)
		facts.MainNumber = n
		return s.labels.Render(facts), err
	}
	row, isBranch, err := branchRowFor(ctx, q, line.UUID)
	if err != nil || !isBranch {
		return "", err
	}
	facts.BranchKind, facts.BranchPurpose, facts.BranchOrigin = row.Kind, row.Purpose, row.Origin
	return s.labels.Render(facts), nil
}

// mainNumber is the 1-based place of a chat message among the main line's
// chat messages; 0 for no message or one that is not a chat message there.
func mainNumber(ctx context.Context, q *db.Queries, rootID uuid.UUID, message uuid.NullUUID) (int, error) {
	if !message.Valid {
		return 0, nil
	}
	row, err := q.GetMessage(ctx, message.UUID)
	if err != nil {
		return 0, lookup(err, domain.ErrNoteSourceNotFound, "get note source")
	}
	chat := row.Kind == domain.MessageKindChat && (row.Role == domain.RoleUser || row.Role == domain.RoleAssistant)
	if row.LineID != rootID || !chat {
		return 0, nil
	}
	n, err := q.CountChatMessagesUpTo(ctx, db.CountChatMessagesUpToParams{LineID: rootID, Seq: row.Seq})
	if err != nil {
		return 0, fmt.Errorf("number the note source: %w", err)
	}
	return int(n), nil
}
