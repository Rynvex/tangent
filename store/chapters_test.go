package store_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// fillLine adds n exchanges to a line and returns its messages.
func (f *fixture) fillLine(lineID string, n int) []domain.Message {
	f.t.Helper()
	for i := range n {
		f.exchange(lineID, "q"+string(rune('a'+i)), "a"+string(rune('a'+i)))
	}
	messages, err := f.store.ListMessages(f.ctx, tenant, lineID, 0, 500)
	if err != nil {
		f.t.Fatal(err)
	}
	return messages
}

func (f *fixture) chapters(lineID string) store.ChaptersView {
	f.t.Helper()
	view, err := f.store.ListChapters(f.ctx, tenant, lineID)
	if err != nil {
		f.t.Fatal(err)
	}
	return view
}

func (f *fixture) milestone(lineID, messageID, title string) (store.ChapterChange, error) {
	return f.store.AddMilestone(f.ctx, store.MilestoneInput{Tenant: tenant, LineID: lineID, MessageID: messageID, Title: title, Actor: "chang"})
}

func TestChapters_IdleGapCutsTheLineAndAnEmptyLineHasNone(t *testing.T) {
	f := newFixture(t)
	empty, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant})
	if err != nil {
		t.Fatal(err)
	}
	if got := f.chapters(empty.ID); len(got.Chapters) != 0 || got.Milestones == nil {
		t.Fatalf("empty line = %+v", got)
	}
	line, _ := f.mainLine()
	msgs := f.fillLine(line.ID, 3)
	f.exec(`UPDATE tangent_message SET created_at = created_at + make_interval(secs => $2) WHERE line_id = $1 AND seq >= $3`,
		line.ID, (domain.DefaultLimits().Chapters.IdleGap + time.Minute).Seconds(), msgs[4].Seq)
	got := f.chapters(line.ID).Chapters
	if len(got) != 2 || got[1].Kind != domain.ChapterKindIdle || got[1].StartMessageID != msgs[4].ID || got[0].MessageCount != 4 || got[1].MessageCount != 4 {
		t.Fatalf("chapters = %+v", got)
	}
}

func TestChapters_MilestoneLifecycleAndValidation(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	msgs := f.fillLine(line.ID, 3)
	added, err := f.milestone(line.ID, msgs[4].ID, "  Decision day ")
	if err != nil || added.Cut.Title != "Decision day" || added.Cut.CreatedBy != "chang" || added.RootLineID != line.ID {
		t.Fatalf("add = %+v err=%v", added, err)
	}
	got := f.chapters(line.ID)
	if len(got.Chapters) != 2 || got.Chapters[1].Title != "Decision day" || len(got.Milestones) != 1 {
		t.Fatalf("chapters = %+v", got)
	}
	if _, err := f.milestone(line.ID, msgs[4].ID, "again"); !errors.Is(err, domain.ErrChapterMilestoneExists) {
		t.Fatalf("duplicate = %v", err)
	}
	if _, err := f.milestone(line.ID, msgs[6].ID, strings.Repeat("x", 81)); !errors.Is(err, domain.ErrChapterTitleInvalid) {
		t.Fatalf("long title = %v", err)
	}
	if _, err := f.milestone(line.ID, "00000000-0000-0000-0000-0000000000aa", "x"); !errors.Is(err, domain.ErrChapterMessageNotFound) {
		t.Fatalf("unknown message = %v", err)
	}
	if _, err := f.store.DeleteMilestone(f.ctx, tenant, line.ID, added.Cut.ID); err != nil || len(f.chapters(line.ID).Chapters) != 1 {
		t.Fatalf("delete = %v", err)
	}
	if _, err := f.store.DeleteMilestone(f.ctx, tenant, line.ID, added.Cut.ID); !errors.Is(err, domain.ErrChapterMilestoneNotFound) {
		t.Fatalf("delete twice = %v", err)
	}
}

