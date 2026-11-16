package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// Notes routes (the notes feature) and chapter routes (chapters). {id} is
// any line of the conversation; notes and milestones belong to its tree.

func (a *api) listNotes(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	view, err := a.engine.ListNotes(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	l := a.limits.Notes
	return http.StatusOK, notesView{
		RootLineID: view.RootLineID, Revision: view.Revision, Notes: list(view.Notes),
		Limits: noteLimits{MaxActive: l.MaxActive, MaxTotal: l.MaxTotal, MaxRunes: l.MaxRunes, MaxChangesPerMerge: l.MaxChangesPerMerge, TokenBudget: l.TokenBudget},
	}, nil
}

// noteBody is POST /notes, POST /notes/{nid}/supersede and PATCH
// /notes/{nid} (where status may be set and the sources may not).
type noteBody struct {
	Section         string  `json:"section"`
	Text            *string `json:"text"`
	Status          *string `json:"status"`
	SourceLineID    string  `json:"sourceLineId"`
	SourceMessageID string  `json:"sourceMessageId"`
}

func (a *api) createNote(c *call) (int, any, error) {
	return a.writeNote(c, domain.NoteOpAdd, "")
}

func (a *api) supersedeNote(c *call) (int, any, error) {
	noteID, err := c.pathID("nid", domain.ErrNoteNotFound)
	if err != nil {
		return 0, nil, err
	}
	return a.writeNote(c, domain.NoteOpSupersede, noteID)
}

// writeNote adds a note or supersedes one: 201 {note, superseded?, revision}.
func (a *api) writeNote(c *call, op, noteID string) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in noteBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	change := domain.NoteChange{
		Op: op, NoteID: noteID, Section: in.Section, Text: deref(in.Text), SourceLineID: in.SourceLineID, SourceMessageID: in.SourceMessageID,
	}
	write, err := a.engine.ApplyNoteChanges(c.ctx, c.scope, id, []domain.NoteChange{change}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	if len(write.Created) == 0 {
		return 0, nil, invalid("the note was not written")
	}
	body := noteWrite{Note: write.Created[0], Revision: write.Revision, RootLineID: write.RootLineID}
	if len(write.Superseded) > 0 {
		body.Superseded = &write.Superseded[0]
	}
	return http.StatusCreated, body, nil
}

func (a *api) updateNote(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	noteID, err := c.pathID("nid", domain.ErrNoteNotFound)
	if err != nil {
		return 0, nil, err
	}
	var in noteBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	patch := tangent.NotePatch{Text: in.Text, Status: in.Status}
	if in.Section != "" {
		patch.Section = &in.Section
	}
	update, err := a.engine.UpdateNote(c.ctx, c.scope, id, noteID, patch, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, noteWrite{Note: update.Note, Revision: update.Revision, RootLineID: update.RootLineID}, nil
}

func (a *api) listChapters(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	view, err := a.engine.ListChapters(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	l := a.limits.Chapters
	return http.StatusOK, chaptersView{
		LineID: view.LineID, RootLineID: view.RootLineID, Chapters: list(view.Chapters), Milestones: list(view.Milestones),
		Limits: chapterLimits{
			MaxChapters: l.MaxCount, MinMessages: l.MinMessages, IdleGapMinutes: int(l.IdleGap.Minutes()),
			MaxMilestones: l.MilestoneMaxPerTree, MilestoneMaxLen: l.MilestoneTitleMaxRunes,
		},
	}, nil
}

// milestoneBody is POST /chapters/milestones.
type milestoneBody struct {
	MessageID string `json:"messageId"`
	Title     string `json:"title"`
}

func (a *api) addMilestone(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in milestoneBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	change, err := a.engine.AddMilestone(c.ctx, c.scope, id, tangent.MilestoneInput{MessageID: in.MessageID, Title: in.Title}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, milestoneAdded{Milestone: change.Cut, RootLineID: change.RootLineID}, nil
}

func (a *api) deleteMilestone(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	milestoneID, err := c.pathID("mid", domain.ErrChapterMilestoneNotFound)
	if err != nil {
		return 0, nil, err
	}
	if _, err := a.engine.DeleteMilestone(c.ctx, c.scope, id, milestoneID, c.tx()...); err != nil {
		return 0, nil, err
	}
	return http.StatusNoContent, nil, nil
}
