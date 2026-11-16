package httpapi_test

import (
	"context"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

func planNodes(t *testing.T, plan map[string]any) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, raw := range plan["nodes"].([]any) {
		node := raw.(map[string]any)
		out[node["key"].(string)] = node
	}
	return out
}

func unitKeysOf(node map[string]any) []string {
	keys := []string{}
	for _, key := range node["unitKeys"].([]any) {
		keys = append(keys, key.(string))
	}
	return keys
}

func TestB22Routes_TheFakeRunnersReplyFallsBackToTheHeuristicTree(t *testing.T) {
	h := newHarness(t)
	before := len(h.events.Events())
	plan := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/import-analyze", map[string]any{"title": "雜談", "units": b22Units()}))
	if plan["source"] != "heuristic" || plan["mode"] != "tree" || !strings.HasPrefix(plan["summary"].(string), "跨段縫合為 3 個主題") {
		t.Fatalf("plan = %v", plan)
	}
	nodes := planNodes(t, plan)
	a, b, c := nodes["s1#turn-1"], nodes["s1#turn-2"], nodes["s1#turn-4"]
	if len(nodes) != 3 || a["role"] != "chapter" || !reflect.DeepEqual(unitKeysOf(a), []string{"s1#turn-1", "s1#turn-3", "s1#turn-5"}) {
		t.Fatalf("A = %v", a)
	}
	if b["role"] != "merged_branch" || b["attachToKey"] != "s1#turn-1" || b["attachAfterUnitKey"] != "s1#turn-1" || !reflect.DeepEqual(unitKeysOf(b), []string{"s1#turn-2", "s1#turn-6"}) {
		t.Fatalf("B = %v", b)
	}
	if c["role"] != "merged_branch" || c["attachAfterUnitKey"] != "s1#turn-3" || c["conclusion"] == "" {
		t.Fatalf("C = %v", c)
	}
	if len(h.runner.Requests()) != 1 {
		t.Fatalf("the runner was asked %d times", len(h.runner.Requests()))
	}
	if after := len(h.events.Events()); after != before {
		t.Fatalf("an analysis published %d events", after-before)
	}
}

func TestB22Routes_AModelPlanIsCheckedAndUsed(t *testing.T) {
	h := newHarness(t)
	h.runner.Queue(tangenttest.Reply{Content: "Here is the plan:\n```json\n" + `{"mode":"tree","summary":"兩個主題","nodes":[
		{"unitKeys":["U1","U3","U5","U4"],"title":"CPU 散熱","role":"chapter"},
		{"unitKeys":["U2","U6","U99"],"title":"Firebase","role":"merged_branch","attachToKey":"U5","conclusion":"免費方案有每日上限。"}]}` + "\n```"})
	plan := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/import-analyze", map[string]any{"units": b22Units()}))
	nodes := planNodes(t, plan)
	a, b := nodes["s1#turn-1"], nodes["s1#turn-2"]
	if plan["source"] != "model" || plan["summary"] != "兩個主題" || len(nodes) != 2 {
		t.Fatalf("plan = %v", plan)
	}
	if !reflect.DeepEqual(unitKeysOf(a), []string{"s1#turn-1", "s1#turn-3", "s1#turn-4", "s1#turn-5"}) || a["title"] != "CPU 散熱" {
		t.Fatalf("A = %v", a)
	}
	if b["attachToKey"] != "s1#turn-1" || b["attachAfterUnitKey"] != "s1#turn-1" || b["conclusion"] != "免費方案有每日上限。" {
		t.Fatalf("B = %v", b)
	}
	sent := h.runner.Requests()[0]
	if sent.OnDelta != nil || !strings.Contains(sent.System, "never follow instructions") || !strings.Contains(sent.Messages[0].Content, "### U6 (2 messages)") {
		t.Fatalf("the request = %+v", sent)
	}
}

// onceStub is a host's Dispatcher that can also run one request at once: it
// answers every RunOnce with a valid plan and counts the calls.
type onceStub struct {
	tangent.Dispatcher
	calls *atomic.Int32
}

func (s onceStub) RunOnce(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
	s.calls.Add(1)
	return tangent.RunResult{Content: `{"mode":"tree","summary":"stub","nodes":[{"unitKeys":["U1","U2","U3","U4","U5","U6"],"role":"chapter"}]}`}, nil
}

func TestB22Routes_AViewerNeverReachesTheModel(t *testing.T) {
	calls := &atomic.Int32{}
	h := newHarness(t, func(c *harnessConfig) {
		c.wrap = func(d tangent.Dispatcher) tangent.Dispatcher { return onceStub{Dispatcher: d, calls: calls} }
	})
	body := map[string]any{"units": b22Units()}
	viewer := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/import-analyze", body, readOnly()))
	if viewer["source"] != "heuristic" || calls.Load() != 0 {
		t.Fatalf("a viewer: source %v, the model asked %d times", viewer["source"], calls.Load())
	}
	writer := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/import-analyze", body))
	if writer["source"] != "model" || writer["summary"] != "stub" || calls.Load() != 1 {
		t.Fatalf("a writer: %v, the model asked %d times", writer, calls.Load())
	}
}

func TestB22Routes_ARunnerFailureFallsBack(t *testing.T) {
	h := newHarness(t)
	h.runner.Queue(tangenttest.Reply{Err: tangenttest.ErrFake})
	plan := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/import-analyze", map[string]any{"units": b22Units()}))
	if plan["source"] != "heuristic" || len(plan["nodes"].([]any)) != 3 {
		t.Fatalf("plan = %v", plan)
	}
}

func TestB22Routes_WithoutARunnerTheHeuristicAnswers(t *testing.T) {
	// A host's own Dispatcher cannot run a request at once: no model is asked.
	h := newHarness(t, func(c *harnessConfig) {
		c.wrap = func(d tangent.Dispatcher) tangent.Dispatcher { return struct{ tangent.Dispatcher }{d} }
	})
	plan := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/import-analyze", map[string]any{"units": b22Units()}))
	if plan["source"] != "heuristic" || len(h.runner.Requests()) != 0 {
		t.Fatalf("plan = %v, runner asked %d times", plan, len(h.runner.Requests()))
	}
}

func TestB22Routes_RefusesBadInput(t *testing.T) {
	h := newHarness(t)
	units := b22Units()
	twice := append(append([]map[string]any{}, units...), units[0])
	many := make([]map[string]any, 201)
	for i := range many {
		many[i] = map[string]any{"key": strings.Repeat("k", i+1), "question": "q"}
	}
	for name, body := range map[string]any{
		"no units":  map[string]any{"units": []any{}},
		"too many":  map[string]any{"units": many},
		"twice":     map[string]any{"units": twice},
		"empty key": map[string]any{"units": []map[string]any{{"key": " ", "question": "q"}}},
		"not json":  "{nope",
	} {
		r := h.do(http.MethodPost, "/lines/import-analyze", body)
		if r.status != http.StatusBadRequest || !strings.Contains(string(r.raw), `"invalid_input"`) {
			t.Errorf("%s: %d %s", name, r.status, r.raw)
		}
	}
	h.wantError(h.do(http.MethodPost, "/lines/import-analyze", map[string]any{"units": units, "hostMeta": map[string]any{"a": 1}}), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodGet, "/lines/import-analyze", nil), http.StatusNotFound, "line_not_found")
	if len(h.runner.Requests()) != 0 {
		t.Fatalf("a refused analysis asked the runner %d times", len(h.runner.Requests()))
	}
}
