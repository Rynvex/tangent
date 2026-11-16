package domain

import (
	"errors"
	"fmt"
	"maps"
	"slices"
	"time"
)

// Limits holds every tunable bound of lines, branches, packs, notes, chapters
// and the prompt history. DefaultLimits returns the default values; a host
// may change them through the engine. A field that is zero (or negative)
// means its default, field by field.
type Limits struct {
	Branch   BranchLimits
	Pack     PackLimits
	Notes    NoteLimits
	Chapters ChapterLimits
	History  HistoryLimits
	Text     TextLimits
	// Leaf, Parking and Suggestions bound the P1 features (leaf, parking)
	// and the suggestion inbox.
	Leaf        LeafLimits
	Parking     ParkingLimits
	Suggestions SuggestionLimits
	Spinoff     SpinoffLimits
	Rebalance   RebalanceLimits
	// Goal, Relations and OpenLoops bound the P2 features (goal, relations,
	// open_loops).
	Goal      GoalLimits
	Relations RelationLimits
	OpenLoops OpenLoopLimits
	// Context is the prompt's shared token budget; Fisheye bounds the
	// fisheye history selection (B9 part B).
	Context ContextLimits
	Fisheye FisheyeLimits
	// Group bounds groups and combined branches (B9 part C).
	Group GroupLimits
	// Ibis and Fold bound the P3 features of B10 part A.
	Ibis IbisLimits
	Fold FoldLimits
	// Diverge bounds diverging and converging (B10 part B).
	Diverge DivergeLimits
	// Memory bounds memories and their recall (B10 part C).
	Memory MemoryLimits
	// Memo bounds the memos of a conversation (B13).
	Memo MemoLimits
	// Glossary bounds the glossary of a conversation (B24).
	Glossary GlossaryLimits
	// HistoryScan is how many messages of a line one turn reads when the
	// line has no rolling summary; past it, a summary is due.
	HistoryScan int
}

// BranchLimits bounds opening, moving and drafting branches.
type BranchLimits struct {
	// PurposeMaxRunes caps the purpose, which is also the branch's title.
	PurposeMaxRunes int
	// ExcerptMaxRunes caps the text the operator selected.
	ExcerptMaxRunes int
	// SoftMaxDepth is the depth beyond which opening a branch needs a second
	// confirmation (confirmDeeper).
	SoftMaxDepth int
	// HardMaxDepth is the deepest branch that can exist.
	HardMaxDepth int
	// MaxOpenPerParent caps the unfinished branches under one line.
	MaxOpenPerParent int
	// MaxPerTree caps every branch of one main line.
	MaxPerTree int
	// MoveMaxMessages caps how many tail messages one move takes.
	MoveMaxMessages int
	// NoticeMaxPerTurn caps the conclusion cards attached to one parent turn.
	NoticeMaxPerTurn int
	// DraftTimeout is how long a draft may stay "drafting" before it counts as failed.
	DraftTimeout time.Duration
	// AsideRetention is how long an ended aside is kept before it is purged.
	AsideRetention time.Duration
}

// PackLimits bounds the background pack of a new branch.
type PackLimits struct {
	// RecentMessages is how many main-line messages the pack quotes.
	RecentMessages int
	// AsideRecentMessages is the same for an aside (it needs less).
	AsideRecentMessages int
	// ExcerptRecentMessages caps how many messages are quoted whole when the
	// operator selected text to branch on (the selection already says what
	// the branch is about); the earlier ones become one-line digests.
	ExcerptRecentMessages int
	// TokenBudget bounds the whole pack.
	TokenBudget int
	// MessageTokenCap bounds one quoted message.
	MessageTokenCap int
	// HistoryScan is how many main-line messages the pack builder reads.
	HistoryScan int
	// LaterScan is how many main-line messages after the anchor the "later
	// developments" section reads.
	LaterScan int
	// LaterTokenBudget bounds the "later developments" section; it shrinks
	// first when the whole pack would exceed TokenBudget.
	LaterTokenBudget int
	// LaterRecentMessages is how many of the latest messages after the anchor
	// are quoted whole (the rest are one-line digests).
	LaterRecentMessages int
	// LaterMessageTokenCap bounds one quoted message of that section.
	LaterMessageTokenCap int
}

