package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/Rynvex/tangent/domain"
)

// Codes httpapi adds to the domain's (DESIGN §6 errors).
const (
	// CodeUnauthorized: Config.Scope refused the request.
	CodeUnauthorized = "unauthorized"
	// CodeForbidden: Config.CanWrite refused a write.
	CodeForbidden = "forbidden"
	// CodePayloadTooLarge: the body is larger than Config.MaxBodyBytes.
	CodePayloadTooLarge = "payload_too_large"
	// CodeNotFound: no such route (also a feature route that is not mounted).
	CodeNotFound = "not_found"
	// CodeUnavailable: the work could not be handed to the dispatcher.
	CodeUnavailable = "unavailable"
	// CodeInternal: anything else; the detail is only logged.
	CodeInternal = "internal"
	// CodeUnsupportedMediaType: a body that is not application/json.
	CodeUnsupportedMediaType = "unsupported_media_type"
)

// statusOf maps every known code to its HTTP status (S1 devlog table plus
// the codes added since). Codes not listed go to Config.StatusFor, then 409.
var statusOf = map[string]int{
	// Opening branches.
	domain.CodeDepthSoftLimit: http.StatusConflict, domain.CodeDepthHardLimit: http.StatusConflict,
	domain.CodeBranchLimit: http.StatusConflict, domain.CodeTreeLimit: http.StatusConflict,
	domain.CodeParentClosed: http.StatusConflict, domain.CodeAnchorNotFound: http.StatusNotFound,
	domain.CodeKindUnsupported: http.StatusBadRequest, domain.CodeSuggestionNotFound: http.StatusNotFound,
	// Turns and branch state.
	domain.CodeBranchClosed: http.StatusConflict, domain.CodeArchived: http.StatusConflict,
	domain.CodeAsideAnswered: http.StatusConflict, domain.CodeBranchBusy: http.StatusConflict,
	domain.CodeBranchDrafting: http.StatusConflict,
	// Drafting and merging.
	domain.CodeNoMessages: http.StatusConflict, domain.CodeDraftNotPending: http.StatusConflict,
	domain.CodeParentBusy: http.StatusConflict, domain.CodeParentMoved: http.StatusConflict,
	domain.CodeInvalidCard: http.StatusUnprocessableEntity, domain.CodeInvalidParentTip: http.StatusUnprocessableEntity,
	// Moving, promoting, deleting.
	domain.CodeInvalidCount: http.StatusBadRequest, domain.CodeNotEnoughMessages: http.StatusBadRequest,
	domain.CodeMoveMustStartWithUser: http.StatusBadRequest, domain.CodeMoveProtected: http.StatusBadRequest,
	domain.CodeMoveNoAnchor: http.StatusBadRequest, domain.CodeSourceBusy: http.StatusConflict,
	domain.CodePromoteNotTopLevel: http.StatusConflict, domain.CodeOpenBranchesOnOldTail: http.StatusConflict,
	domain.CodeSessionBusy: http.StatusConflict, domain.CodeNotMainLine: http.StatusConflict,
	// Notes and chapters.
	domain.CodeNoteNotFound: http.StatusNotFound, domain.CodeNoteSuperseded: http.StatusConflict,
	domain.CodeNoteLimit: http.StatusConflict, domain.CodeInvalidNote: http.StatusUnprocessableEntity,
	domain.CodeNoteSourceNotFound: http.StatusUnprocessableEntity, domain.CodeMilestoneNotFound: http.StatusNotFound,
	domain.CodeMilestoneExists: http.StatusConflict, domain.CodeMilestoneLimit: http.StatusConflict,
	domain.CodeMessageNotFound: http.StatusNotFound, domain.CodeInvalidMilestone: http.StatusUnprocessableEntity,
	// Codes tangent added.
	domain.CodeTurnPending: http.StatusConflict, domain.CodeTurnNotPending: http.StatusConflict,
	domain.CodeInvalidTransition: http.StatusConflict, domain.CodeLineNotFound: http.StatusNotFound,
	domain.CodeBranchNotFound: http.StatusNotFound, domain.CodeInvalidInput: http.StatusBadRequest,
	domain.CodeJobNotFound: http.StatusNotFound, domain.CodeJobNotPending: http.StatusConflict,
	domain.CodeConcurrentChange: http.StatusConflict, domain.CodeIDUnavailable: http.StatusConflict,
	domain.CodeFeatureDisabled: http.StatusNotFound, domain.CodeTooLong: http.StatusUnprocessableEntity,
	domain.CodeModelNotAllowed: http.StatusUnprocessableEntity, domain.CodeNothingToRetry: http.StatusConflict,
	// B8: leaves, seeds and the suggestion inbox.
	domain.CodeInvalidLeaf: http.StatusUnprocessableEntity, domain.CodeLeafNotFound: http.StatusNotFound,
	domain.CodeSeedNotFound: http.StatusNotFound, domain.CodeSeedNotOpen: http.StatusConflict, domain.CodeSeedLimit: http.StatusConflict,
	domain.CodeMemoNotFound: http.StatusNotFound, domain.CodeMemoLimit: http.StatusConflict,
	domain.CodeTermNotFound: http.StatusNotFound, domain.CodeTermLimit: http.StatusConflict, domain.CodeTermExists: http.StatusConflict,
	domain.CodeImportBatchNotFound: http.StatusNotFound,
	domain.CodeSuggestionNotOpen:   http.StatusConflict,
	// B9: goals and relations.
	domain.CodeGoalNotFound: http.StatusNotFound, domain.CodeRelationNotFound: http.StatusNotFound,
	domain.CodeRelationLimit: http.StatusConflict, domain.CodeRelationExists: http.StatusConflict,
	domain.CodeGroupNotFound: http.StatusNotFound, domain.CodeGroupNotActive: http.StatusConflict,
	domain.CodeInvalidGroup: http.StatusUnprocessableEntity, domain.CodeGroupLimit: http.StatusConflict,
	// P3 (B10 part A).
	domain.CodeFoldNotFound: http.StatusNotFound, domain.CodeFoldOverlap: http.StatusConflict,
	domain.CodeFoldLimit: http.StatusConflict, domain.CodeInvalidFold: http.StatusUnprocessableEntity,
	// P3 (B10 part B).
	domain.CodeComparisonNotFound: http.StatusNotFound, domain.CodeComparisonNotReady: http.StatusConflict,
	domain.CodeComparisonDecided: http.StatusConflict, domain.CodeInvalidComparison: http.StatusUnprocessableEntity,
	// P3 (B10 part C).
	domain.CodeMemoryNotFound: http.StatusNotFound, domain.CodeMemorySuperseded: http.StatusConflict, domain.CodeInvalidMemory: http.StatusUnprocessableEntity,
	domain.CodeEmbedderUnavailable: http.StatusServiceUnavailable,
	// B23: deleting one ended branch.
	domain.CodeBranchNotDeletable: http.StatusConflict,
	// httpapi's own.
	CodeUnauthorized: http.StatusUnauthorized, CodeForbidden: http.StatusForbidden,
	CodePayloadTooLarge: http.StatusRequestEntityTooLarge, CodeNotFound: http.StatusNotFound,
	CodeUnavailable: http.StatusServiceUnavailable, CodeInternal: http.StatusInternalServerError,
	CodeUnsupportedMediaType: http.StatusUnsupportedMediaType,
}

