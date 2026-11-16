// Package httpapi is tangent's HTTP API (DESIGN §7): a mountable
// http.Handler over the standard library's ServeMux, plus an SSE Hub for
// /events. The host authenticates through Config.Scope; the API never
// routes the runner-side calls (CompleteTurn, AppendDelta, FinishJob).
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// DefaultMaxBodyBytes bounds a request body when Config.MaxBodyBytes is 0.
const DefaultMaxBodyBytes = 1 << 20

// DefaultMaxImportBodyBytes bounds the body of POST /lines/import when
// Config.MaxImportBodyBytes is 0 (an import carries a whole conversation).
const DefaultMaxImportBodyBytes = 16 << 20

// Config wires the API to an engine and the host.
type Config struct {
	// Engine is required.
	Engine *tangent.Engine
	// Dispatcher runs the turns and jobs the API starts; required.
	Dispatcher tangent.Dispatcher
	// Scope resolves who a request is for: the host's authentication. A
	// *domain.Error is answered with its code; any other error is a 401.
	Scope func(*http.Request) (tangent.Scope, error)
	// CanWrite reports whether the request may change anything; nil lets
	// every request write. Refused writes are 403 forbidden.
	CanWrite func(*http.Request) bool
	// Hub serves GET /events; nil leaves the route out.
	Hub *Hub
	// StatusFor maps codes httpapi does not know (a TurnGate's own codes);
	// unmapped domain errors are 409.
	StatusFor func(code string) (int, bool)
	// MaxBodyBytes bounds a request body (default 1 MiB).
	MaxBodyBytes int64
	// MaxImportBodyBytes bounds the body of POST /lines/import and POST
	// /lines/import-analyze instead (default 16 MiB, never less than MaxBodyBytes).
	MaxImportBodyBytes int64
	// Logger receives internal failures (default slog.Default()).
	Logger *slog.Logger
	// TxOptions adds the host's options (InTx hooks) to the Engine write of a
	// write route, named by op (the Op constants); nil adds nothing. A hook
	// runs in that write's transaction; its error rolls the write back and is
	// answered like any other.
	TxOptions func(r *http.Request, op string) []tangent.TxOption
	// HostMeta returns the host_meta stored with the line or message the
	// write creates (lines.create, turns.send, branches.create,
	// branches.move) or the object that replaces a line's (lines.update; nil
	// leaves it as it is); no other write asks. A *domain.Error refuses the write with its code, any
	// other error is a 500. Clients never send hostMeta themselves. Each
	// callback reads r.Body from the start (the whole body httpapi decoded,
	// fields it ignores included; it is put back before every callback).
	HostMeta func(r *http.Request, op string) (json.RawMessage, error)
	// DeltaFilter decides per reader what of a turn's stream it gets: it is
	// asked about every delta GET /lines/{id}/stream returns and every
	// message.delta event GET /events sends, with the reader's request and
	// the delta's line, and returns the delta to send (rewritten if need be;
	// its TurnID and Seq always stay as they were) or false to leave it out.
	// nil sends every delta to every reader. It must be quick and safe for
	// concurrent use; for /events it runs on that subscriber's goroutine.
	// Only these two outputs are filtered: text deltas also end up in the
	// saved partial and the finished reply (docs/EMBEDDING.md §5).
	DeltaFilter func(r *http.Request, lineID string, d domain.Delta) (domain.Delta, bool)
}

// api is the mounted handler's state.
type api struct {
	engine     *tangent.Engine
	dispatcher tangent.Dispatcher
	scope      func(*http.Request) (tangent.Scope, error)
	canWrite   func(*http.Request) bool
	hub        *Hub
	statusFor  func(string) (int, bool)
	maxBody    int64
	// maxImportBody is Config.MaxImportBodyBytes.
	maxImportBody int64
	log           *slog.Logger
	limits        domain.Limits
	txOptions     func(*http.Request, string) []tangent.TxOption
	// hostMetaFor is Config.HostMeta.
	hostMetaFor func(*http.Request, string) (json.RawMessage, error)
	// deltaFilter is Config.DeltaFilter.
	deltaFilter func(*http.Request, string, domain.Delta) (domain.Delta, bool)
}

