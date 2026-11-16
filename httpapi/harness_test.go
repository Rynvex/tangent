package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

const (
	tenantA   = "tenant-a"
	tenantB   = "tenant-b"
	tenantOff = "tenant-off" // the test policy switches every feature off for it
	actor     = "tester"

	headerTenant   = "X-Test-Tenant"
	headerReadOnly = "X-Test-Read-Only"
)

// offPolicy switches every feature off for tenantOff.
type offPolicy struct{}

func (offPolicy) Mode(_ context.Context, scope tangent.Scope, _ string) tangent.Mode {
	if scope.Tenant == tenantOff {
		return tangent.ModeOff
	}
	return tangent.ModeAuto
}

// harness is the API over a fresh schema, with a fake runner behind a real
// RunnerDispatcher.
type harness struct {
	t          *testing.T
	ctx        context.Context
	engine     *tangent.Engine
	hub        *httpapi.Hub
	events     *tangenttest.Recorder
	runner     *tangenttest.FakeRunner
	dispatcher *tangent.RunnerDispatcher
	server     *httptest.Server
	pool       *pgxpool.Pool
}

type harnessConfig struct {
	features   []tangent.Feature
	engineOpts []tangent.Option
	wrap       func(tangent.Dispatcher) tangent.Dispatcher
	statusFor  func(string) (int, bool)
	maxBody    int64
	// maxImportBody is Config.MaxImportBodyBytes.
	maxImportBody int64
	hubOpts       []httpapi.HubOption
	txOptions     func(*http.Request, string) []tangent.TxOption
	hostMeta      func(*http.Request, string) (json.RawMessage, error)
	// deltaFilter is Config.DeltaFilter.
	deltaFilter func(*http.Request, string, domain.Delta) (domain.Delta, bool)
	// migrate are features besides search whose migrations the schema
	// needs (memory).
	migrate []string
}

func newHarness(t *testing.T, mutate ...func(*harnessConfig)) *harness {
	t.Helper()
	cfg := harnessConfig{features: append(tangent.AllFeatures(), tangent.Search(), tangent.Leaf(tangent.ModeSuggest), tangent.Parking(), tangent.SuggestionProbe(),
		tangent.Spinoff(), tangent.Rebalance(tangent.ModeSuggest), tangent.Goal(tangent.ModeManual), tangent.Relations(tangent.ModeManual), tangent.OpenLoops(), tangent.Group(tangent.ModeManual),
		tangent.Ibis(tangent.ModeManual), tangent.Fold(tangent.ModeManual), tangent.Diverge(tangent.ModeManual), tangent.Memo())}
	for _, m := range mutate {
		m(&cfg)
	}
	pool := tangenttest.OpenFeatures(t, append([]string{tangent.FeatureSearch}, cfg.migrate...)...)
	h := &harness{t: t, ctx: tangenttest.Context(t), hub: httpapi.NewHub(cfg.hubOpts...), events: tangenttest.NewRecorder(), pool: pool}
	opts := append([]tangent.Option{
		tangent.WithPublisher(tangent.Publishers(h.hub, h.events)), tangent.WithLogger(slog.New(slog.DiscardHandler)),
		tangent.WithFeatures(cfg.features...), tangent.WithFeaturePolicy(offPolicy{}),
	}, cfg.engineOpts...)
	engine, err := tangent.New(pool, opts...)
	if err != nil {
		t.Fatal(err)
	}
	h.engine = engine
	h.runner = tangenttest.NewFakeRunner()
	h.runner.Respond = fakeAnswers
	h.dispatcher = tangent.NewRunnerDispatcher(engine, h.runner)
	engine.SetJobDispatcher(h.dispatcher)
	t.Cleanup(func() { _ = h.dispatcher.Close() })
	dispatcher := tangent.Dispatcher(h.dispatcher)
	if cfg.wrap != nil {
		dispatcher = cfg.wrap(dispatcher)
	}
	handler, err := httpapi.New(httpapi.Config{
		Engine: engine, Dispatcher: dispatcher, Scope: testScope, CanWrite: testCanWrite, Hub: h.hub,
		StatusFor: cfg.statusFor, MaxBodyBytes: cfg.maxBody, MaxImportBodyBytes: cfg.maxImportBody, Logger: slog.New(slog.DiscardHandler),
		TxOptions: cfg.txOptions, HostMeta: cfg.hostMeta, DeltaFilter: cfg.deltaFilter,
	})
	if err != nil {
		t.Fatal(err)
	}
	h.server = httptest.NewServer(http.StripPrefix("/api", handler))
	t.Cleanup(h.server.Close)
	t.Cleanup(h.hub.Close)
	return h
}

