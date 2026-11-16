package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// codeHostRefused is the host's own refusal in these tests.
const codeHostRefused = "host_refused"

// hostCalls records what the host callbacks were asked: the op per route
// pattern, and the ops whose hook ran inside the write's transaction.
type hostCalls struct {
	mu      sync.Mutex
	ops     map[string]string
	inTx    map[string]bool
	refuse  bool
	results map[string]string
}

func newHostCalls(refuse bool) *hostCalls {
	return &hostCalls{ops: map[string]string{}, inTx: map[string]bool{}, refuse: refuse, results: map[string]string{}}
}

func (h *hostCalls) txOptions(r *http.Request, op string) []tangent.TxOption {
	h.mu.Lock()
	h.ops[r.Pattern] = op
	h.mu.Unlock()
	return []tangent.TxOption{tangent.InTx(func(ctx context.Context, tx store.Tx, result any) error {
		var one int
		if err := tx.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil {
			return err
		}
		h.mu.Lock()
		h.inTx[op] = true
		if begun, ok := result.(store.BegunTurn); ok {
			h.results[op] = begun.Pending.ID
		}
		h.mu.Unlock()
		if h.refuse {
			return domain.NewError(codeHostRefused, "the host refused this write", nil)
		}
		return nil
	})}
}

func withHost(calls *hostCalls) func(*harnessConfig) {
	return func(c *harnessConfig) {
		c.txOptions = calls.txOptions
		c.statusFor = func(code string) (int, bool) {
			if code == codeHostRefused {
				return http.StatusTeapot, true
			}
			return 0, false
		}
	}
}

// TestHostHooks_EveryWriteRouteRunsTheHostsHookInItsTransaction: a host hook
// that refuses rolls every write back (the request fails with the host's
// code and nothing is published), and every write route names a distinct op.
func TestHostHooks_EveryWriteRouteRunsTheHostsHookInItsTransaction(t *testing.T) {
	calls := newHostCalls(true)
	h := newHarness(t, withHost(calls))
	s := h.seedWithoutHost(calls)
	before := len(h.events.Events())
	for _, rc := range routeTable(s) {
		if !rc.write {
			continue
		}
		r := h.do(rc.method, rc.path, rc.body)
		if rc.name == "cancel" {
			// Nothing is in flight: CancelTurn writes nothing and runs no hook.
			h.ok(http.StatusOK, r)
			continue
		}
		if refusedBeforeHooks[rc.name] {
			// The engine refuses these on the seeded data before its hooks
			// run; the op check below still shows the host was asked.
			if r.code() == "" || r.code() == codeHostRefused {
				t.Errorf("%s: got %d %s", rc.name, r.status, r.raw)
			}
			continue
		}
		if r.status != http.StatusTeapot || r.code() != codeHostRefused {
			t.Errorf("%s: got %d %s", rc.name, r.status, r.raw)
		}
	}
	if after := len(h.events.Events()); after != before {
		t.Fatalf("refused writes published %d events: %v", after-before, h.events.Types()[before:])
	}
	seen := map[string]string{}
	for pattern, op := range calls.ops {
		if op == "" {
			t.Errorf("%s: no op", pattern)
		}
		if other, dup := seen[op]; dup {
			t.Errorf("op %s names both %s and %s", op, other, pattern)
		}
		seen[op] = pattern
	}
	if len(calls.ops) != writeRoutes(routeTable(s)) {
		t.Fatalf("the host was asked for %d write routes, the table has %d: %v", len(calls.ops), writeRoutes(routeTable(s)), calls.ops)
	}
}

// refusedBeforeHooks are the table's writes the seeded data does not allow
// (its bodies fit the contract run, which changes the data in between).
var refusedBeforeHooks = map[string]bool{
	"retry": true, "merge": true, "add milestone": true, "delete leaf": true, "delete goal": true,
	// The seeded branch is open: it has no card to edit yet.
	"update card": true,
}

func writeRoutes(cases []routeCase) int {
	n := 0
	for _, rc := range cases {
		if rc.write {
			n++
		}
	}
	return n
}

// seedWithoutHost seeds the route table's data with the host's refusal off.
func (h *harness) seedWithoutHost(calls *hostCalls) seeded {
	calls.mu.Lock()
	calls.refuse = false
	calls.mu.Unlock()
	s := h.seed()
	calls.mu.Lock()
	calls.refuse = true
	calls.ops = map[string]string{}
	calls.mu.Unlock()
	return s
}