// New returns the API handler. Mount it under any prefix with
// http.StripPrefix. Feature routes are only mounted when the engine has the
// feature configured.
func New(cfg Config) (http.Handler, error) {
	switch {
	case cfg.Engine == nil:
		return nil, errors.New("httpapi: Config.Engine is required")
	case cfg.Dispatcher == nil:
		return nil, errors.New("httpapi: Config.Dispatcher is required")
	case cfg.Scope == nil:
		return nil, errors.New("httpapi: Config.Scope is required")
	}
	a := &api{
		engine: cfg.Engine, dispatcher: cfg.Dispatcher, scope: cfg.Scope, canWrite: cfg.CanWrite, hub: cfg.Hub,
		statusFor: cfg.StatusFor, maxBody: cfg.MaxBodyBytes, maxImportBody: cfg.MaxImportBodyBytes, log: cfg.Logger, limits: cfg.Engine.Limits(),
		txOptions: cfg.TxOptions, hostMetaFor: cfg.HostMeta, deltaFilter: cfg.DeltaFilter,
	}
	if a.maxBody <= 0 {
		a.maxBody = DefaultMaxBodyBytes
	}
	if a.maxImportBody <= 0 {
		a.maxImportBody = DefaultMaxImportBodyBytes
	}
	a.maxImportBody = max(a.maxImportBody, a.maxBody)
	if a.log == nil {
		a.log = slog.Default()
	}
	mux := http.NewServeMux()
	for _, rt := range a.routes() {
		if rt.feature == "" || a.engine.FeatureConfigured(rt.feature) || (rt.orFeature != "" && a.engine.FeatureConfigured(rt.orFeature)) {
			mux.Handle(rt.pattern, a.handle(rt))
		}
	}
	if a.hub != nil {
		mux.Handle("GET /events", a.handle(route{pattern: "GET /events", stream: a.events}))
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { a.writeError(w, r, errNotFound) })
	return mux, nil
}

// route is one endpoint. serve answers (status, body); a nil body with
// status 204 writes nothing. stream takes over the response (SSE).
type route struct {
	pattern string
	feature string
	// orFeature also mounts the route (GET /links: spinoff or relations).
	orFeature string
	write     bool
	// op names a write for the host's callbacks (Config.TxOptions).
	op string
	// bigBody bounds the body by Config.MaxImportBodyBytes instead.
	bigBody bool
	serve   func(c *call) (int, any, error)
	stream  func(c *call)
}

// call is one request after authentication.
type call struct {
	a     *api
	w     http.ResponseWriter
	r     *http.Request
	ctx   context.Context
	scope tangent.Scope
	op    string
	// raw is the request body once read (bodyRead), kept so every reader
	// (the API's decode, each host callback) gets all of it.
	raw      []byte
	bodyRead bool
	bodyErr  error
}

// handle authenticates, checks the write permission, bounds the body and
// answers.
func (a *api) handle(rt route) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scope, err := a.scope(r)
		if err != nil {
			a.writeError(w, r, authError(err))
			return
		}
		if rt.write && a.canWrite != nil && !a.canWrite(r) {
			a.writeError(w, r, apiError(CodeForbidden, "this request may not change anything"))
			return
		}
		if err := checkMediaType(r); err != nil {
			a.writeError(w, r, err)
			return
		}
		limit := a.maxBody
		if rt.bigBody {
			limit = a.maxImportBody
		}
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		c := &call{a: a, w: w, r: r, ctx: r.Context(), scope: scope, op: rt.op}
		if rt.stream != nil {
			rt.stream(c)
			return
		}
		status, body, err := rt.serve(c)
		switch {
		case err != nil:
			a.writeError(w, r, err)
		case body == nil:
			w.WriteHeader(status)
		default:
			writeJSON(w, status, body)
		}
	})
}

// authError keeps a host's domain refusal and hides anything else.
func authError(err error) error {
	if domain.CodeOf(err) != "" {
		return err
	}
	return apiError(CodeUnauthorized, "authentication required")
}

