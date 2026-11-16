package tangent_test

import (
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

const longQuestion = "請問家用 NAS 要選哪一種磁碟陣列比較好呢" // more than 20 runes

func topicLine(title string) string { return "\n" + domain.TopicMarker + `{"title":"` + title + `"}` }

func chapterLine(title string) string {
	return "\n" + domain.ChapterCutMarker + `{"title":"` + title + `"}`
}

// lineUpdates are the recorded line.updated payloads of a line.
func (e *env) lineUpdates(lineID string) []domain.LineView {
	out := []domain.LineView{}
	for _, ev := range e.events.OfType(tangent.EventLineUpdated) {
		if line := ev.Data.(domain.LineView); line.ID == lineID {
			out = append(out, line)
		}
	}
	return out
}

func TestTopic_TheMainLineFirstTurnRenamesTheLine(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.events.Reset()
	done := e.turn(main.ID, longQuestion, "RAID 1 is the safe choice."+topicLine("家用 NAS 磁碟陣列"))
	if !strings.Contains(e.lastSystem(), strings.TrimSpace(domain.TopicSummaryRule)) {
		t.Fatalf("the first turn's prompt asks for a topic: %q", e.lastSystem())
	}
	if done.Message.Content != "RAID 1 is the safe choice." || done.Line.Title != "家用 NAS 磁碟陣列" {
		t.Fatalf("content %q, title %q", done.Message.Content, done.Line.Title)
	}
	updates := e.lineUpdates(main.ID)
	if len(updates) < 2 || updates[len(updates)-1].Title != "家用 NAS 磁碟陣列" {
		t.Fatalf("line.updated with the new title: %+v", updates)
	}
	if got, _ := e.engine.GetLine(e.ctx, scopeA, main.ID); got.Title != "家用 NAS 磁碟陣列" {
		t.Fatalf("stored title %q", got.Title)
	}
	// The first chapter is named after the topic (a cut on the first message
	// opens no chapter of its own).
	if len(e.events.OfType(tangent.EventChaptersChanged)) != 1 {
		t.Fatalf("chapters.changed: %v", e.events.Types())
	}
	view, err := e.engine.ListChapters(e.ctx, scopeA, main.ID)
	if err != nil || len(view.Chapters) != 1 || view.Chapters[0].Title != "家用 NAS 磁碟陣列" || view.Chapters[0].TitleSource != domain.ChapterTitleTopic {
		t.Fatalf("chapters %+v (%v)", view.Chapters, err)
	}

	// Later turns do not ask, and a [TOPIC] line they carry is only removed.
	e.events.Reset()
	later := e.turn(main.ID, longQuestion+" again", "More."+topicLine("Other"))
	if strings.Contains(e.lastSystem(), domain.TopicMarker) || later.Message.Content != "More." || later.Line.Title != "家用 NAS 磁碟陣列" {
		t.Fatalf("second turn: system has rule %v, content %q, title %q", strings.Contains(e.lastSystem(), domain.TopicMarker), later.Message.Content, later.Line.Title)
	}
	if len(e.lineUpdates(main.ID)) != 2 || len(e.events.OfType(tangent.EventChaptersChanged)) != 0 { // begin + complete, no rename
		t.Fatalf("a later topic changes nothing: %v", e.events.Types())
	}
}

func TestTopic_AShortFirstMessageKeepsTheTitleUnlessThereIsNone(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	done := e.turn(main.ID, "NAS 選哪種 RAID？", "RAID 1."+topicLine("NAS RAID"))
	if strings.Contains(e.lastSystem(), domain.TopicMarker) || done.Message.Content != "RAID 1." || done.Line.Title != "main" {
		t.Fatalf("short message: content %q, title %q", done.Message.Content, done.Line.Title)
	}
	untitled, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{})
	if err != nil {
		t.Fatal(err)
	}
	done = e.turn(untitled.ID, "NAS?", "RAID 1."+topicLine("NAS RAID"))
	if !strings.Contains(e.lastSystem(), strings.TrimSpace(domain.TopicSummaryRule)) || done.Line.Title != "NAS RAID" {
		t.Fatalf("untitled line: title %q", done.Line.Title)
	}
}