// TestHostHooks_ASentMessageCarriesTheTurnIntoTheHostsTransaction: the hook
// of turns.send receives the begun turn, so a host can queue its id durably.
func TestHostHooks_ASentMessageCarriesTheTurnIntoTheHostsTransaction(t *testing.T) {
	calls := newHostCalls(false)
	h := newHarness(t, withHost(calls))
	line := h.line()
	body := h.ok(http.StatusAccepted, h.do(http.MethodPost, "/lines/"+line+"/messages", map[string]any{"content": "hi"}))
	h.dispatcher.Wait()
	calls.mu.Lock()
	defer calls.mu.Unlock()
	if calls.ops["POST /lines/{id}/messages"] != httpapi.OpTurnsSend || calls.results[httpapi.OpTurnsSend] != body["turnId"] {
		t.Fatalf("ops %v results %v turn %v", calls.ops, calls.results, body["turnId"])
	}
}

// TestHostHooks_HostMetaIsWrittenWhereTheEngineTakesIt: lines.create,
// lines.update, turns.send, branches.create and branches.move store what
// Config.HostMeta returns; other writes never ask.
func TestHostHooks_HostMetaIsWrittenWhereTheEngineTakesIt(t *testing.T) {
	var mu sync.Mutex
	asked := []string{}
	h := newHarness(t, func(c *harnessConfig) {
		c.hostMeta = func(_ *http.Request, op string) (json.RawMessage, error) {
			mu.Lock()
			defer mu.Unlock()
			asked = append(asked, op)
			return json.RawMessage(`{"by":"host","op":"` + op + `"}`), nil
		}
	})
	created := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines", map[string]any{"title": "main", "provider": "fake", "model": "fake-1"}))
	line := created["id"].(string)
	wantMeta(t, created["hostMeta"], httpapi.OpLinesCreate)
	updated := h.ok(http.StatusOK, h.do(http.MethodPatch, "/lines/"+line, map[string]any{"title": "renamed"}))
	wantMeta(t, updated["hostMeta"], httpapi.OpLinesUpdate)
	sent := h.ok(http.StatusAccepted, h.do(http.MethodPost, "/lines/"+line+"/messages", map[string]any{"content": "first"}))
	h.dispatcher.Wait()
	wantMeta(t, field(sent, "userMessage", "hostMeta"), httpapi.OpTurnsSend)
	branch := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+line+"/branches", map[string]any{
		"anchorMessageId": sent["turnId"], "purpose": "look", "kind": "investigate",
	}))
	wantMeta(t, field(branch, "line", "hostMeta"), httpapi.OpBranchesCreate)
	h.turn(line, "second")
	moved := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+line+"/branches/move", map[string]any{"count": 2, "purpose": "moved"}))
	wantMeta(t, field(moved, "line", "hostMeta"), httpapi.OpBranchesMove)
	mu.Lock()
	defer mu.Unlock()
	want := []string{httpapi.OpLinesCreate, httpapi.OpLinesUpdate, httpapi.OpTurnsSend, httpapi.OpBranchesCreate, httpapi.OpTurnsSend, httpapi.OpBranchesMove}
	if len(asked) != len(want) {
		t.Fatalf("asked %v, want %v", asked, want)
	}
	for i := range want {
		if asked[i] != want[i] {
			t.Fatalf("asked %v, want %v", asked, want)
		}
	}
}

func wantMeta(t *testing.T, got any, op string) {
	t.Helper()
	meta, ok := got.(map[string]any)
	if !ok || meta["by"] != "host" || meta["op"] != op {
		t.Fatalf("hostMeta = %v, want the host's for %s", got, op)
	}
}

// TestHostHooks_AHostMetaErrorRefusesTheWrite: a domain error keeps its
// code, anything else is a 500 that says nothing; nothing is written.
func TestHostHooks_AHostMetaErrorRefusesTheWrite(t *testing.T) {
	refusal := errors.New("secret detail")
	h := newHarness(t, func(c *harnessConfig) {
		c.hostMeta = func(r *http.Request, _ string) (json.RawMessage, error) {
			if r.URL.Query().Get("domain") != "" {
				return nil, domain.NewError(domain.CodeInvalidInput, "the host needs a project", nil)
			}
			return nil, refusal
		}
	})
	h.wantError(h.do(http.MethodPost, "/lines?domain=1", map[string]any{"title": "x"}), http.StatusBadRequest, "invalid_input")
	r := h.do(http.MethodPost, "/lines", map[string]any{"title": "x"})
	if r.status != http.StatusInternalServerError || r.code() != "internal" || strings.Contains(string(r.raw), "secret") {
		t.Fatalf("got %d %s", r.status, r.raw)
	}
	if len(h.events.Events()) != 0 {
		t.Fatalf("a refused write published %v", h.events.Types())
	}
}

