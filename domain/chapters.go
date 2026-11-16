package domain

import (
	"cmp"
	"slices"
	"sort"
	"strings"
	"time"
)

// Chapters: a conversation line is cut into chapters at idle gaps, at the
// topic cuts the rolling summaries record and at operator milestones.
// Everything here is pure; the store feeds it the line's messages, which are
// ordered by seq here whatever order they arrive in.

// Cut kinds, in priority order (a higher one wins when cuts sit close together).
const (
	ChapterKindStart     = "start"
	ChapterKindIdle      = "idle"
	ChapterKindTopic     = "topic"
	ChapterKindMilestone = "milestone"
)

// Where a chapter title came from.
const (
	ChapterTitleMilestone = "milestone"
	ChapterTitleTopic     = "topic"
	ChapterTitleTime      = "time"
)

// Errors of milestones.
var (
	ErrChapterMilestoneNotFound = NewError(CodeMilestoneNotFound, "milestone not found", nil)
	ErrChapterMilestoneExists   = NewError(CodeMilestoneExists, "this message already has a milestone", nil)
	ErrChapterMilestoneLimit    = NewError(CodeMilestoneLimit, "this conversation has reached its limit of milestones", nil)
	ErrChapterMessageNotFound   = NewError(CodeMessageNotFound, "message not found in this conversation", nil)
	ErrChapterTitleInvalid      = NewError(CodeInvalidMilestone, "the milestone name is too long", nil)
)

// ChapterMessage is the part of a message the chapter cut needs.
type ChapterMessage struct {
	ID     string
	Seq    int64
	At     time.Time
	IsCard bool
}

