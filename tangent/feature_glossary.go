package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// FeatureGlossary is the glossary feature's name.
const FeatureGlossary = "glossary"

// Glossary keeps one "term → explanation" list per conversation (DESIGN
// §12.10, B24) and lists the tenant's terms across conversations. Only the
// terms reach the AI: a ContextProvider adds a trailing block to every
// prompt of the conversation (after the recalled memories, before the
// reply-line rules), within Limits.Glossary.TokenBudget of the shared
// budget, keeping the most recently updated terms; the explanations are in
// no prompt, preview or job. Saving a term from an aside keeps the aside
// (B23). No AI: on or off. Off: the glossary calls return
// feature_disabled, prompts carry no block; stored terms are kept.
func Glossary() Feature { return onOff(FeatureGlossary, registerGlossary) }

func registerGlossary(r *registry, _ *module) {
	r.addContextProvider(glossaryContext)
}

// glossaryContext adds the conversation's terms to the trailing block.
func glossaryContext(ctx context.Context, e *Engine, _ Mode, pc *promptContext) error {
	names, err := e.store.RecentTermNames(ctx, rootOfView(pc.line), e.limits.Glossary.MaxPerTree)
	if err != nil {
		return err
	}
	pc.in.GlossaryBlock = domain.BuildGlossaryBlock(names, min(e.limits.Glossary.TokenBudget, pc.budget.remaining()), e.markers)
	return nil
}

// Changes reported by terms.changed.
const (
	TermCreated = store.TermCreated
	TermUpdated = store.TermUpdated
	TermDeleted = store.TermDeleted
)

// TermsChange is the data of terms.changed.
type TermsChange struct {
	RootLineID string `json:"rootLineId"`
	TermID     string `json:"termId"`
	Change     string `json:"change"`
}

// TermChange is what a glossary write did (store.TermChange): the term,
// the change and the aside a save kept.
type TermChange = store.TermChange

// TermList is a conversation's glossary in key order.
type TermList = store.TermList

// TermQuery searches the tenant's terms (store.TermQuery; Tenant is the
// scope's).
type TermQuery struct {
	Query  string
	Limit  int
	Cursor string
}

// TermPage is one page of a term search.
type TermPage = store.TermPage

// TermInput saves a term from the path's line (an aside is kept).
// SourceMessageID, optional, is a message on that line. Replace overwrites
// the explanation and source of the term the conversation has already;
// without it that is term_exists.
type TermInput struct {
	Term            string
	Explanation     string
	SourceMessageID string
	Replace         bool
}

// TermPatch changes a term's text or explanation; nil leaves it.
type TermPatch struct {
	Term        *string
	Explanation *string
}

func termEvents(scope Scope, out TermChange) []Event {
	t := out.Term
	events := []Event{{Type: EventTermsChanged, Tenant: scope.Tenant, RootLineID: t.RootLineID, LineID: t.SourceLineID,
		Data: TermsChange{RootLineID: t.RootLineID, TermID: t.ID, Change: out.Change}}}
	if out.Kept != nil {
		events = append(events, branchEvent(scope.Tenant, BranchKept, *out.Kept))
	}
	return events
}

// ListTerms lists the glossary of the line's conversation.
func (e *Engine) ListTerms(ctx context.Context, scope Scope, lineID string) (TermList, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureGlossary)
	if err != nil {
		return TermList{}, err
	}
	return e.store.ListTerms(ctx, scope.Tenant, lineID)
}

// CreateTerm saves a term from lineID (any line of the conversation). A
// save from an aside that was not kept keeps it in the same transaction and
// publishes branch.changed{kept} after terms.changed.
// InTx hooks receive store.TermChange.
func (e *Engine) CreateTerm(ctx context.Context, scope Scope, lineID string, in TermInput, opts ...TxOption) (TermChange, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureGlossary)
	if err != nil {
		return TermChange{}, err
	}
	out, err := e.store.CreateTerm(ctx, store.CreateTermInput{
		Tenant: scope.Tenant, LineID: lineID, Term: in.Term, Explanation: in.Explanation, SourceMessageID: in.SourceMessageID,
		Replace: in.Replace, Actor: scope.Actor, Markers: e.markers,
	}, hooksOf(opts)...)
	if err != nil {
		return TermChange{}, err
	}
	e.publish(ctx, termEvents(scope, out)...)
	return out, nil
}

// UpdateTerm changes a term's text or explanation.
// InTx hooks receive store.TermChange.
func (e *Engine) UpdateTerm(ctx context.Context, scope Scope, termID string, patch TermPatch, opts ...TxOption) (TermChange, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureGlossary)
	if err != nil {
		return TermChange{}, err
	}
	out, err := e.store.UpdateTerm(ctx, scope.Tenant, termID, store.TermPatch{Term: patch.Term, Explanation: patch.Explanation, Markers: e.markers}, hooksOf(opts)...)
	if err != nil {
		return TermChange{}, err
	}
	e.publish(ctx, termEvents(scope, out)...)
	return out, nil
}

// DeleteTerm removes a term for good and returns it as it was.
// InTx hooks receive store.TermChange.
func (e *Engine) DeleteTerm(ctx context.Context, scope Scope, termID string, opts ...TxOption) (TermChange, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureGlossary)
	if err != nil {
		return TermChange{}, err
	}
	out, err := e.store.DeleteTerm(ctx, scope.Tenant, termID, hooksOf(opts)...)
	if err != nil {
		return TermChange{}, err
	}
	e.publish(ctx, termEvents(scope, out)...)
	return out, nil
}

// SearchTerms finds the scope's terms across its conversations (archived
// ones left out): keys that start with the query first, then those that
// contain it, each with its conversation's title.
func (e *Engine) SearchTerms(ctx context.Context, scope Scope, in TermQuery) (TermPage, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureGlossary)
	if err != nil {
		return TermPage{}, err
	}
	return e.store.SearchTerms(ctx, store.TermQuery{Tenant: scope.Tenant, Query: in.Query, Limit: in.Limit, Cursor: in.Cursor})
}