func TestTopic_AnInvalidTopicIsRemovedAndChangesNothing(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	done := e.turn(main.ID, longQuestion, "Answer.\n"+domain.TopicMarker+`{"title":"`+strings.Repeat("長", domain.TopicSummaryMaxRunes+1)+`"}`)
	if done.Message.Content != "Answer." || done.Line.Title != "main" {
		t.Fatalf("content %q, title %q", done.Message.Content, done.Line.Title)
	}
}

func TestTopic_ABranchWithALongPurposeIsRenamedAnAsideNever(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a").Message
	purpose := strings.Repeat("查", 26)
	branch := e.branch(main.ID, anchor.ID, purpose)
	e.events.Reset()
	done := e.turn(branch.Line.ID, "go on", "Found it."+topicLine("磁碟陣列比較"))
	if !strings.Contains(e.lastSystem(), strings.TrimSpace(domain.TopicSummaryRule)) {
		t.Fatalf("a long purpose asks for a topic")
	}
	if done.Message.Content != "Found it." || done.Line.Title != "磁碟陣列比較" || done.Line.ConversationBranch.Purpose != "磁碟陣列比較" {
		t.Fatalf("content %q, line %+v", done.Message.Content, done.Line)
	}
	renamed := e.events.OfType(tangent.EventBranchChanged)
	if len(renamed) != 1 {
		t.Fatalf("branch.changed: %v", e.events.Types())
	}
	if change := renamed[0].Data.(tangent.BranchChange); change.Change != tangent.BranchRenamed || change.Branch.Purpose != "磁碟陣列比較" {
		t.Fatalf("branch.changed %+v", change)
	}
	if updates := e.lineUpdates(branch.Line.ID); updates[len(updates)-1].Title != "磁碟陣列比較" {
		t.Fatalf("line.updated %+v", updates)
	}
	if len(e.events.OfType(tangent.EventChaptersChanged)) != 0 {
		t.Fatalf("a branch topic records no chapter: %v", e.events.Types())
	}

	short := e.branch(main.ID, anchor.ID, "了解：豪斯多夫維度")
	done = e.turn(short.Line.ID, longQuestion+longQuestion, "Sure."+topicLine("Other"))
	if strings.Contains(e.lastSystem(), domain.TopicMarker) || done.Line.ConversationBranch.Purpose != "了解：豪斯多夫維度" || done.Message.Content != "Sure." {
		t.Fatalf("a short purpose is kept: %+v", done.Line.ConversationBranch)
	}

	aside, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{AnchorMessageID: anchor.ID, Purpose: purpose, Kind: domain.BranchKindAside})
	if err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	done = e.turn(aside.Line.ID, longQuestion, "Short answer."+topicLine("Other"))
	if strings.Contains(e.lastSystem(), domain.TopicMarker) || done.Message.Content != "Short answer." {
		t.Fatalf("aside: rule or marker leaked: %q", done.Message.Content)
	}
	for _, ev := range e.events.OfType(tangent.EventBranchChanged) {
		if change := ev.Data.(tangent.BranchChange); change.Change == tangent.BranchRenamed || change.Branch.Purpose != purpose {
			t.Fatalf("an aside is never renamed: %+v", change)
		}
	}
}

func TestTopic_ATurnThisProcessDidNotBuildOnlyRemovesTheLine(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: longQuestion})
	if err != nil {
		t.Fatal(err)
	}
	other, err := tangent.New(e.pool, tangent.WithFeatures(tangent.AllFeatures()...))
	if err != nil {
		t.Fatal(err)
	}
	done, err := other.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "Answer." + topicLine("NAS")})
	if err != nil || done.Message.Content != "Answer." || done.Line.Title != "main" {
		t.Fatalf("content %q, title %q (%v)", done.Message.Content, done.Line.Title, err)
	}
}