// routes is DESIGN §7. Writes are marked; the previews only read.
func (a *api) routes() []route {
	core := []route{
		{pattern: "GET /capabilities", serve: a.capabilities},
		{pattern: "GET /lines", serve: a.listLines},
		{pattern: "POST /lines", write: true, op: OpLinesCreate, serve: a.createLine},
		{pattern: "GET /lines/{id}", serve: a.getLine},
		{pattern: "PATCH /lines/{id}", write: true, op: OpLinesUpdate, serve: a.updateLine},
		{pattern: "DELETE /lines/{id}", write: true, op: OpLinesDelete, serve: a.deleteLine},
		{pattern: "POST /lines/{id}/archive", write: true, op: OpLinesArchive, serve: a.archive(true)},
		{pattern: "POST /lines/{id}/unarchive", write: true, op: OpLinesUnarchive, serve: a.archive(false)},
		{pattern: "POST /lines/{id}/read", write: true, op: OpLinesRead, serve: a.markRead},
		{pattern: "GET /lines/{id}/messages", serve: a.listMessages},
		{pattern: "POST /lines/{id}/messages", write: true, op: OpTurnsSend, serve: a.sendMessage},
		{pattern: "GET /lines/{id}/stream", serve: a.streamSince},
		{pattern: "POST /lines/{id}/retry", write: true, op: OpTurnsRetry, serve: a.retryTurn},
		{pattern: "POST /lines/{id}/cancel", write: true, op: OpTurnsCancel, serve: a.cancelTurn},
		{pattern: "POST /lines/{id}/compact", write: true, op: OpSummaryCompact, feature: tangent.FeatureSummary, serve: a.compact},
		{pattern: "POST /lines/{id}/preview", serve: a.preview},
		{pattern: "GET /lines/{id}/branches", serve: a.listBranches},
		{pattern: "POST /lines/{id}/branches", write: true, op: OpBranchesCreate, serve: a.createBranch},
		{pattern: "POST /lines/{id}/branches/move", write: true, op: OpBranchesMove, serve: a.moveToBranch},
		{pattern: "POST /lines/{id}/branches/preview", serve: a.previewBranch},
		{pattern: "GET /lines/{id}/branch", serve: a.getBranch},
		{pattern: "PATCH /lines/{id}/branch", write: true, op: OpBranchesRename, serve: a.renameBranch},
		{pattern: "POST /lines/{id}/branch/draft", write: true, op: OpBranchesDraft, feature: tangent.FeatureCardDraft, serve: a.startDraft},
		{pattern: "POST /lines/{id}/branch/merge", write: true, op: OpBranchesMerge, serve: a.mergeBranch},
		{pattern: "POST /lines/{id}/branch/discard", write: true, op: OpBranchesDiscard, serve: a.discardBranch},
		{pattern: "POST /lines/{id}/branch/promote", write: true, op: OpBranchesPromote, serve: a.promoteBranch},
		{pattern: "GET /lines/{id}/notes", feature: tangent.FeatureNotes, serve: a.listNotes},
		{pattern: "POST /lines/{id}/notes", write: true, op: OpNotesCreate, feature: tangent.FeatureNotes, serve: a.createNote},
		{pattern: "PATCH /lines/{id}/notes/{nid}", write: true, op: OpNotesUpdate, feature: tangent.FeatureNotes, serve: a.updateNote},
		{pattern: "POST /lines/{id}/notes/{nid}/supersede", write: true, op: OpNotesSupersede, feature: tangent.FeatureNotes, serve: a.supersedeNote},
		{pattern: "GET /lines/{id}/chapters", feature: tangent.FeatureChapters, serve: a.listChapters},
		{pattern: "POST /lines/{id}/chapters/milestones", write: true, op: OpMilestonesAdd, feature: tangent.FeatureChapters, serve: a.addMilestone},
		{pattern: "DELETE /lines/{id}/chapters/milestones/{mid}", write: true, op: OpMilestonesDelete, feature: tangent.FeatureChapters, serve: a.deleteMilestone},
		{pattern: "GET /search", feature: tangent.FeatureSearch, serve: a.search},
	}
	return append(append(append(append(append(append(core, a.p1Routes()...), a.p2Routes()...), a.p2cRoutes()...), a.p3Routes()...), a.p3bRoutes()...), append(append(append(a.memoryRoutes(), a.memoRoutes()...), a.b14Routes()...), append(append(append(a.b15Routes(), a.b17Routes()...), a.b18Routes()...), append(append(a.b23Routes(), a.termRoutes()...), a.importRoutes()...)...)...)...)
}

// p1Routes are the B8 feature routes: the suggestion inbox, leaves, seeds
// and spinoff.
func (a *api) p1Routes() []route {
	return []route{
		{pattern: "GET /lines/{id}/suggestions", feature: tangent.FeatureSuggestions, serve: a.listSuggestions},
		{pattern: "POST /suggestions/{sid}/accept", write: true, op: OpSuggestionsAccept, feature: tangent.FeatureSuggestions, serve: a.acceptSuggestion},
		{pattern: "POST /suggestions/{sid}/dismiss", write: true, op: OpSuggestionsDismiss, feature: tangent.FeatureSuggestions, serve: a.dismissSuggestion},
		{pattern: "GET /lines/{id}/leaf", feature: tangent.FeatureLeaf, serve: a.getLeaf},
		{pattern: "PUT /lines/{id}/leaf", write: true, op: OpLeafPut, feature: tangent.FeatureLeaf, serve: a.putLeaf},
		{pattern: "DELETE /lines/{id}/leaf", write: true, op: OpLeafDelete, feature: tangent.FeatureLeaf, serve: a.deleteLeaf},
		{pattern: "POST /lines/{id}/leaf/draft", write: true, op: OpLeafDraft, feature: tangent.FeatureLeaf, serve: a.draftLeaf},
		{pattern: "GET /lines/{id}/seeds", feature: tangent.FeatureParking, serve: a.listSeeds},
		{pattern: "POST /lines/{id}/seeds", write: true, op: OpSeedsCreate, feature: tangent.FeatureParking, serve: a.createSeed},
		{pattern: "POST /seeds/{sid}/expand", write: true, op: OpSeedsExpand, feature: tangent.FeatureParking, serve: a.expandSeed},
		{pattern: "POST /seeds/{sid}/to-note", write: true, op: OpSeedsToNote, feature: tangent.FeatureParking, serve: a.seedToNote},
		{pattern: "POST /seeds/{sid}/drop", write: true, op: OpSeedsDrop, feature: tangent.FeatureParking, serve: a.dropSeed},
		{pattern: "POST /lines/{id}/spinoff", write: true, op: OpSpinoffCreate, feature: tangent.FeatureSpinoff, serve: a.spinoff},
		{pattern: "POST /lines/{id}/spinoff/preview", feature: tangent.FeatureSpinoff, serve: a.previewSpinoff},
		{pattern: "GET /lines/{id}/links", feature: tangent.FeatureSpinoff, orFeature: tangent.FeatureRelations, serve: a.listLinks},
	}
}
