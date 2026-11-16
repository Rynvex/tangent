package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// B22: POST /lines/import-analyze proposes how an import is organized (a
// read: it writes nothing, so a viewer may ask, and it is no Op). The model
// is asked through the API's Dispatcher when it can run one request at once
// (tangent.OnceRunner, the RunnerDispatcher) and only for a caller that may
// write (Config.CanWrite): a viewer cannot import, so it never spends model
// budget and always gets the deterministic analyzer, which also answers
// whenever the model's plan is unusable.

// importAnalyzeBody is POST /lines/import-analyze.
type importAnalyzeBody struct {
	Title    string                     `json:"title"`
	Units    []domain.ImportAnalyzeUnit `json:"units"`
	HostMeta json.RawMessage            `json:"hostMeta"`
}

func (a *api) analyzeImport(c *call) (int, any, error) {
	var in importAnalyzeBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	if hasHostMeta(in.HostMeta) {
		return 0, nil, errHostMeta
	}
	plan, err := a.engine.AnalyzeImport(c.ctx, c.scope, domain.ImportAnalyzeInput{Title: in.Title, Units: in.Units}, a.analyzeRunner(c))
	if err != nil {
		return 0, nil, err
	}
	nodes := make([]domain.ImportAnalyzeNode, 0, len(plan.Nodes))
	for _, node := range plan.Nodes {
		node.UnitKeys = list(node.UnitKeys)
		nodes = append(nodes, node)
	}
	plan.Nodes = nodes
	return http.StatusOK, plan, nil
}

// analyzeRunner is the Dispatcher's synchronous runner for a caller that may
// write; nil for a viewer or when the Dispatcher has none.
func (a *api) analyzeRunner(c *call) tangent.Runner {
	if a.canWrite != nil && !a.canWrite(c.r) {
		return nil
	}
	if once, ok := a.dispatcher.(tangent.OnceRunner); ok {
		return tangent.RunnerFunc(once.RunOnce)
	}
	return nil
}
