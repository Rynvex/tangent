package tangent

import "github.com/Rynvex/tangent/domain"

// The shared prompt budget (DESIGN §12 B3 phase 2, built in B9): one
// Limits.Context.TokenBudget for a prompt's blocks. The fixed blocks (pack,
// origin capsule, card notice) take their share first ("core"), then each
// ContextProvider in WithFeatures order (a provider may read what is left,
// as notes does), then the host's sections ("host"); the history (the
// default choice or the HistorySelector) gets what remains, at most
// Limits.History.TokenBudget. The rules and the operator's message are not
// counted. Shares are measured, not requested: the engine estimates the
// prompt input before and after each provider.

// BudgetShare is what one owner (core, a feature, host, history) took.
type BudgetShare struct {
	Owner  string `json:"owner"`
	Tokens int    `json:"tokens"`
}

// PromptBudget is how a prompt's budget was shared: Total is the budget,
// Shares what each owner took in order (the history last), History what the
// history was granted and Used the sum of the shares.
type PromptBudget struct {
	Total   int           `json:"total"`
	Shares  []BudgetShare `json:"shares"`
	History int           `json:"history"`
	Used    int           `json:"used"`
}

// Budget owners besides the features.
const (
	BudgetCore    = "core"
	BudgetHost    = "host"
	BudgetHistory = "history"
)

// contextBudget is one prompt's budget while it is assembled.
type contextBudget struct {
	report PromptBudget
}

func newContextBudget(total int) *contextBudget {
	return &contextBudget{report: PromptBudget{Total: total, Shares: []BudgetShare{}}}
}

// spend records an owner's share (nothing for 0).
func (b *contextBudget) spend(owner string, tokens int) {
	if b == nil || tokens <= 0 {
		return
	}
	b.report.Shares = append(b.report.Shares, BudgetShare{Owner: owner, Tokens: tokens})
	b.report.Used += tokens
}

// remaining is what is left (never below 0).
func (b *contextBudget) remaining() int {
	if b == nil {
		return 0
	}
	return max(b.report.Total-b.report.Used, 0)
}

// measured runs fn and records the growth of the prompt input as owner's
// share.
func (b *contextBudget) measured(owner string, in *domain.PromptInput, fn func() error) error {
	before := domain.EstimateInputTokens(*in)
	err := fn()
	b.spend(owner, domain.EstimateInputTokens(*in)-before)
	return err
}

// grantHistory is what the history may take: what is left, at most
// historyMax.
func (b *contextBudget) grantHistory(historyMax int) int {
	b.report.History = min(b.remaining(), historyMax)
	return b.report.History
}
