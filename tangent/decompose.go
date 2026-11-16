package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
)

// Decompose proposes how to organise a line, without a model and without
// writing anything (B18): tags its conversation lacks, chapter cuts,
// detours to extract into branches (ExtractToBranch), open items to park
// and the tenant's related conversations (sharing a tag or the folder of
// the line's main line). Any line of the tenant; read-only.
func (e *Engine) Decompose(ctx context.Context, scope Scope, lineID string) (domain.DecomposePlan, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return domain.DecomposePlan{}, err
	}
	base, err := e.store.DecomposeBase(ctx, scope.Tenant, lineID)
	if err != nil {
		return domain.DecomposePlan{}, err
	}
	return domain.BuildDecomposePlan(domain.DecomposeInput{
		LineID: base.LineID, Title: base.Title, Messages: base.Messages, CutMessageIDs: base.CutMessageIDs,
		Tags: base.Tags, TenantTags: base.TenantTags, Related: base.Related, Truncated: base.Truncated,
	}), nil
}