// NoteLimits bounds the conversation notes.
type NoteLimits struct {
	// TokenBudget bounds the notes block of one prompt.
	TokenBudget int
	// MaxRunes bounds the text of one note.
	MaxRunes int
	// MaxActive bounds the active notes of one conversation.
	MaxActive int
	// MaxTotal bounds all notes of a conversation, superseded ones included.
	MaxTotal int
	// MaxChangesPerMerge bounds the note changes of one merge.
	MaxChangesPerMerge int
}

// ChapterLimits bounds the chapter cut.
type ChapterLimits struct {
	// IdleGap is the pause between two neighbouring messages that opens a
	// new chapter.
	IdleGap time.Duration
	// MinMessages is the fewest messages a chapter keeps before a nearby
	// cut is folded into its neighbour.
	MinMessages int
	// MaxCount caps the chapters of one line; the shortest neighbours merge.
	MaxCount int
	// MilestoneMaxPerTree caps the milestones of one conversation.
	MilestoneMaxPerTree int
	// MilestoneTitleMaxRunes caps a milestone name.
	MilestoneTitleMaxRunes int
	// TopicTitleMaxRunes caps a stored topic title.
	TopicTitleMaxRunes int
	// MaxMessages bounds how many messages of a line are scanned.
	MaxMessages int
}

// HistoryLimits bounds the conversation history of a turn prompt and decides
// when a rolling summary is due.
type HistoryLimits struct {
	// TokenBudget bounds the verbatim history of a prompt.
	TokenBudget int
	// MessageTokenCap bounds one verbatim message in the prompt.
	MessageTokenCap int
	// SummaryTriggerTokens is the unsummarized token count after which a
	// rolling summary is due.
	SummaryTriggerTokens int
}

// TextLimits bounds the free text a caller sends (counted in runes).
type TextLimits struct {
	// TitleMaxRunes caps a line title.
	TitleMaxRunes int
	// ModelMaxRunes caps a provider or model name.
	ModelMaxRunes int
	// MessageMaxRunes caps the operator's message of a turn.
	MessageMaxRunes int
}

// LeafLimits bounds a branch's leaf (its closing note).
type LeafLimits struct {
	// LineMaxRunes caps the one-line leaf.
	LineMaxRunes int
	// BodyMaxRunes caps the optional detail.
	BodyMaxRunes int
}

// ParkingLimits bounds the parked thoughts (seeds) of a conversation.
type ParkingLimits struct {
	// TextMaxRunes caps the text of one seed.
	TextMaxRunes int
	// MaxOpenPerTree caps the open seeds of one conversation.
	MaxOpenPerTree int
}

// MemoLimits bounds the memos (not sent to the AI) of a conversation.
type MemoLimits struct {
	// TextMaxRunes caps the text of one memo.
	TextMaxRunes int
	// MaxPerTree caps the memos of one conversation.
	MaxPerTree int
}

// SuggestionLimits bounds the suggestion inbox.
type SuggestionLimits struct {
	// DismissCooldown is how long after a dismissal the same suggestion
	// (same feature, kind and target) is not raised again.
	DismissCooldown time.Duration
	// PayloadMaxBytes caps the payload a feature stores with a suggestion.
	PayloadMaxBytes int
}

// SpinoffLimits bounds spinning a conversation off.
type SpinoffLimits struct {
	// CapsuleTokenBudget bounds the origin capsule of a spun-off main line.
	CapsuleTokenBudget int
}

// RebalanceLimits are the thresholds of the rebalance hint.
type RebalanceLimits struct {
	// MinBranchTurns is the fewest finished replies a branch needs.
	MinBranchTurns int
	// ShareFactor: the branch's replies since the fork must be at least
	// this many times the parent's since then.
	ShareFactor int
	// RecentTurns: that many latest replies of the tree all in the branch
	// also make it due.
	RecentTurns int
}

// GoalLimits bound a conversation's goal and its drift check.
type GoalLimits struct {
	// TextMaxRunes caps the one-line goal.
	TextMaxRunes int
	// DriftEvery: the drift check runs after every that many replies of
	// the main line.
	DriftEvery int
}

// RelationLimits bound the relations drawn between places of a
// conversation.
type RelationLimits struct {
	// LabelMaxRunes caps the relation's label.
	LabelMaxRunes int
	// MaxPerTree caps the relations touching one conversation.
	MaxPerTree int
}

// OpenLoopLimits bound the open-loops listing.
type OpenLoopLimits struct {
	// StaleAfter: an open branch idle this long is an open loop.
	StaleAfter time.Duration
	// MaxPerKind caps the items listed of each kind (the totals are exact).
	MaxPerKind int
}

