package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// Glossary routes (the glossary feature, B24). {id} is any line of the
// conversation (the source line of a save); {tid} a term id.

// termSearchMax bounds GET /terms?limit=.
const termSearchMax = 100

func (a *api) termRoutes() []route {
	return []route{
		{pattern: "GET /lines/{id}/terms", feature: tangent.FeatureGlossary, serve: a.listTerms},
		{pattern: "POST /lines/{id}/terms", write: true, op: OpTermsCreate, feature: tangent.FeatureGlossary, serve: a.createTerm},
		{pattern: "PATCH /terms/{tid}", write: true, op: OpTermsUpdate, feature: tangent.FeatureGlossary, serve: a.updateTerm},
		{pattern: "DELETE /terms/{tid}", write: true, op: OpTermsDelete, feature: tangent.FeatureGlossary, serve: a.deleteTerm},
		{pattern: "GET /terms", feature: tangent.FeatureGlossary, serve: a.searchTerms},
	}
}

type termList struct {
	RootLineID string        `json:"rootLineId"`
	Terms      []domain.Term `json:"terms"`
	Limits     termLimits    `json:"limits"`
}

// termLimits are the glossary bounds (domain.Limits.Glossary).
type termLimits struct {
	MaxTotal            int `json:"maxTotal"`
	TermMaxRunes        int `json:"termMaxRunes"`
	ExplanationMaxRunes int `json:"explanationMaxRunes"`
}

// termSaved is a save's answer: the term, created or updated (replace),
// and the aside the save kept, when it kept one.
type termSaved struct {
	Term       domain.Term        `json:"term"`
	Change     string             `json:"change"`
	KeptBranch *domain.BranchView `json:"keptBranch,omitempty"`
}

type termView struct {
	Term domain.Term `json:"term"`
}

type termPage struct {
	Terms      []domain.TermHit `json:"terms"`
	NextCursor string           `json:"nextCursor"`
}

// listTerms is GET /lines/{id}/terms: the conversation's glossary in key
// order.
func (a *api) listTerms(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	terms, err := a.engine.ListTerms(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	l := a.limits.Glossary
	return http.StatusOK, termList{RootLineID: terms.RootLineID, Terms: list(terms.Terms), Limits: termLimits{
		MaxTotal: l.MaxPerTree, TermMaxRunes: l.TermMaxRunes, ExplanationMaxRunes: l.ExplanationMaxRunes,
	}}, nil
}

// termBody is POST /lines/{id}/terms.
type termBody struct {
	Term            string `json:"term"`
	Explanation     string `json:"explanation"`
	SourceMessageID string `json:"sourceMessageId"`
	Replace         bool   `json:"replace"`
}

// createTerm answers 201 for a new term, 200 for a replaced one.
func (a *api) createTerm(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in termBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	if in.SourceMessageID != "" {
		if in.SourceMessageID, err = c.idValue(in.SourceMessageID, domain.ErrMessageNotFound); err != nil {
			return 0, nil, err
		}
	}
	out, err := a.engine.CreateTerm(c.ctx, c.scope, id, tangent.TermInput{
		Term: in.Term, Explanation: in.Explanation, SourceMessageID: in.SourceMessageID, Replace: in.Replace,
	}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	status := http.StatusCreated
	if out.Change != tangent.TermCreated {
		status = http.StatusOK
	}
	return status, termSaved{Term: out.Term, Change: out.Change, KeptBranch: out.Kept}, nil
}

// termPatchBody is PATCH /terms/{tid}: a field left out stays.
type termPatchBody struct {
	Term        *string `json:"term"`
	Explanation *string `json:"explanation"`
}

func (a *api) updateTerm(c *call) (int, any, error) {
	id, err := c.pathID("tid", domain.ErrTermNotFound)
	if err != nil {
		return 0, nil, err
	}
	var in termPatchBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	out, err := a.engine.UpdateTerm(c.ctx, c.scope, id, tangent.TermPatch{Term: in.Term, Explanation: in.Explanation}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, termView{Term: out.Term}, nil
}

func (a *api) deleteTerm(c *call) (int, any, error) {
	id, err := c.pathID("tid", domain.ErrTermNotFound)
	if err != nil {
		return 0, nil, err
	}
	if _, err := a.engine.DeleteTerm(c.ctx, c.scope, id, c.tx()...); err != nil {
		return 0, nil, err
	}
	return http.StatusNoContent, nil, nil
}

// searchTerms is GET /terms?q=&limit=&cursor=: the tenant's terms whose
// key starts with (first) or contains q, outside archived conversations.
func (a *api) searchTerms(c *call) (int, any, error) {
	limit, err := c.queryInt("limit", 1, termSearchMax)
	if err != nil {
		return 0, nil, err
	}
	query := c.r.URL.Query()
	page, err := a.engine.SearchTerms(c.ctx, c.scope, tangent.TermQuery{Query: query.Get("q"), Limit: int(limit), Cursor: query.Get("cursor")})
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, termPage{Terms: list(page.Terms), NextCursor: page.NextCursor}, nil
}