// TestHostHooks_TheCallbacksCanReadTheBody: a host field the API ignores
// (attachment ids, say) is still in the body the callbacks read.
func TestHostHooks_TheCallbacksCanReadTheBody(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) {
		c.hostMeta = func(r *http.Request, _ string) (json.RawMessage, error) {
			var body struct {
				Attachments []string `json:"attachments"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				return nil, err
			}
			return json.Marshal(map[string]any{"attachments": body.Attachments})
		}
	})
	line := h.line()
	sent := h.ok(http.StatusAccepted, h.do(http.MethodPost, "/lines/"+line+"/messages", map[string]any{"content": "see", "attachments": []string{"f-1"}}))
	h.dispatcher.Wait()
	meta, _ := field(sent, "userMessage", "hostMeta").(map[string]any)
	if files, _ := meta["attachments"].([]any); len(files) != 1 || files[0] != "f-1" {
		t.Fatalf("hostMeta = %v", meta)
	}
}

// TestHostHooks_BothCallbacksReadTheWholeBody: HostMeta and TxOptions of
// one write each read r.Body to the end and both get every byte (the body
// is put back before each callback).
func TestHostHooks_BothCallbacksReadTheWholeBody(t *testing.T) {
	var mu sync.Mutex
	seen := map[string][]string{}
	record := func(who string, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		mu.Lock()
		defer mu.Unlock()
		seen[who] = append(seen[who], string(raw))
	}
	h := newHarness(t, func(c *harnessConfig) {
		c.hostMeta = func(r *http.Request, op string) (json.RawMessage, error) {
			record("hostMeta", r)
			return nil, nil
		}
		c.txOptions = func(r *http.Request, op string) []tangent.TxOption {
			record("tx", r)
			return nil
		}
	})
	line := h.line()
	mu.Lock()
	seen = map[string][]string{}
	mu.Unlock()
	h.ok(http.StatusAccepted, h.do(http.MethodPost, "/lines/"+line+"/messages", map[string]any{"content": "see", "attachments": []string{"f-1"}}))
	h.dispatcher.Wait()
	mu.Lock()
	defer mu.Unlock()
	for _, who := range []string{"hostMeta", "tx"} {
		if len(seen[who]) == 0 {
			t.Fatalf("%s was not called: %v", who, seen)
		}
		for _, body := range seen[who] {
			if !strings.Contains(body, `"attachments":["f-1"]`) || !strings.Contains(body, `"content":"see"`) {
				t.Fatalf("%s read %q", who, body)
			}
		}
	}
}

// TestHostHooks_AnUpdateReplacesOrKeepsTheHostMeta: lines.update replaces
// the whole object with what the host returns, keeps it when the host
// returns nil, and a host-only change is a change.
func TestHostHooks_AnUpdateReplacesOrKeepsTheHostMeta(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) {
		c.hostMeta = func(r *http.Request, op string) (json.RawMessage, error) {
			if v := r.URL.Query().Get("meta"); v != "" {
				return json.RawMessage(`{"v":"` + v + `"}`), nil
			}
			return nil, nil
		}
	})
	created := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines?meta=1", map[string]any{"title": "main"}))
	line := created["id"].(string)
	kept := h.ok(http.StatusOK, h.do(http.MethodPatch, "/lines/"+line, map[string]any{"title": "renamed"}))
	if meta, _ := kept["hostMeta"].(map[string]any); meta["v"] != "1" || kept["title"] != "renamed" {
		t.Fatalf("a nil host meta changes nothing: %v", kept)
	}
	replaced := h.ok(http.StatusOK, h.do(http.MethodPatch, "/lines/"+line+"?meta=2", map[string]any{}))
	if meta, _ := replaced["hostMeta"].(map[string]any); meta["v"] != "2" || replaced["title"] != "renamed" {
		t.Fatalf("a host-only change: %v", replaced)
	}
	h.wantError(h.do(http.MethodPatch, "/lines/"+line, map[string]any{}), http.StatusBadRequest, "invalid_input")
}