// ContextLimits is the token budget the blocks of one prompt share: the
// fixed blocks (pack, capsule, card notice), then the features' blocks in
// WithFeatures order and the host's sections; the history gets what is left
// (at most History.TokenBudget). The operator's message and the rules are
// not counted.
type ContextLimits struct {
	TokenBudget int
}

// FisheyeLimits shape the fisheye context. A message's score is its head
// start (pinned, referenced, a card) minus how many exchanges back it is; a
// branch's is its leaf's weight minus its distance in the tree.
type FisheyeLimits struct {
	// FullExchanges: messages scoring above −FullExchanges stay verbatim.
	FullExchanges int
	// SummaryExchanges: messages scoring above −SummaryExchanges are
	// condensed to one line; the rest are left out.
	SummaryExchanges int
	// BranchReach: branches scoring at least −BranchReach show their leaf.
	BranchReach int
	// MaxBranches caps the branch conclusions of one prompt.
	MaxBranches int
}

// GroupLimits bound the groups of a conversation and combining branches.
type GroupLimits struct {
	TitleMaxRunes    int
	SummaryMaxRunes  int
	MaxMembers       int
	MaxActivePerTree int
	// CombineTokenBudget bounds what a combined branch's pack carries from
	// the branches it combines.
	CombineTokenBudget int
}

func (l GroupLimits) orDefault() GroupLimits {
	d := DefaultLimits().Group
	return GroupLimits{
		TitleMaxRunes: positiveOr(l.TitleMaxRunes, d.TitleMaxRunes), SummaryMaxRunes: positiveOr(l.SummaryMaxRunes, d.SummaryMaxRunes),
		MaxMembers: positiveOr(l.MaxMembers, d.MaxMembers), MaxActivePerTree: positiveOr(l.MaxActivePerTree, d.MaxActivePerTree),
		CombineTokenBudget: positiveOr(l.CombineTokenBudget, d.CombineTokenBudget),
	}
}

func (l ContextLimits) orDefault() ContextLimits {
	return ContextLimits{TokenBudget: positiveOr(l.TokenBudget, DefaultLimits().Context.TokenBudget)}
}

func (l FisheyeLimits) orDefault() FisheyeLimits {
	d := DefaultLimits().Fisheye
	return FisheyeLimits{
		FullExchanges: positiveOr(l.FullExchanges, d.FullExchanges), SummaryExchanges: positiveOr(l.SummaryExchanges, d.SummaryExchanges),
		BranchReach: positiveOr(l.BranchReach, d.BranchReach), MaxBranches: positiveOr(l.MaxBranches, d.MaxBranches),
	}
}

func (l GoalLimits) orDefault() GoalLimits {
	d := DefaultLimits().Goal
	return GoalLimits{TextMaxRunes: positiveOr(l.TextMaxRunes, d.TextMaxRunes), DriftEvery: positiveOr(l.DriftEvery, d.DriftEvery)}
}

func (l RelationLimits) orDefault() RelationLimits {
	d := DefaultLimits().Relations
	return RelationLimits{LabelMaxRunes: positiveOr(l.LabelMaxRunes, d.LabelMaxRunes), MaxPerTree: positiveOr(l.MaxPerTree, d.MaxPerTree)}
}

func (l OpenLoopLimits) orDefault() OpenLoopLimits {
	d := DefaultLimits().OpenLoops
	return OpenLoopLimits{StaleAfter: positiveOr(l.StaleAfter, d.StaleAfter), MaxPerKind: positiveOr(l.MaxPerKind, d.MaxPerKind)}
}

func (l SpinoffLimits) orDefault() SpinoffLimits {
	return SpinoffLimits{CapsuleTokenBudget: positiveOr(l.CapsuleTokenBudget, DefaultLimits().Spinoff.CapsuleTokenBudget)}
}

func (l RebalanceLimits) orDefault() RebalanceLimits {
	d := DefaultLimits().Rebalance
	return RebalanceLimits{
		MinBranchTurns: positiveOr(l.MinBranchTurns, d.MinBranchTurns), ShareFactor: positiveOr(l.ShareFactor, d.ShareFactor),
		RecentTurns: positiveOr(l.RecentTurns, d.RecentTurns),
	}
}