func TestChapterCut_TheMainLineCutsANewChapterOnceTheCurrentOneIsLongEnough(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.exchanges(main.ID, 1)
	early := e.turn(main.ID, "next", "b"+chapterLine("Too early"))
	if strings.Contains(e.lastSystem(), domain.ChapterCutMarker) || early.Message.Content != "b" {
		t.Fatalf("two messages before the turn: no rule, the line removed (%q)", early.Message.Content)
	}
	if n := e.count(`SELECT count(*) FROM tangent_chapter_cut WHERE root_line_id = $1`, main.ID); n != 0 {
		t.Fatalf("an unasked cut was recorded: %d", n)
	}
	e.events.Reset()
	done := e.turn(main.ID, "now about backups", "Backups."+chapterLine("備份策略"))
	if !strings.Contains(e.lastSystem(), strings.TrimSpace(domain.ChapterCutRule)) {
		t.Fatalf("four messages before the turn allow a cut")
	}
	if done.Message.Content != "Backups." {
		t.Fatalf("content %q", done.Message.Content)
	}
	changed := e.events.OfType(tangent.EventChaptersChanged)
	if len(changed) != 1 || changed[0].Data.(tangent.ChaptersChange).RootLineID != main.ID {
		t.Fatalf("chapters.changed: %v", e.events.Types())
	}
	view, err := e.engine.ListChapters(e.ctx, scopeA, main.ID)
	if err != nil || len(view.Chapters) != 2 {
		t.Fatalf("chapters %+v (%v)", view.Chapters, err)
	}
	second := view.Chapters[1]
	messages, _ := e.engine.ListMessages(e.ctx, scopeA, main.ID, 0, 100)
	user := messages[len(messages)-2]
	if second.Title != "備份策略" || second.Kind != domain.ChapterKindTopic || second.StartMessageID != user.ID || user.Role != domain.RoleUser {
		t.Fatalf("second chapter %+v, user %+v", second, user)
	}
	// Right after a cut the new chapter is too short again.
	e.turn(main.ID, "more", "c")
	if strings.Contains(e.lastSystem(), domain.ChapterCutMarker) {
		t.Fatalf("the new chapter is still short")
	}
}

func TestChapterCut_BranchesNeverGetTheRule(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a").Message
	branch := e.branch(main.ID, anchor.ID, "look")
	e.exchanges(branch.Line.ID, 3)
	done := e.turn(branch.Line.ID, "q", "x"+chapterLine("No"))
	if strings.Contains(e.lastSystem(), domain.ChapterCutMarker) || done.Message.Content != "x" {
		t.Fatalf("branch: rule or marker leaked")
	}
}

func TestChapterCut_ChaptersOffOnlyRemovesTheLines(t *testing.T) {
	e := newEnvWith(t, without(tangent.FeatureChapters))
	main := e.mainLine()
	first := e.turn(main.ID, longQuestion, "a"+topicLine("NAS")+chapterLine("Stage"))
	if first.Message.Content != "a" || first.Line.Title != "NAS" {
		t.Fatalf("the topic is core: content %q, title %q", first.Message.Content, first.Line.Title)
	}
	e.exchanges(main.ID, 2)
	e.events.Reset()
	done := e.turn(main.ID, "new topic", "b"+chapterLine("Stage"))
	if strings.Contains(e.lastSystem(), domain.ChapterCutMarker) || done.Message.Content != "b" {
		t.Fatalf("chapters off: rule or marker leaked")
	}
	if n := e.count(`SELECT count(*) FROM tangent_chapter_cut WHERE root_line_id = $1`, main.ID); n != 0 || len(e.events.OfType(tangent.EventChaptersChanged)) != 0 {
		t.Fatalf("chapters off recorded %d cuts: %v", n, e.events.Types())
	}
}

// begin starts a turn the test completes itself.
func (e *env) begin(lineID, content string) tangent.Turn {
	e.t.Helper()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, lineID, tangent.TurnInput{Content: content})
	if err != nil {
		e.t.Fatal(err)
	}
	return turn
}

func (e *env) complete(turn tangent.Turn, content string) tangent.CompletedTurn {
	e.t.Helper()
	done, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: content})
	if err != nil {
		e.t.Fatal(err)
	}
	return done
}

