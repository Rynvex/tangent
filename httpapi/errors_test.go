package httpapi_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/tangent"
)

// gate refuses turns with err.
type gate struct{ err error }

func (g gate) AllowTurn(context.Context, tangent.Scope, domain.LineView) error { return g.err }

func TestErrors_HostCodesUseStatusForAndOtherFailuresDoNotLeak(t *testing.T) {
	offline := domain.NewError("daemon_offline", "the runner is offline", map[string]any{"retryIn": 5})
	h := newHarness(t, func(c *harnessConfig) {
		c.engineOpts = append(c.engineOpts, tangent.WithTurnGate(gate{err: offline}))
		c.statusFor = func(code string) (int, bool) { return http.StatusServiceUnavailable, code == "daemon_offline" }
	})
	line := h.line()
	r := h.do(http.MethodPost, "/lines/"+line+"/messages", map[string]any{"content": "hi"})
	h.wantError(r, http.StatusServiceUnavailable, "daemon_offline")
	if body := r.json(t); body["error"] != "the runner is offline" || body["retryIn"] != float64(5) {
		t.Fatalf("the host's message and extra fields are kept: %v", body)
	}

	unmapped := newHarness(t, func(c *harnessConfig) {
		c.engineOpts = append(c.engineOpts, tangent.WithTurnGate(gate{err: domain.NewError("quota", "over quota", nil)}))
	})
	h.wantError(unmapped.do(http.MethodPost, "/lines/"+unmapped.line()+"/messages", map[string]any{"content": "hi"}), http.StatusConflict, "quota")

	leaky := newHarness(t, func(c *harnessConfig) {
		c.engineOpts = append(c.engineOpts, tangent.WithTurnGate(gate{err: errors.New("pq: password authentication failed for secret-db")}))
	})
	r = leaky.do(http.MethodPost, "/lines/"+leaky.line()+"/messages", map[string]any{"content": "hi"})
	leaky.wantError(r, http.StatusInternalServerError, "internal")
	if strings.Contains(string(r.raw), "secret") {
		t.Fatalf("an internal failure leaked: %s", r.raw)
	}
}

func TestErrors_StatusOfKnowsEveryDomainCode(t *testing.T) {
	codes := []string{
		domain.CodeDepthSoftLimit, domain.CodeParentMoved, domain.CodeInvalidCard, domain.CodeOpenBranchesOnOldTail,
		domain.CodeFeatureDisabled, domain.CodeJobNotFound, domain.CodeConcurrentChange, domain.CodeIDUnavailable,
		httpapi.CodeUnauthorized, httpapi.CodeForbidden, httpapi.CodePayloadTooLarge, httpapi.CodeNotFound,
	}
	for _, code := range codes {
		if _, ok := httpapi.StatusOf(code); !ok {
			t.Errorf("no status for %s", code)
		}
	}
	if status, _ := httpapi.StatusOf(domain.CodeInvalidCard); status != http.StatusUnprocessableEntity {
		t.Fatalf("invalid_card = %d", status)
	}
	if _, ok := httpapi.StatusOf("made_up"); ok {
		t.Fatal("unknown codes are not in the table")
	}
}

// refusing refuses turns and/or jobs, passing the rest to the real one.
type refusing struct {
	tangent.Dispatcher
	turns, jobs bool
}

var errRefused = errors.New("queue full")

func (r refusing) DispatchTurn(ctx context.Context, t tangent.Turn) error {
	if r.turns {
		return errRefused
	}
	return r.Dispatcher.DispatchTurn(ctx, t)
}

func (r refusing) DispatchJob(ctx context.Context, j tangent.Job) error {
	if r.jobs {
		return errRefused
	}
	return r.Dispatcher.DispatchJob(ctx, j)
}

func TestErrors_ATurnTheDispatcherRefusesIsFailedAtOnce(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) {
		c.wrap = func(d tangent.Dispatcher) tangent.Dispatcher { return refusing{Dispatcher: d, turns: true} }
	})
	line := h.line()
	h.wantError(h.do(http.MethodPost, "/lines/"+line+"/messages", map[string]any{"content": "hi"}), http.StatusServiceUnavailable, "unavailable")
	page := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+line+"/messages", nil))
	messages := page["messages"].([]any)
	reply := messages[len(messages)-1].(map[string]any)
	if reply["status"] != "error" || field(reply, "meta", "error") != "the turn could not be started" {
		t.Fatalf("the refused turn is failed: %v", reply)
	}
	if body := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+line, nil)); body["status"] == "thinking" {
		t.Fatalf("the line is not left thinking: %v", body)
	}
}

func TestErrors_AJobTheDispatcherRefusesIsFailedAtOnce(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) {
		c.wrap = func(d tangent.Dispatcher) tangent.Dispatcher { return refusing{Dispatcher: d, jobs: true} }
	})
	s := h.seed()
	h.wantError(h.do(http.MethodPost, "/lines/"+s.branch+"/branch/draft", nil), http.StatusServiceUnavailable, "unavailable")
	detail := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+s.branch+"/branch", nil))
	if status := field(detail, "draft", "status"); status != "failed" {
		t.Fatalf("the refused draft is failed: %v", detail["draft"])
	}
	h.wantError(h.do(http.MethodPost, "/lines/"+s.main+"/compact", nil), http.StatusServiceUnavailable, "unavailable")
	h.wantError(h.do(http.MethodPost, "/lines/"+s.main+"/compact", nil), http.StatusServiceUnavailable, "unavailable")
}

func TestErrors_BodiesAreBoundedAndUnknownRoutesAreJSON(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) { c.maxBody = 64 })
	h.wantError(h.do(http.MethodPost, "/lines", map[string]any{"title": strings.Repeat("x", 100)}), http.StatusRequestEntityTooLarge, "payload_too_large")
	h.wantError(h.do(http.MethodGet, "/nope", nil), http.StatusNotFound, "not_found")
	if _, err := httpapi.New(httpapi.Config{}); err == nil {
		t.Fatal("an engine is required")
	}
	if _, err := httpapi.New(httpapi.Config{Engine: h.engine}); err == nil {
		t.Fatal("a dispatcher is required")
	}
	if _, err := httpapi.New(httpapi.Config{Engine: h.engine, Dispatcher: h.dispatcher}); err == nil {
		t.Fatal("a scope function is required")
	}
}