func (l LeafLimits) orDefault() LeafLimits {
	d := DefaultLimits().Leaf
	return LeafLimits{LineMaxRunes: positiveOr(l.LineMaxRunes, d.LineMaxRunes), BodyMaxRunes: positiveOr(l.BodyMaxRunes, d.BodyMaxRunes)}
}

func (l ParkingLimits) orDefault() ParkingLimits {
	d := DefaultLimits().Parking
	return ParkingLimits{TextMaxRunes: positiveOr(l.TextMaxRunes, d.TextMaxRunes), MaxOpenPerTree: positiveOr(l.MaxOpenPerTree, d.MaxOpenPerTree)}
}

func (l MemoLimits) orDefault() MemoLimits {
	d := DefaultLimits().Memo
	return MemoLimits{TextMaxRunes: positiveOr(l.TextMaxRunes, d.TextMaxRunes), MaxPerTree: positiveOr(l.MaxPerTree, d.MaxPerTree)}
}

func (l SuggestionLimits) orDefault() SuggestionLimits {
	d := DefaultLimits().Suggestions
	return SuggestionLimits{DismissCooldown: positiveOr(l.DismissCooldown, d.DismissCooldown), PayloadMaxBytes: positiveOr(l.PayloadMaxBytes, d.PayloadMaxBytes)}
}

func (l TextLimits) orDefault() TextLimits {
	d := DefaultLimits().Text
	return TextLimits{
		TitleMaxRunes: positiveOr(l.TitleMaxRunes, d.TitleMaxRunes), ModelMaxRunes: positiveOr(l.ModelMaxRunes, d.ModelMaxRunes),
		MessageMaxRunes: positiveOr(l.MessageMaxRunes, d.MessageMaxRunes),
	}
}

// DefaultLimits returns the default limits.
func DefaultLimits() Limits {
	return Limits{
		Branch: BranchLimits{
			PurposeMaxRunes: 200, ExcerptMaxRunes: 1500, SoftMaxDepth: 3, HardMaxDepth: 6,
			MaxOpenPerParent: 8, MaxPerTree: 200, MoveMaxMessages: 40, NoticeMaxPerTurn: 10,
			DraftTimeout: 3 * time.Minute, AsideRetention: 7 * 24 * time.Hour,
		},
		Pack: PackLimits{
			RecentMessages: 8, AsideRecentMessages: 4, ExcerptRecentMessages: 3, TokenBudget: 6000, MessageTokenCap: 1500,
			HistoryScan: 200, LaterScan: 100, LaterTokenBudget: 1800, LaterRecentMessages: 3, LaterMessageTokenCap: 500,
		},
		Notes: NoteLimits{TokenBudget: 2000, MaxRunes: 400, MaxActive: 200, MaxTotal: 1000, MaxChangesPerMerge: 10},
		Chapters: ChapterLimits{
			IdleGap: 30 * time.Minute, MinMessages: 3, MaxCount: 60, MilestoneMaxPerTree: 200,
			MilestoneTitleMaxRunes: 80, TopicTitleMaxRunes: 120, MaxMessages: 20000,
		},
		History:     HistoryLimits{TokenBudget: 24000, MessageTokenCap: 4000, SummaryTriggerTokens: 16000},
		Text:        TextLimits{TitleMaxRunes: 200, ModelMaxRunes: 100, MessageMaxRunes: 32000},
		Leaf:        LeafLimits{LineMaxRunes: 200, BodyMaxRunes: 4000},
		Parking:     ParkingLimits{TextMaxRunes: 500, MaxOpenPerTree: 100},
		Memo:        MemoLimits{TextMaxRunes: 4000, MaxPerTree: 500},
		Glossary:    GlossaryLimits{TermMaxRunes: 60, ExplanationMaxRunes: 1000, MaxPerTree: 300, TokenBudget: 300},
		Suggestions: SuggestionLimits{DismissCooldown: 7 * 24 * time.Hour, PayloadMaxBytes: 4096},
		Spinoff:     SpinoffLimits{CapsuleTokenBudget: 6000},
		Rebalance:   RebalanceLimits{MinBranchTurns: 6, ShareFactor: 2, RecentTurns: 5},
		Goal:        GoalLimits{TextMaxRunes: 300, DriftEvery: 4},
		Relations:   RelationLimits{LabelMaxRunes: 200, MaxPerTree: 200},
		OpenLoops:   OpenLoopLimits{StaleAfter: 72 * time.Hour, MaxPerKind: 50},
		Context:     ContextLimits{TokenBudget: 40000},
		Fisheye:     FisheyeLimits{FullExchanges: 4, SummaryExchanges: 20, BranchReach: 3, MaxBranches: 20},
		Group:       GroupLimits{TitleMaxRunes: 120, SummaryMaxRunes: 1000, MaxMembers: 12, MaxActivePerTree: 50, CombineTokenBudget: 4000},
		Ibis:        defaultIbisLimits,
		Fold:        defaultFoldLimits,
		Diverge:     defaultDivergeLimits,
		Memory:      defaultMemoryLimits,
		HistoryScan: 200,
	}
}

