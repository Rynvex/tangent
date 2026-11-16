package domain

// IbisLimits bound the ibis feature's tagging jobs.
type IbisLimits struct {
	// BatchMax caps the messages one ibis_tag job tags.
	BatchMax int
	// MessageRunes caps each message as the job quotes it.
	MessageRunes int
	// Every: Suggest and Auto tag a line every this many replies.
	Every int
}

// FoldLimits bound the folds of a line and the fold feature's jobs.
type FoldLimits struct {
	// SummaryMaxRunes caps a fold's summary.
	SummaryMaxRunes int
	// MinMessages and MaxMessages bound the messages one fold covers.
	MinMessages int
	MaxMessages int
	// MaxActivePerLine caps the folds (drafting or active) of one line.
	MaxActivePerLine int
	// SuggestEvery: Suggest looks for a chapter to fold every this many
	// replies of a line.
	SuggestEvery int
	// SuggestMinMessages and SuggestMinTokens: a chapter worth proposing
	// has at least this many messages and tokens.
	SuggestMinMessages int
	SuggestMinTokens   int
	// PromptTokenBudget bounds the messages a summary job quotes.
	PromptTokenBudget int
}

func (l IbisLimits) orDefault() IbisLimits {
	d := DefaultLimits().Ibis
	return IbisLimits{BatchMax: positiveOr(l.BatchMax, d.BatchMax), MessageRunes: positiveOr(l.MessageRunes, d.MessageRunes), Every: positiveOr(l.Every, d.Every)}
}

func (l FoldLimits) orDefault() FoldLimits {
	d := DefaultLimits().Fold
	return FoldLimits{
		SummaryMaxRunes: positiveOr(l.SummaryMaxRunes, d.SummaryMaxRunes), MinMessages: positiveOr(l.MinMessages, d.MinMessages),
		MaxMessages: positiveOr(l.MaxMessages, d.MaxMessages), MaxActivePerLine: positiveOr(l.MaxActivePerLine, d.MaxActivePerLine),
		SuggestEvery: positiveOr(l.SuggestEvery, d.SuggestEvery), SuggestMinMessages: positiveOr(l.SuggestMinMessages, d.SuggestMinMessages),
		SuggestMinTokens: positiveOr(l.SuggestMinTokens, d.SuggestMinTokens), PromptTokenBudget: positiveOr(l.PromptTokenBudget, d.PromptTokenBudget),
	}
}

// defaultIbisLimits and defaultFoldLimits are DefaultLimits' values.
var (
	defaultIbisLimits = IbisLimits{BatchMax: 12, MessageRunes: 800, Every: 3}
	defaultFoldLimits = FoldLimits{
		SummaryMaxRunes: 1000, MinMessages: 2, MaxMessages: 200, MaxActivePerLine: 50,
		SuggestEvery: 10, SuggestMinMessages: 8, SuggestMinTokens: 1000, PromptTokenBudget: 12000,
	}
)

// DivergeLimits bound diverging (the directions one job proposes) and
// converging (the options and criteria of a comparison).
type DivergeLimits struct {
	// MinCount and MaxCount bound the directions of one diverge and the
	// options of one comparison.
	MinCount int
	MaxCount int
	// ContextMessages is how many messages up to the anchor a diverge job
	// reads, and of each option a converge job reads.
	ContextMessages int
	// CriteriaMax and CriterionMaxRunes bound a comparison's criteria.
	CriteriaMax       int
	CriterionMaxRunes int
	// ReasonMaxRunes caps a score's reason and the recommendation's.
	ReasonMaxRunes int
}

func (l DivergeLimits) orDefault() DivergeLimits {
	d := defaultDivergeLimits
	return DivergeLimits{
		MinCount: positiveOr(l.MinCount, d.MinCount), MaxCount: positiveOr(l.MaxCount, d.MaxCount), ContextMessages: positiveOr(l.ContextMessages, d.ContextMessages),
		CriteriaMax: positiveOr(l.CriteriaMax, d.CriteriaMax), CriterionMaxRunes: positiveOr(l.CriterionMaxRunes, d.CriterionMaxRunes),
		ReasonMaxRunes: positiveOr(l.ReasonMaxRunes, d.ReasonMaxRunes),
	}
}

var defaultDivergeLimits = DivergeLimits{MinCount: 2, MaxCount: 5, ContextMessages: 8, CriteriaMax: 6, CriterionMaxRunes: 120, ReasonMaxRunes: 300}