func TestChapters_TenantAndTreeIsolation(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	msgs := f.fillLine(line.ID, 2)
	other, foreign := f.mainLine()
	if _, err := f.store.ListChapters(f.ctx, otherTenant, line.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("other tenant = %v", err)
	}
	if _, err := f.milestone(line.ID, foreign.ID, "x"); !errors.Is(err, domain.ErrChapterMessageNotFound) {
		t.Fatalf("a message of another conversation = %v", err)
	}
	own, err := f.milestone(line.ID, msgs[1].ID, "mine")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.DeleteMilestone(f.ctx, tenant, other.ID, own.Cut.ID); !errors.Is(err, domain.ErrChapterMilestoneNotFound) {
		t.Fatalf("delete through another conversation = %v", err)
	}
	if _, err := f.store.ArchiveTree(f.ctx, tenant, line.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := f.milestone(line.ID, msgs[2].ID, "late"); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("milestone on an archived conversation = %v", err)
	}
}

func TestChapters_BranchesCardsAndMovedMessages(t *testing.T) {
	f := newFixture(t)
	root, branch := f.openBranch()
	card := f.card(root.ID)
	msgs := f.fillLine(root.ID, 2)
	if _, err := f.milestone(root.ID, msgs[3].ID, "tail"); err != nil {
		t.Fatal(err)
	}
	got := f.chapters(root.ID).Chapters
	if len(got) != 2 || len(got[0].BranchIDs) != 1 || got[0].BranchIDs[0] != branch.ID {
		t.Fatalf("branch placement = %+v", got)
	}
	if len(got[0].CardMessageIDs) != 1 || got[0].CardMessageIDs[0] != card.ID || len(got[1].CardMessageIDs) != 0 {
		t.Fatalf("card placement = %+v", got)
	}
	moved := f.move(root.ID, 2)
	if after := f.chapters(root.ID); len(after.Milestones) != 1 || len(after.Chapters) != 2 {
		t.Fatalf("after move = %+v", after)
	}
	if line := f.chapters(moved.Line.ID); len(line.Chapters) != 1 || len(line.Milestones) != 0 || line.RootLineID != root.ID {
		t.Fatalf("branch line = %+v", line)
	}
}

func TestChapters_MilestoneOnAMovedMessageNoLongerCutsTheSourceLine(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	msgs := f.fillLine(line.ID, 4)
	if _, err := f.milestone(line.ID, msgs[len(msgs)-1].ID, "moved soon"); err != nil {
		t.Fatal(err)
	}
	moved := f.move(line.ID, 2)
	if src := f.chapters(line.ID); len(src.Chapters) != 1 || len(src.Milestones) != 0 {
		t.Fatalf("source = %+v", src)
	}
	if got := f.chapters(moved.Line.ID); len(got.Milestones) != 1 {
		t.Fatalf("branch = %+v", got)
	}
}

func TestChapters_RecordTopicCutOncePerMessage(t *testing.T) {
	f := newFixture(t)
	line, anchor := f.mainLine()
	first, err := f.store.RecordTopicCut(f.ctx, tenant, line.ID, anchor.ID, strings.Repeat("t", 200))
	if err != nil || first.Cut == nil || len([]rune(first.Cut.Title)) != 120 || first.RootLineID != line.ID {
		t.Fatalf("first cut = %+v err=%v", first, err)
	}
	second, err := f.store.RecordTopicCut(f.ctx, tenant, line.ID, anchor.ID, "again")
	if err != nil || second.Cut != nil {
		t.Fatalf("second cut on the same message = %+v err=%v", second, err)
	}
	other, foreign := f.mainLine()
	_ = other
	if _, err := f.store.RecordTopicCut(f.ctx, tenant, line.ID, foreign.ID, "x"); !errors.Is(err, domain.ErrChapterMessageNotFound) {
		t.Fatalf("a message of another line = %v", err)
	}
}