// StatusOf is the HTTP status httpapi answers a code with, and whether the
// code is one it knows (for hosts and tests).
func StatusOf(code string) (int, bool) {
	status, ok := statusOf[code]
	return status, ok
}

// apiError builds an httpapi refusal.
func apiError(code, message string) error { return domain.NewError(code, message, nil) }

// errorBody is the error envelope: {error, code, ...extra}.
func errorBody(e *domain.Error) map[string]any {
	body := make(map[string]any, len(e.Extra)+2)
	for k, v := range e.Extra {
		body[k] = v
	}
	body["error"] = e.Message
	body["code"] = e.Code
	return body
}

// writeError answers err: a domain error with its status and extra fields,
// anything else as a 500 whose detail is only logged.
func (a *api) writeError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
		// The client went away; nobody reads an answer.
		a.log.Debug("tangent httpapi: request cancelled by the client", "method", r.Method, "path", r.URL.Path)
		return
	}
	e := domain.AsError(err, a.limits)
	if e == nil {
		a.log.Error("tangent httpapi: request failed", "method", r.Method, "path", r.URL.Path, "error", err)
		writeJSON(w, http.StatusInternalServerError, errorBody(domain.NewError(CodeInternal, "internal error", nil)))
		return
	}
	writeJSON(w, a.status(e.Code), errorBody(e))
}

// status maps a code: the table, then the host's StatusFor, then 409.
func (a *api) status(code string) int {
	if status, ok := statusOf[code]; ok {
		return status
	}
	if a.statusFor != nil {
		if status, ok := a.statusFor(code); ok && status >= 400 && status <= 599 {
			return status
		}
	}
	return http.StatusConflict
}

// writeJSON answers status with v as JSON.
func writeJSON(w http.ResponseWriter, status int, v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		slog.Error("tangent httpapi: encode response", "error", err)
		status, raw = http.StatusInternalServerError, []byte(`{"error":"internal error","code":"internal"}`)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(append(raw, '\n'))
}

// errNotFound answers routes that do not exist.
var errNotFound = apiError(CodeNotFound, "no such route")

// isMaxBytes reports a body over the limit.
func isMaxBytes(err error) bool {
	var tooLarge *http.MaxBytesError
	return errors.As(err, &tooLarge)
}