// fakeAnswers answers like the reference server's fake runner: jobs get a
// valid card or summary, turns an echo streamed in chunks (after a short
// delay, so every turn records a duration).
func fakeAnswers(req tangent.RunRequest) tangenttest.Reply {
	quiet := req
	if req.OnDelta != nil {
		quiet.OnDelta = func(domain.Delta) {}
	}
	result, err := fake.New(fake.Config{}).Run(context.Background(), quiet)
	if err != nil {
		return tangenttest.Reply{Err: err}
	}
	if req.OnDelta == nil {
		return tangenttest.Reply{Content: result.Content, Usage: result.Usage}
	}
	return tangenttest.Reply{Chunks: chunks(result.Content, chunkRunes), Usage: result.Usage, Delay: turnDelay}
}

const (
	chunkRunes = 24
	turnDelay  = 3 * time.Millisecond
)

// chunks splits text into pieces of n runes.
func chunks(text string, n int) []string {
	runes := []rune(text)
	out := []string{}
	for start := 0; start < len(runes); start += n {
		out = append(out, string(runes[start:min(start+n, len(runes))]))
	}
	return out
}

var errNoTenant = errors.New("no tenant header")

func testScope(r *http.Request) (tangent.Scope, error) {
	tenant := r.Header.Get(headerTenant)
	if tenant == "" {
		return tangent.Scope{}, errNoTenant
	}
	return tangent.Scope{Tenant: tenant, Actor: actor}, nil
}

func testCanWrite(r *http.Request) bool { return r.Header.Get(headerReadOnly) == "" }

// response is one answered request.
type response struct {
	status int
	raw    []byte
	header http.Header
}

// json decodes the body as an object.
func (r response) json(t *testing.T) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(r.raw, &out); err != nil {
		t.Fatalf("body %q: %v", r.raw, err)
	}
	return out
}

// code is the error code of an error body ("" when there is none).
func (r response) code() string {
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(r.raw, &body)
	return body.Code
}

// request options.
type reqOpt func(*http.Request)

func as(tenant string) reqOpt { return func(r *http.Request) { r.Header.Set(headerTenant, tenant) } }

func readOnly() reqOpt { return func(r *http.Request) { r.Header.Set(headerReadOnly, "1") } }

func contentType(value string) reqOpt {
	return func(r *http.Request) {
		if value == "" {
			r.Header.Del("Content-Type")
			return
		}
		r.Header.Set("Content-Type", value)
	}
}

func anonymous() reqOpt { return func(r *http.Request) { r.Header.Del(headerTenant) } }

// do sends a request as tenant A unless an option says otherwise. A body
// that is a string or []byte is sent as is; anything else as JSON.
func (h *harness) do(method, path string, body any, opts ...reqOpt) response {
	h.t.Helper()
	var reader io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		reader = strings.NewReader(b)
	case []byte:
		reader = bytes.NewReader(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			h.t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(h.ctx, method, h.server.URL+"/api"+path, reader)
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set(headerTenant, tenantA)
	if reader != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, opt := range opts {
		opt(req)
	}
	resp, err := h.server.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	return response{status: resp.StatusCode, raw: raw, header: resp.Header}
}

// ok fails unless the response has the status, and decodes it.
func (h *harness) ok(want int, r response) map[string]any {
	h.t.Helper()
	if r.status != want {
		h.t.Fatalf("status = %d, want %d: %s", r.status, want, r.raw)
	}
	if len(r.raw) == 0 {
		return nil
	}
	return r.json(h.t)
}

// wantError fails unless the response is the status and code.
func (h *harness) wantError(r response, status int, code string) {
	h.t.Helper()
	if r.status != status || r.code() != code {
		h.t.Fatalf("got %d %s, want %d %s: %s", r.status, r.code(), status, code, r.raw)
	}
}

// line creates a main line as tenant A and returns its id.
func (h *harness) line() string {
	h.t.Helper()
	body := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines", map[string]any{"title": "main", "provider": "fake", "model": "fake-1"}))
	return body["id"].(string)
}

// turn sends a message and waits for the reply; it returns the reply's id.
func (h *harness) turn(lineID, content string) string {
	h.t.Helper()
	body := h.ok(http.StatusAccepted, h.do(http.MethodPost, "/lines/"+lineID+"/messages", map[string]any{"content": content}))
	h.dispatcher.Wait()
	return body["turnId"].(string)
}

// branch opens a branch on the anchor and returns the branch line's id.
func (h *harness) branch(parentID, anchorID, purpose string) string {
	h.t.Helper()
	body := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+parentID+"/branches", map[string]any{
		"anchorMessageId": anchorID, "purpose": purpose, "kind": "investigate",
	}))
	return body["line"].(map[string]any)["id"].(string)
}

func field(m map[string]any, path ...string) any {
	var v any = m
	for _, key := range path {
		obj, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = obj[key]
	}
	return v
}
