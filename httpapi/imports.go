package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// Import batch routes (B25, core): the batches a client named with
// POST /lines/import's batchId, listed and undone. {bid} is a batch id.

// importBatchPageMax bounds GET /imports?limit=.
const importBatchPageMax = 200

func (a *api) importRoutes() []route {
	return []route{
		{pattern: "GET /imports", serve: a.listImportBatches},
		{pattern: "DELETE /imports/{bid}", write: true, op: OpImportsDelete, serve: a.deleteImportBatch},
	}
}

type importBatchPage struct {
	Imports    []domain.ImportBatch `json:"imports"`
	NextCursor string               `json:"nextCursor"`
}

// listImportBatches is GET /imports?limit=&cursor=: the tenant's batches,
// newest first.
func (a *api) listImportBatches(c *call) (int, any, error) {
	limit, err := c.queryInt("limit", 1, importBatchPageMax)
	if err != nil {
		return 0, nil, err
	}
	page, err := a.engine.ImportBatches(c.ctx, c.scope, tangent.ImportBatchQuery{Limit: int(limit), Cursor: c.r.URL.Query().Get("cursor")})
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, importBatchPage{Imports: list(page.Batches), NextCursor: page.NextCursor}, nil
}

// deleteImportBatch is DELETE /imports/{bid}?force=: deletes the batch's
// conversations that are still on their own and were not used since
// (force: used ones too), then the batch when nothing was kept.
func (a *api) deleteImportBatch(c *call) (int, any, error) {
	id, err := c.pathID("bid", domain.ErrImportBatchNotFound)
	if err != nil {
		return 0, nil, err
	}
	force, err := c.queryBool("force")
	if err != nil {
		return 0, nil, err
	}
	out, err := a.engine.DeleteImportBatch(c.ctx, c.scope, id, force, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, domain.ImportBatchDeletion{Deleted: list(out.Deleted), Kept: list(out.Kept)}, nil
}