// ChapterCut is a stored topic cut or milestone.
type ChapterCut struct {
	ID        string    `json:"id"`
	MessageID string    `json:"messageId"`
	Kind      string    `json:"kind"`
	Title     string    `json:"title"`
	CreatedBy string    `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
}

// ChapterBranch is a branch hanging off a message of the line.
type ChapterBranch struct {
	LineID          string
	AnchorMessageID string
}

// Chapter is one stretch of a line.
type Chapter struct {
	Index          int       `json:"index"`
	Title          string    `json:"title"`
	TitleSource    string    `json:"titleSource"`
	Kind           string    `json:"kind"`
	MilestoneID    string    `json:"milestoneId"`
	StartMessageID string    `json:"startMessageId"`
	EndMessageID   string    `json:"endMessageId"`
	StartAt        time.Time `json:"startAt"`
	EndAt          time.Time `json:"endAt"`
	MessageCount   int       `json:"messageCount"`
	BranchIDs      []string  `json:"branchIds"`
	CardMessageIDs []string  `json:"cardMessageIds"`
}

type chapterBoundary struct {
	index     int
	kind      string
	milestone *ChapterCut
	topic     string
}

func chapterRank(kind string) int {
	switch kind {
	case ChapterKindMilestone:
		return 3
	case ChapterKindTopic:
		return 2
	case ChapterKindIdle:
		return 1
	}
	return 0
}

// ComputeChapters cuts the messages (ordered by seq here) into chapters. Cuts
// whose message is not in the line are ignored.
func ComputeChapters(messages []ChapterMessage, cuts []ChapterCut, branches []ChapterBranch, l ChapterLimits) []Chapter {
	if len(messages) == 0 {
		return []Chapter{}
	}
	l = l.orDefault()
	ordered := slices.Clone(messages)
	slices.SortStableFunc(ordered, func(a, b ChapterMessage) int { return cmp.Compare(a.Seq, b.Seq) })
	position := make(map[string]int, len(ordered))
	for i, m := range ordered {
		position[m.ID] = i
	}
	bounds := foldCloseBoundaries(collectBoundaries(ordered, position, cuts, l.IdleGap), l.MinMessages)
	bounds = capBoundaries(bounds, len(ordered), l.MaxCount)
	return buildChapters(ordered, position, bounds, branches)
}

// collectBoundaries gathers every candidate cut, one per message index, sorted.
// Index 0 always exists as the start of the line.
func collectBoundaries(messages []ChapterMessage, position map[string]int, cuts []ChapterCut, idleGap time.Duration) []chapterBoundary {
	byIndex := map[int]*chapterBoundary{0: {index: 0, kind: ChapterKindStart}}
	at := func(i int) *chapterBoundary {
		if b, ok := byIndex[i]; ok {
			return b
		}
		b := &chapterBoundary{index: i}
		byIndex[i] = b
		return b
	}
	for i := 1; i < len(messages); i++ {
		// A conclusion card brought back later (a merge or B20's attach) does not open an idle chapter of its own.
		if !messages[i].IsCard && messages[i].At.Sub(messages[i-1].At) > idleGap {
			at(i).kind = ChapterKindIdle
		}
	}
	// Oldest cut first, so a later duplicate on the same message wins the title.
	ordered := append([]ChapterCut(nil), cuts...)
	sort.SliceStable(ordered, func(a, b int) bool { return ordered[a].CreatedAt.Before(ordered[b].CreatedAt) })
	for _, cut := range ordered {
		i, ok := position[cut.MessageID]
		if !ok {
			continue
		}
		b := at(i)
		cutCopy := cut
		switch cut.Kind {
		case ChapterKindMilestone:
			b.milestone = &cutCopy
			b.kind = ChapterKindMilestone
		case ChapterKindTopic:
			b.topic = cut.Title
			if chapterRank(b.kind) < chapterRank(ChapterKindTopic) {
				b.kind = ChapterKindTopic
			}
		}
	}
	out := make([]chapterBoundary, 0, len(byIndex))
	for _, b := range byIndex {
		out = append(out, *b)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].index < out[b].index })
	return out
}

// foldCloseBoundaries keeps one cut where two sit closer than minMessages:
// the higher-priority one, and the earlier on a tie. A milestone always
// survives next to the start of the line.
func foldCloseBoundaries(in []chapterBoundary, minMessages int) []chapterBoundary {
	kept := make([]chapterBoundary, 0, len(in))
	for _, b := range in {
		kept = pushBoundary(kept, b, minMessages)
	}
	return kept
}

func pushBoundary(kept []chapterBoundary, b chapterBoundary, minMessages int) []chapterBoundary {
	for len(kept) > 0 && b.index-kept[len(kept)-1].index < minMessages {
		top := kept[len(kept)-1]
		if top.index == 0 {
			if b.kind == ChapterKindMilestone {
				break
			}
			return kept
		}
		if chapterRank(b.kind) <= chapterRank(top.kind) {
			return kept
		}
		kept = kept[:len(kept)-1]
	}
	return append(kept, b)
}

// capBoundaries merges the shortest chapter into its neighbour until the line
// has at most maxCount chapters.
func capBoundaries(bounds []chapterBoundary, total, maxCount int) []chapterBoundary {
	for len(bounds) > maxCount {
		shortest, shortestLen := 0, total+1
		for j := range bounds {
			end := total
			if j+1 < len(bounds) {
				end = bounds[j+1].index
			}
			if length := end - bounds[j].index; length < shortestLen {
				shortest, shortestLen = j, length
			}
		}
		drop := shortest
		if drop == 0 {
			drop = 1
		}
		bounds = append(append([]chapterBoundary(nil), bounds[:drop]...), bounds[drop+1:]...)
	}
	return bounds
}

func buildChapters(messages []ChapterMessage, position map[string]int, bounds []chapterBoundary, branches []ChapterBranch) []Chapter {
	chapters := make([]Chapter, len(bounds))
	for j, b := range bounds {
		end := len(messages)
		if j+1 < len(bounds) {
			end = bounds[j+1].index
		}
		first, last := messages[b.index], messages[end-1]
		chapter := Chapter{
			Index: j, Kind: b.kind, StartMessageID: first.ID, EndMessageID: last.ID,
			StartAt: first.At.UTC(), EndAt: last.At.UTC(),
			MessageCount: end - b.index, BranchIDs: []string{}, CardMessageIDs: []string{},
		}
		chapter.Title, chapter.TitleSource = chapterTitle(b, first.At)
		if b.milestone != nil {
			chapter.MilestoneID = b.milestone.ID
		}
		for _, m := range messages[b.index:end] {
			if m.IsCard {
				chapter.CardMessageIDs = append(chapter.CardMessageIDs, m.ID)
			}
		}
		chapters[j] = chapter
	}
	for _, branch := range branches {
		i, ok := position[branch.AnchorMessageID]
		if !ok {
			continue
		}
		j := sort.Search(len(bounds), func(k int) bool { return bounds[k].index > i }) - 1
		chapters[j].BranchIDs = append(chapters[j].BranchIDs, branch.LineID)
	}
	return chapters
}

// chapterTitle prefers the milestone name, then the topic, then the time of the
// chapter's first message (UTC, "2006-01-02 15:04").
func chapterTitle(b chapterBoundary, start time.Time) (string, string) {
	if b.milestone != nil && strings.TrimSpace(b.milestone.Title) != "" {
		return b.milestone.Title, ChapterTitleMilestone
	}
	if strings.TrimSpace(b.topic) != "" {
		return b.topic, ChapterTitleTopic
	}
	return start.UTC().Format("2006-01-02 15:04"), ChapterTitleTime
}