func TestTopic_TheRulesAreATrailingSection(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.exchanges(main.ID, 2)
	main2 := e.mainLine()
	turn := e.begin(main2.ID, longQuestion)
	stable, volatile, _ := turn.Prompt.ChatBlocks()
	if strings.Contains(stable, domain.TopicMarker) || !strings.Contains(volatile, strings.TrimSpace(domain.TopicSummaryRule)) {
		t.Fatalf("stable %q, volatile %q", stable, volatile)
	}
	chapter := e.begin(main.ID, "next")
	stable, volatile, _ = chapter.Prompt.ChatBlocks()
	if strings.Contains(stable, domain.ChapterCutMarker) || !strings.Contains(volatile, strings.TrimSpace(domain.ChapterCutRule)) {
		t.Fatalf("stable %q, volatile %q", stable, volatile)
	}
}

func TestTopic_ARenameDuringTheFirstTurnIsKept(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	turn := e.begin(main.ID, longQuestion)
	mine := "My own name"
	if _, err := e.engine.UpdateLine(e.ctx, scopeA, main.ID, tangent.LinePatch{Title: &mine}); err != nil {
		t.Fatal(err)
	}
	if done := e.complete(turn, "a"+topicLine("NAS")); done.Line.Title != mine || done.Message.Content != "a" {
		t.Fatalf("main: title %q, content %q", done.Line.Title, done.Message.Content)
	}

	untitled, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{})
	if err != nil {
		t.Fatal(err)
	}
	turn = e.begin(untitled.ID, "NAS?")
	provisional := "NAS?"
	if _, err := e.engine.UpdateLine(e.ctx, scopeA, untitled.ID, tangent.LinePatch{Title: &provisional}); err != nil {
		t.Fatal(err)
	}
	if done := e.complete(turn, "a"+topicLine("家用 NAS")); done.Line.Title != "家用 NAS" {
		t.Fatalf("a provisional title on an untitled line is replaced: %q", done.Line.Title)
	}

	anchor := e.turn(main.ID, "q", "a").Message
	branch := e.branch(main.ID, anchor.ID, strings.Repeat("查", 26))
	turn = e.begin(branch.Line.ID, "go")
	if _, err := e.engine.RenameBranch(e.ctx, scopeA, branch.Line.ID, "我改的目的"); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	done := e.complete(turn, "b"+topicLine("Other"))
	if done.Line.ConversationBranch.Purpose != "我改的目的" || len(e.events.OfType(tangent.EventBranchChanged)) != 0 {
		t.Fatalf("branch: %+v, events %v", done.Line.ConversationBranch, e.events.Types())
	}
}

func TestTopic_AFailedRenameOrCutLeavesTheTurnCompleted(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a").Message
	branch := e.branch(main.ID, anchor.ID, strings.Repeat("查", 26))
	turn := e.begin(branch.Line.ID, "go")
	e.exec(`CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`)
	e.exec(`CREATE TRIGGER refuse_purpose BEFORE UPDATE OF purpose ON tangent_branch FOR EACH ROW EXECUTE FUNCTION refuse()`)
	done := e.complete(turn, "b"+topicLine("Other"))
	if done.Message.Status != domain.MessageDone || done.Message.Content != "b" || done.Line.Status != domain.LineStatusIdle ||
		done.Line.ConversationBranch.Purpose != strings.Repeat("查", 26) {
		t.Fatalf("branch: %+v / %+v", done.Message, done.Line.ConversationBranch)
	}

	fresh := e.mainLine()
	e.exec(`CREATE TRIGGER refuse_cut BEFORE INSERT ON tangent_chapter_cut FOR EACH ROW EXECUTE FUNCTION refuse()`)
	e.events.Reset()
	done = e.complete(e.begin(fresh.ID, longQuestion), "c"+topicLine("NAS"))
	if done.Message.Status != domain.MessageDone || done.Line.Title != "NAS" || len(e.events.OfType(tangent.EventChaptersChanged)) != 0 {
		t.Fatalf("cut refused: %+v, title %q, events %v", done.Message, done.Line.Title, e.events.Types())
	}
}
