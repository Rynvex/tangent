package domain

import (
	"fmt"
	"testing"
	"time"
)

var chapterBase = time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC)

var chapterDefaults = DefaultLimits().Chapters

// chapterMsgs builds n messages a minute apart; gaps maps an index to extra
// minutes inserted before it.
func chapterMsgs(n int, gaps map[int]time.Duration) []ChapterMessage {
	out := make([]ChapterMessage, n)
	at := chapterBase
	for i := range out {
		at = at.Add(time.Minute + gaps[i])
		out[i] = ChapterMessage{ID: fmt.Sprintf("m%02d", i), Seq: int64(i + 1), At: at}
	}
	return out
}

// cutOf builds a cut; order is its creation order.
func cutOf(kind, msg, title string, order int) ChapterCut {
	return ChapterCut{ID: "c-" + msg + kind, MessageID: msg, Kind: kind, Title: title, CreatedAt: chapterBase.Add(time.Duration(order) * time.Second)}
}

func startIDs(cs []Chapter) []string {
	out := []string{}
	for _, c := range cs {
		out = append(out, c.StartMessageID)
	}
	return out
}

func TestComputeChapters_NoCutsIsOneTimeTitledChapter(t *testing.T) {
	cs := ComputeChapters(chapterMsgs(5, nil), nil, nil, chapterDefaults)
	if len(cs) != 1 || cs[0].MessageCount != 5 || cs[0].Kind != ChapterKindStart || cs[0].TitleSource != ChapterTitleTime || cs[0].Title != "2026-10-14 09:01" {
		t.Fatalf("chapters = %+v", cs)
	}
	if got := ComputeChapters(nil, nil, nil, chapterDefaults); got == nil || len(got) != 0 {
		t.Fatalf("empty = %#v", got)
	}
}

func TestComputeChapters_IdleGapOpensAChapter(t *testing.T) {
	cs := ComputeChapters(chapterMsgs(8, map[int]time.Duration{4: chapterDefaults.IdleGap}), nil, nil, chapterDefaults)
	if got := startIDs(cs); len(got) != 2 || got[1] != "m04" || cs[1].Kind != ChapterKindIdle || cs[0].MessageCount != 4 || cs[1].EndMessageID != "m07" {
		t.Fatalf("chapters = %+v", cs)
	}
	exact := ComputeChapters(chapterMsgs(8, map[int]time.Duration{4: chapterDefaults.IdleGap - time.Minute}), nil, nil, chapterDefaults)
	if len(exact) != 1 {
		t.Fatalf("a gap of exactly the limit must not cut: %+v", exact)
	}
}

func TestComputeChapters_TitlePrefersMilestoneThenTopicThenTime(t *testing.T) {
	cuts := []ChapterCut{
		cutOf(ChapterKindTopic, "m04", "retry policy", 1),
		cutOf(ChapterKindMilestone, "m04", "Decision day", 2),
		cutOf(ChapterKindTopic, "m08", "caching", 3),
		cutOf(ChapterKindMilestone, "m12", "", 4),
	}
	cs := ComputeChapters(chapterMsgs(16, nil), cuts, nil, chapterDefaults)
	if len(cs) != 4 {
		t.Fatalf("chapters = %+v", cs)
	}
	if cs[1].Title != "Decision day" || cs[1].TitleSource != ChapterTitleMilestone || cs[1].Kind != ChapterKindMilestone || cs[1].MilestoneID == "" {
		t.Fatalf("milestone chapter = %+v", cs[1])
	}
	if cs[2].Title != "caching" || cs[2].TitleSource != ChapterTitleTopic || cs[2].Kind != ChapterKindTopic {
		t.Fatalf("topic chapter = %+v", cs[2])
	}
	if cs[3].TitleSource != ChapterTitleTime || cs[3].Kind != ChapterKindMilestone {
		t.Fatalf("unnamed milestone = %+v", cs[3])
	}
}