// WithDefaults replaces every field that is not positive with its default.
func (l Limits) WithDefaults() Limits {
	return Limits{
		Branch: l.Branch.orDefault(), Pack: l.Pack.orDefault(), Notes: l.Notes.orDefault(),
		Chapters: l.Chapters.orDefault(), History: l.History.orDefault(), Text: l.Text.orDefault(),
		Leaf: l.Leaf.orDefault(), Parking: l.Parking.orDefault(), Memo: l.Memo.orDefault(), Suggestions: l.Suggestions.orDefault(),
		Glossary: l.Glossary.orDefault(),
		Spinoff:  l.Spinoff.orDefault(), Rebalance: l.Rebalance.orDefault(),
		Goal: l.Goal.orDefault(), Relations: l.Relations.orDefault(), OpenLoops: l.OpenLoops.orDefault(),
		Context: l.Context.orDefault(), Fisheye: l.Fisheye.orDefault(), Group: l.Group.orDefault(),
		Ibis: l.Ibis.orDefault(), Fold: l.Fold.orDefault(), Diverge: l.Diverge.orDefault(), Memory: l.Memory.orDefault(),
		HistoryScan: positiveOr(l.HistoryScan, DefaultLimits().HistoryScan),
	}
}

// positiveOr returns v when it is positive and def otherwise. Every limit is
// defaulted field by field, so a partly filled struct can never carry a zero
// bound into the code that relies on it.
func positiveOr[T int | time.Duration](v, def T) T {
	if v > 0 {
		return v
	}
	return def
}

func (l BranchLimits) orDefault() BranchLimits {
	d := DefaultLimits().Branch
	return BranchLimits{
		PurposeMaxRunes: positiveOr(l.PurposeMaxRunes, d.PurposeMaxRunes), ExcerptMaxRunes: positiveOr(l.ExcerptMaxRunes, d.ExcerptMaxRunes),
		SoftMaxDepth: positiveOr(l.SoftMaxDepth, d.SoftMaxDepth), HardMaxDepth: positiveOr(l.HardMaxDepth, d.HardMaxDepth),
		MaxOpenPerParent: positiveOr(l.MaxOpenPerParent, d.MaxOpenPerParent), MaxPerTree: positiveOr(l.MaxPerTree, d.MaxPerTree),
		MoveMaxMessages: positiveOr(l.MoveMaxMessages, d.MoveMaxMessages), NoticeMaxPerTurn: positiveOr(l.NoticeMaxPerTurn, d.NoticeMaxPerTurn),
		DraftTimeout: positiveOr(l.DraftTimeout, d.DraftTimeout), AsideRetention: positiveOr(l.AsideRetention, d.AsideRetention),
	}
}

func (l PackLimits) orDefault() PackLimits {
	d := DefaultLimits().Pack
	return PackLimits{
		RecentMessages: positiveOr(l.RecentMessages, d.RecentMessages), AsideRecentMessages: positiveOr(l.AsideRecentMessages, d.AsideRecentMessages),
		ExcerptRecentMessages: positiveOr(l.ExcerptRecentMessages, d.ExcerptRecentMessages), TokenBudget: positiveOr(l.TokenBudget, d.TokenBudget),
		MessageTokenCap: positiveOr(l.MessageTokenCap, d.MessageTokenCap), HistoryScan: positiveOr(l.HistoryScan, d.HistoryScan),
		LaterScan: positiveOr(l.LaterScan, d.LaterScan), LaterTokenBudget: positiveOr(l.LaterTokenBudget, d.LaterTokenBudget), LaterRecentMessages: positiveOr(l.LaterRecentMessages, d.LaterRecentMessages),
		LaterMessageTokenCap: positiveOr(l.LaterMessageTokenCap, d.LaterMessageTokenCap),
	}
}

