package httpapi_test

import (
	"encoding/json"
	"net/http"
	"slices"
	"sync"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// operatorOnly is a host's delta filter: read-only readers never see tool
// input and see reasoning only as a placeholder. It records the lines it
// was asked about.
type operatorOnly struct {
	mu    sync.Mutex
	lines []string
}

func (f *operatorOnly) filter(r *http.Request, lineID string, d domain.Delta) (domain.Delta, bool) {
	f.mu.Lock()
	f.lines = append(f.lines, lineID)
	f.mu.Unlock()
	if r.Header.Get(headerReadOnly) == "" {
		return d, true
	}
	switch d.Kind {
	case domain.DeltaTool:
		return d, false
	case domain.DeltaReasoning:
		// The filter cannot renumber or re-attribute a delta.
		return domain.Delta{TurnID: "forged", Seq: 1, Kind: d.Kind, Text: "[hidden]"}, true
	}
	return d, true
}

// nextDeltas reads events until n message.delta events arrived.
func (s *subscription) nextDeltas(t *testing.T, n int) []domain.Delta {
	t.Helper()
	out := []domain.Delta{}
	for len(out) < n {
		ev := s.next(t)
		if ev.name != tangent.EventMessageDelta {
			continue
		}
		var envelope struct {
			LineID string       `json:"lineId"`
			Data   domain.Delta `json:"data"`
		}
		if err := json.Unmarshal([]byte(ev.data), &envelope); err != nil {
			t.Fatal(err)
		}
		out = append(out, envelope.Data)
	}
	return out
}

func kindsAndTexts(deltas []domain.Delta) []string {
	out := []string{}
	for _, d := range deltas {
		out = append(out, d.Kind+":"+d.Text)
	}
	return out
}

func TestDeltaFilter_TheStreamAndTheEventsFollowTheReader(t *testing.T) {
	f := &operatorOnly{}
	h := newHarness(t, func(c *harnessConfig) { c.deltaFilter = f.filter })
	line := h.line()
	writer, reader := h.subscribe(tenantA), h.subscribe(tenantA, readOnly())
	writer.comment(t, "connected")
	reader.comment(t, "connected")
	turn, err := h.engine.BeginTurn(h.ctx, tangent.Scope{Tenant: tenantA, Actor: actor}, line, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range []domain.Delta{
		{Kind: domain.DeltaText, Text: "Hello."},
		{Kind: domain.DeltaReasoning, Text: "think"},
		{Kind: domain.DeltaTool, Text: `{"rawInput":{"command":"cat ~/.ssh/id_rsa"}}`},
		{Kind: domain.DeltaReasoning, Text: "after"},
	} {
		if err := h.engine.AppendDelta(h.ctx, turn.ID, d); err != nil {
			t.Fatal(err)
		}
	}
	all := []string{"text:Hello.", "reasoning:think", `tool:{"rawInput":{"command":"cat ~/.ssh/id_rsa"}}`, "reasoning:after"}
	filtered := []string{"text:Hello.", "reasoning:[hidden]", "reasoning:[hidden]"}

	raw := writer.nextDeltas(t, 4)
	if got := kindsAndTexts(raw); !slices.Equal(got, all) {
		t.Fatalf("operator events %v, want %v", got, all)
	}
	seen := reader.nextDeltas(t, 3)
	if got := kindsAndTexts(seen); !slices.Equal(got, filtered) {
		t.Fatalf("read-only events %v, want %v", got, filtered)
	}
	if seen[1].Seq != raw[1].Seq || seen[1].TurnID != turn.ID || seen[2].Seq != raw[3].Seq {
		t.Fatalf("seq and turn id must stay: %+v vs %+v", seen, raw)
	}

	var full, partial struct {
		Deltas    []domain.Delta `json:"deltas"`
		Seq       int64          `json:"seq"`
		Truncated bool           `json:"truncated"`
	}
	decode := func(r response, into any) {
		t.Helper()
		if r.status != http.StatusOK {
			t.Fatalf("stream: %d %s", r.status, r.raw)
		}
		if err := json.Unmarshal(r.raw, into); err != nil {
			t.Fatal(err)
		}
	}
	decode(h.do(http.MethodGet, "/lines/"+line+"/stream", nil), &full)
	decode(h.do(http.MethodGet, "/lines/"+line+"/stream", nil, readOnly()), &partial)
	if got := kindsAndTexts(full.Deltas); !slices.Equal(got, all) {
		t.Fatalf("operator stream %v", got)
	}
	if got := kindsAndTexts(partial.Deltas); !slices.Equal(got, filtered) || partial.Deltas[1].Seq != full.Deltas[1].Seq {
		t.Fatalf("read-only stream %+v", partial.Deltas)
	}
	if partial.Seq != full.Seq || partial.Truncated {
		t.Fatalf("the cursor is the line's newest seq for every reader: %d vs %d (truncated %v)", partial.Seq, full.Seq, partial.Truncated)
	}
	// A reader resuming after the dropped tool delta is not truncated.
	decode(h.do(http.MethodGet, "/lines/"+line+"/stream?afterSeq="+jsonInt(raw[2].Seq), nil, readOnly()), &partial)
	if got := kindsAndTexts(partial.Deltas); partial.Truncated || !slices.Equal(got, []string{"reasoning:[hidden]"}) {
		t.Fatalf("resumed stream %+v", partial)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, id := range f.lines {
		if id != line {
			t.Fatalf("the filter was asked about line %q, want %q", id, line)
		}
	}
}

func TestDeltaFilter_WithoutOneEveryReaderGetsEveryDelta(t *testing.T) {
	h := newHarness(t)
	line := h.line()
	reader := h.subscribe(tenantA, readOnly())
	reader.comment(t, "connected")
	turn, err := h.engine.BeginTurn(h.ctx, tangent.Scope{Tenant: tenantA, Actor: actor}, line, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.engine.AppendDelta(h.ctx, turn.ID, domain.Delta{Kind: domain.DeltaTool, Text: "tool input"}); err != nil {
		t.Fatal(err)
	}
	if got := kindsAndTexts(reader.nextDeltas(t, 1)); !slices.Equal(got, []string{"tool:tool input"}) {
		t.Fatalf("events %v", got)
	}
	body := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+line+"/stream", nil, readOnly()))
	if deltas, _ := body["deltas"].([]any); len(deltas) != 1 {
		t.Fatalf("stream %v", body)
	}
}

func jsonInt(n int64) string {
	raw, _ := json.Marshal(n)
	return string(raw)
}
