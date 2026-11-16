package tangent_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// B21: long imports (a 750-message main line, a 200-message merged branch,
// 25 chapter cuts) are planned and written in one go.

const (
	b21MainMessages   = 750
	b21BranchMessages = 200
	b21ChapterCuts    = 25
)

// b21Turns is n messages taking turns, the first a question.
func b21Turns(prefix string, n int) []domain.ImportMessage {
	out := make([]domain.ImportMessage, n)
	for i := range out {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		out[i] = domain.ImportMessage{ExternalID: fmt.Sprintf("%s%d", prefix, i), Role: role, Content: fmt.Sprintf("%s message %d", prefix, i)}
	}
	return out
}

// fullTranscript is all of a line's messages in seq order, page by page.
func (e *env) fullTranscript(lineID string) []domain.Message {
	e.t.Helper()
	var out []domain.Message
	after := int64(0)
	for {
		page, err := e.engine.ListMessages(e.ctx, scopeA, lineID, after, 500)
		if err != nil {
			e.t.Fatal(err)
		}
		out = append(out, page...)
		if len(page) < 500 {
			return out
		}
		after = page[len(page)-1].Seq
	}
}

func longImport() tangent.ImportInput {
	in := tangent.ImportInput{Title: "Long combined export", Folder: "雜談", Messages: b21Turns("m", b21MainMessages)}
	in.Branches = []domain.ImportBranch{{
		AnchorExternalID: "m101", Purpose: "A long side discussion", Status: domain.BranchStatusMerged,
		Card:     &domain.BranchCard{Conclusion: "The side discussion settled it."},
		Messages: b21Turns("b", b21BranchMessages),
	}}
	for i := range b21ChapterCuts {
		in.ChapterCuts = append(in.ChapterCuts, domain.ImportChapterCut{AnchorExternalID: fmt.Sprintf("m%d", i*30), Title: fmt.Sprintf("§%d", i+1)})
	}
	return in
}

func TestImport_LongConversationIsPlannedAndWritten(t *testing.T) {
	e := newEnvWith(t, b18Features())
	in := longImport()
	plan, err := domain.PlanImport(in, domain.DefaultLimits(), nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Messages) != b21MainMessages || len(plan.Branches) != 1 || len(plan.Branches[0].Messages) != b21BranchMessages || len(plan.ChapterCuts) != b21ChapterCuts {
		t.Fatalf("plan = %d messages, %d branches, %d cuts", len(plan.Messages), len(plan.Branches), len(plan.ChapterCuts))
	}
	out, err := e.engine.ImportLine(e.ctx, scopeA, in)
	if err != nil {
		t.Fatal(err)
	}
	if out.MessageCount != b21MainMessages || len(out.Cuts) != b21ChapterCuts || out.Line.BranchCounts.Merged != 1 || out.Line.Folder != "雜談" {
		t.Fatalf("count %d cuts %d branches %+v folder %q", out.MessageCount, len(out.Cuts), out.Line.BranchCounts, out.Line.Folder)
	}
	// The main line holds every message and the merged branch's card.
	if main := e.fullTranscript(out.Line.ID); len(main) != b21MainMessages+1 || main[102].Kind != domain.MessageKindBranchCard {
		t.Fatalf("main line has %d messages", len(main))
	}
	if side := e.transcript(out.Branches[0].LineID); len(side) != b21BranchMessages {
		t.Fatalf("branch has %d messages", len(side))
	}
	// Decompose reads the whole main line (DecomposeMaxMessages is 2000).
	decomposed, err := e.engine.Decompose(e.ctx, scopeA, out.Line.ID)
	if err != nil || decomposed.Truncated {
		t.Fatalf("decompose truncated %v: %v", decomposed.Truncated, err)
	}
}