func (l NoteLimits) orDefault() NoteLimits {
	d := DefaultLimits().Notes
	return NoteLimits{
		TokenBudget: positiveOr(l.TokenBudget, d.TokenBudget), MaxRunes: positiveOr(l.MaxRunes, d.MaxRunes),
		MaxActive: positiveOr(l.MaxActive, d.MaxActive), MaxTotal: positiveOr(l.MaxTotal, d.MaxTotal),
		MaxChangesPerMerge: positiveOr(l.MaxChangesPerMerge, d.MaxChangesPerMerge),
	}
}

func (l ChapterLimits) orDefault() ChapterLimits {
	d := DefaultLimits().Chapters
	return ChapterLimits{
		IdleGap: positiveOr(l.IdleGap, d.IdleGap), MinMessages: positiveOr(l.MinMessages, d.MinMessages),
		MaxCount: positiveOr(l.MaxCount, d.MaxCount), MilestoneMaxPerTree: positiveOr(l.MilestoneMaxPerTree, d.MilestoneMaxPerTree),
		MilestoneTitleMaxRunes: positiveOr(l.MilestoneTitleMaxRunes, d.MilestoneTitleMaxRunes),
		TopicTitleMaxRunes:     positiveOr(l.TopicTitleMaxRunes, d.TopicTitleMaxRunes), MaxMessages: positiveOr(l.MaxMessages, d.MaxMessages),
	}
}

func (l HistoryLimits) orDefault() HistoryLimits {
	d := DefaultLimits().History
	return HistoryLimits{
		TokenBudget: positiveOr(l.TokenBudget, d.TokenBudget), MessageTokenCap: positiveOr(l.MessageTokenCap, d.MessageTokenCap),
		SummaryTriggerTokens: positiveOr(l.SummaryTriggerTokens, d.SummaryTriggerTokens),
	}
}

// Validate reports the first limit that cannot work: a negative bound (zero
// means the default), or a soft depth beyond the hard one once defaults are
// applied. Code that uses limits never fails on them either way: every
// field that is not positive is replaced by its default at use.
func (l Limits) Validate() error {
	fields := l.fields()
	for _, name := range slices.Sorted(maps.Keys(fields)) {
		if fields[name] < 0 {
			return fmt.Errorf("limit %s must not be negative", name)
		}
	}
	filled := l.WithDefaults()
	if filled.Branch.SoftMaxDepth > filled.Branch.HardMaxDepth {
		return errors.New("limit Branch.SoftMaxDepth must not exceed Branch.HardMaxDepth")
	}
	return nil
}

