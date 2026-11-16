package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Notes is the notes page of a conversation (decided / fact / to_confirm /
// todo): carried by every turn, written with merges or on its own. Off: the
// prompt carries no notes, merge noteChanges and the notes calls return
// feature_disabled; stored notes are kept.
func Notes() Feature { return onOff(FeatureNotes, registerNotes) }

func registerNotes(r *registry, _ *module) {
	r.addContextProvider(notesContext)
	r.addOnTurnCompleted(notesSent)
	r.addAfterCommit(notesAfterCommit)
}

// notesContext puts the active notes into the prompt. A begun turn already
// knows its tree and revisions (chosen under the lock), so only the notes
// are read; a preview reads both.
func notesContext(ctx context.Context, e *Engine, _ Mode, pc *promptContext) error {
	if pc.begun != nil {
		notes, err := e.store.ActiveNotes(ctx, pc.begun.rootLineID)
		if err != nil {
			return err
		}
		pc.in.NotesBlock = domain.BuildNotesBlock(notes, notesBudget(e, pc))
		pc.in.NotesChanged = pc.begun.notesRevision != pc.begun.notesSent
		return nil
	}
	notes, err := e.store.NotesForTurn(ctx, pc.scope.Tenant, pc.line.ID)
	if err != nil {
		return err
	}
	pc.in.NotesBlock = domain.BuildNotesBlock(notes.Notes, notesBudget(e, pc))
	pc.in.NotesChanged = notes.Revision != notes.Sent
	return nil
}

// notesBudget is what the notes block may take: its own budget, at most
// what is left of the prompt's.
func notesBudget(e *Engine, pc *promptContext) int {
	return min(e.limits.Notes.TokenBudget, pc.budget.remaining())
}

// notesSent records, in the transaction of a turn that finished with a
// reply, the notes revision it carried; with notes off nothing is recorded,
// so turning notes back on resends them.
func notesSent(ctx context.Context, _ *Engine, _ Mode, tx store.Tx, ev txEvent) error {
	done, ok := ev.result.(store.CompletedTurn)
	if !ok || !repliedTurn(done.Message) {
		return nil
	}
	return store.MarkNotesRevisionSent(ctx, tx, done.Line.ID, done.Message.Meta.NotesRevision)
}

// notesAfterCommit publishes notes.changed for a merge that wrote notes.
func notesAfterCommit(_ context.Context, _ *Engine, _ Mode, ev *commitEvent) ([]Event, []Job) {
	if ev.kind != commitBranchClosed || ev.merged == nil {
		return nil, nil
	}
	return notesEvents(ev.scope, ev.merged.Notes), nil
}

// notesEvents is notes.changed for a write that changed the notes.
func notesEvents(scope Scope, write store.NotesWrite) []Event {
	if len(write.Created) == 0 && len(write.Superseded) == 0 {
		return nil
	}
	return []Event{notesChanged(scope, write.RootLineID, write.Revision)}
}

func notesChanged(scope Scope, rootLineID string, revision int) Event {
	return Event{
		Type: EventNotesChanged, Tenant: scope.Tenant, RootLineID: rootLineID, LineID: rootLineID,
		Data: NotesChange{RootLineID: rootLineID, Revision: revision},
	}
}

// Notes types, as the store returns them.
type (
	NotesView  = store.NotesView
	NotesWrite = store.NotesWrite
	NotePatch  = store.NotePatch
	NoteUpdate = store.NoteUpdate
)

// NoteInput is the replacement of a superseded note.
type NoteInput struct {
	Section string
	Text    string
}

// ListNotes returns the notes page of the line's conversation.
func (e *Engine) ListNotes(ctx context.Context, scope Scope, lineID string) (NotesView, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureNotes)
	if err != nil {
		return NotesView{}, err
	}
	return e.store.ListNotes(ctx, scope.Tenant, lineID)
}

// ApplyNoteChanges adds or supersedes notes in one transaction.
// InTx hooks receive store.NotesWrite.
func (e *Engine) ApplyNoteChanges(ctx context.Context, scope Scope, lineID string, changes []domain.NoteChange, opts ...TxOption) (NotesWrite, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureNotes)
	if err != nil {
		return NotesWrite{}, err
	}
	write, err := e.store.ApplyNoteChanges(ctx, store.ApplyNotesInput{Tenant: scope.Tenant, LineID: lineID, Changes: changes, Actor: scope.Actor}, hooksOf(opts)...)
	if err != nil {
		return NotesWrite{}, err
	}
	e.publish(ctx, notesEvents(scope, write)...)
	e.dispatchOrphanJobs(ctx, e.commit(ctx, &commitEvent{kind: commitNotesWritten, scope: scope, modes: modes, notes: &write, out: &txOutbox{}}))
	return write, nil
}

// UpdateNote changes the text, section or status of a note.
// InTx hooks receive store.NoteUpdate.
func (e *Engine) UpdateNote(ctx context.Context, scope Scope, lineID, noteID string, patch NotePatch, opts ...TxOption) (NoteUpdate, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureNotes)
	if err != nil {
		return NoteUpdate{}, err
	}
	update, err := e.store.UpdateNote(ctx, scope.Tenant, lineID, noteID, patch, hooksOf(opts)...)
	if err != nil {
		return NoteUpdate{}, err
	}
	e.publish(ctx, notesChanged(scope, update.RootLineID, update.Revision))
	return update, nil
}

// SupersedeNote replaces a note with a new one; the old one is kept and
// points at its successor. An empty section keeps the old note's.
// InTx hooks receive store.NotesWrite.
func (e *Engine) SupersedeNote(ctx context.Context, scope Scope, lineID, noteID string, in NoteInput, opts ...TxOption) (NotesWrite, error) {
	change := domain.NoteChange{Op: domain.NoteOpSupersede, NoteID: noteID, Section: in.Section, Text: in.Text}
	return e.ApplyNoteChanges(ctx, scope, lineID, []domain.NoteChange{change}, opts...)
}