func TestComputeChapters_CloseCutsMergeKeepingTheStrongerOne(t *testing.T) {
	cuts := []ChapterCut{
		cutOf(ChapterKindTopic, "m05", "topic", 1),
		cutOf(ChapterKindMilestone, "m06", "mile", 2),
		cutOf(ChapterKindTopic, "m07", "late topic", 3),
	}
	cs := ComputeChapters(chapterMsgs(12, nil), cuts, nil, chapterDefaults)
	if got := startIDs(cs); len(got) != 2 || got[1] != "m06" {
		t.Fatalf("starts = %v", got)
	}
	// A weaker cut next to the start of the line is dropped, a milestone is not.
	weak := ComputeChapters(chapterMsgs(10, nil), []ChapterCut{cutOf(ChapterKindTopic, "m01", "x", 1)}, nil, chapterDefaults)
	strong := ComputeChapters(chapterMsgs(10, nil), []ChapterCut{cutOf(ChapterKindMilestone, "m01", "x", 1)}, nil, chapterDefaults)
	if len(weak) != 1 || len(strong) != 2 {
		t.Fatalf("weak=%d strong=%d", len(weak), len(strong))
	}
}

func TestComputeChapters_CapMergesTheShortestNeighbours(t *testing.T) {
	n := (chapterDefaults.MaxCount + 5) * 4
	var cuts []ChapterCut
	for i := 4; i < n; i += 4 {
		cuts = append(cuts, cutOf(ChapterKindTopic, fmt.Sprintf("m%02d", i), "t", i))
	}
	msgs := chapterMsgs(n, nil)
	for i := range msgs {
		msgs[i].ID = fmt.Sprintf("m%02d", i)
	}
	cs := ComputeChapters(msgs, cuts, nil, chapterDefaults)
	if len(cs) != chapterDefaults.MaxCount {
		t.Fatalf("chapters = %d, want %d", len(cs), chapterDefaults.MaxCount)
	}
	total := 0
	for _, c := range cs {
		total += c.MessageCount
	}
	if total != n {
		t.Fatalf("messages covered = %d, want %d", total, n)
	}
}

func TestComputeChapters_BranchesAndCardsLandInTheirChapter(t *testing.T) {
	msgs := chapterMsgs(10, map[int]time.Duration{5: chapterDefaults.IdleGap})
	msgs[7].IsCard = true
	// A card brought back long after the conversation ended (e.g. B20 attach) does not start an idle chapter.
	msgs[9].IsCard = true
	msgs[9].At = msgs[8].At.Add(24 * time.Hour)
	branches := []ChapterBranch{{LineID: "b1", AnchorMessageID: "m02"}, {LineID: "b2", AnchorMessageID: "m05"}, {LineID: "gone", AnchorMessageID: "elsewhere"}}
	cs := ComputeChapters(msgs, nil, branches, chapterDefaults)
	if len(cs) != 2 || len(cs[0].BranchIDs) != 1 || cs[0].BranchIDs[0] != "b1" || len(cs[1].BranchIDs) != 1 || cs[1].BranchIDs[0] != "b2" {
		t.Fatalf("branches = %+v", cs)
	}
	if len(cs[0].CardMessageIDs) != 0 || len(cs[1].CardMessageIDs) != 2 || cs[1].CardMessageIDs[0] != "m07" || cs[1].CardMessageIDs[1] != "m09" {
		t.Fatalf("cards = %+v", cs)
	}
}

func TestComputeChapters_CutsOnMessagesOutsideTheLineAreIgnored(t *testing.T) {
	cs := ComputeChapters(chapterMsgs(10, nil), []ChapterCut{cutOf(ChapterKindMilestone, "moved-away", "x", 1)}, nil, chapterDefaults)
	if len(cs) != 1 {
		t.Fatalf("chapters = %+v", cs)
	}
}

func TestComputeChapters_OrdersBySeqNotBySliceOrTime(t *testing.T) {
	msgs := chapterMsgs(8, map[int]time.Duration{4: chapterDefaults.IdleGap})
	shuffled := []ChapterMessage{msgs[5], msgs[0], msgs[7], msgs[2], msgs[4], msgs[1], msgs[6], msgs[3]}
	got := ComputeChapters(shuffled, nil, nil, chapterDefaults)
	if starts := startIDs(got); len(starts) != 2 || starts[0] != "m00" || starts[1] != "m04" || got[1].EndMessageID != "m07" {
		t.Fatalf("starts = %v", starts)
	}
	// A moved message keeps its seq; equal timestamps cannot reorder it.
	same := chapterMsgs(5, nil)
	for i := range same {
		same[i].At = chapterBase
	}
	if cs := ComputeChapters([]ChapterMessage{same[4], same[3], same[2], same[1], same[0]}, nil, nil, chapterDefaults); cs[0].StartMessageID != "m00" || cs[0].EndMessageID != "m04" {
		t.Fatalf("equal timestamps = %+v", cs)
	}
}