// fields lists every limit by name, durations in nanoseconds.
func (l Limits) fields() map[string]int64 {
	return map[string]int64{
		"Branch.PurposeMaxRunes": int64(l.Branch.PurposeMaxRunes), "Branch.ExcerptMaxRunes": int64(l.Branch.ExcerptMaxRunes),
		"Branch.SoftMaxDepth": int64(l.Branch.SoftMaxDepth), "Branch.HardMaxDepth": int64(l.Branch.HardMaxDepth),
		"Branch.MaxOpenPerParent": int64(l.Branch.MaxOpenPerParent), "Branch.MaxPerTree": int64(l.Branch.MaxPerTree),
		"Branch.MoveMaxMessages": int64(l.Branch.MoveMaxMessages), "Branch.NoticeMaxPerTurn": int64(l.Branch.NoticeMaxPerTurn),
		"Branch.DraftTimeout": int64(l.Branch.DraftTimeout), "Branch.AsideRetention": int64(l.Branch.AsideRetention),
		"Pack.RecentMessages": int64(l.Pack.RecentMessages), "Pack.AsideRecentMessages": int64(l.Pack.AsideRecentMessages),
		"Pack.ExcerptRecentMessages": int64(l.Pack.ExcerptRecentMessages), "Pack.TokenBudget": int64(l.Pack.TokenBudget),
		"Pack.MessageTokenCap": int64(l.Pack.MessageTokenCap), "Pack.HistoryScan": int64(l.Pack.HistoryScan),
		"Pack.LaterScan":        int64(l.Pack.LaterScan),
		"Pack.LaterTokenBudget": int64(l.Pack.LaterTokenBudget), "Pack.LaterRecentMessages": int64(l.Pack.LaterRecentMessages),
		"Pack.LaterMessageTokenCap": int64(l.Pack.LaterMessageTokenCap),
		"Notes.TokenBudget":         int64(l.Notes.TokenBudget), "Notes.MaxRunes": int64(l.Notes.MaxRunes),
		"Notes.MaxActive": int64(l.Notes.MaxActive), "Notes.MaxTotal": int64(l.Notes.MaxTotal),
		"Notes.MaxChangesPerMerge": int64(l.Notes.MaxChangesPerMerge),
		"Chapters.IdleGap":         int64(l.Chapters.IdleGap), "Chapters.MinMessages": int64(l.Chapters.MinMessages),
		"Chapters.MaxCount": int64(l.Chapters.MaxCount), "Chapters.MilestoneMaxPerTree": int64(l.Chapters.MilestoneMaxPerTree),
		"Chapters.MilestoneTitleMaxRunes": int64(l.Chapters.MilestoneTitleMaxRunes), "Chapters.TopicTitleMaxRunes": int64(l.Chapters.TopicTitleMaxRunes),
		"Chapters.MaxMessages": int64(l.Chapters.MaxMessages),
		"History.TokenBudget":  int64(l.History.TokenBudget), "History.MessageTokenCap": int64(l.History.MessageTokenCap),
		"History.SummaryTriggerTokens": int64(l.History.SummaryTriggerTokens),
		"HistoryScan":                  int64(l.HistoryScan),
		"Text.TitleMaxRunes":           int64(l.Text.TitleMaxRunes), "Text.ModelMaxRunes": int64(l.Text.ModelMaxRunes),
		"Text.MessageMaxRunes": int64(l.Text.MessageMaxRunes),
		"Leaf.LineMaxRunes":    int64(l.Leaf.LineMaxRunes), "Leaf.BodyMaxRunes": int64(l.Leaf.BodyMaxRunes),
		"Parking.TextMaxRunes": int64(l.Parking.TextMaxRunes), "Parking.MaxOpenPerTree": int64(l.Parking.MaxOpenPerTree),
		"Memo.TextMaxRunes": int64(l.Memo.TextMaxRunes), "Memo.MaxPerTree": int64(l.Memo.MaxPerTree),
		"Glossary.TermMaxRunes": int64(l.Glossary.TermMaxRunes), "Glossary.ExplanationMaxRunes": int64(l.Glossary.ExplanationMaxRunes),
		"Glossary.MaxPerTree": int64(l.Glossary.MaxPerTree), "Glossary.TokenBudget": int64(l.Glossary.TokenBudget),
		"Suggestions.DismissCooldown": int64(l.Suggestions.DismissCooldown), "Suggestions.PayloadMaxBytes": int64(l.Suggestions.PayloadMaxBytes),
		"Spinoff.CapsuleTokenBudget": int64(l.Spinoff.CapsuleTokenBudget), "Rebalance.MinBranchTurns": int64(l.Rebalance.MinBranchTurns),
		"Rebalance.ShareFactor": int64(l.Rebalance.ShareFactor), "Rebalance.RecentTurns": int64(l.Rebalance.RecentTurns),
		"Goal.TextMaxRunes": int64(l.Goal.TextMaxRunes), "Goal.DriftEvery": int64(l.Goal.DriftEvery),
		"Relations.LabelMaxRunes": int64(l.Relations.LabelMaxRunes), "Relations.MaxPerTree": int64(l.Relations.MaxPerTree),
		"OpenLoops.StaleAfter": int64(l.OpenLoops.StaleAfter), "OpenLoops.MaxPerKind": int64(l.OpenLoops.MaxPerKind),
		"Context.TokenBudget": int64(l.Context.TokenBudget), "Fisheye.FullExchanges": int64(l.Fisheye.FullExchanges),
		"Fisheye.SummaryExchanges": int64(l.Fisheye.SummaryExchanges), "Fisheye.BranchReach": int64(l.Fisheye.BranchReach),
		"Fisheye.MaxBranches": int64(l.Fisheye.MaxBranches),
		"Group.TitleMaxRunes": int64(l.Group.TitleMaxRunes), "Group.SummaryMaxRunes": int64(l.Group.SummaryMaxRunes),
		"Group.MaxMembers": int64(l.Group.MaxMembers), "Group.MaxActivePerTree": int64(l.Group.MaxActivePerTree),
		"Group.CombineTokenBudget": int64(l.Group.CombineTokenBudget),
	}
}
