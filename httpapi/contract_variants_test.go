package httpapi_test

import (
	"net/http"
	"strings"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/tangenttest"
)

// variants records samples whose fields carry non-zero values (so a
// renamed field cannot hide behind a default), the states a turn goes
// through, and the error answers a client must tell apart.
func (f *flow) variants() {
	main := f.call("lines.create.rich", http.StatusCreated, http.MethodPost, "/lines", map[string]any{"title": "Rich", "provider": "fake", "model": "fake-1"})["id"].(string)
	f.runner.Queue(tangenttest.Reply{
		Chunks: []string{"Plan the route. "}, Delay: turnDelay,
		Usage: domain.Usage{InputTokens: 1200, OutputTokens: 80, CacheReadTokens: 1000, CacheWriteTokens: 100},
	})
	reply := f.turn(main, "Plan the route [fake:suggest]")
	f.turn(main, "Anything else? [fake:suggest]")
	ready := f.harness.branch(main, reply, "Rail passes")
	f.turn(ready, "Is the JR pass worth it?")
	f.ok(http.StatusAccepted, f.do(http.MethodPost, "/lines/"+ready+"/branch/draft", nil))
	merged := f.harness.branch(main, reply, "Budget")
	f.turn(merged, "How much per day?")
	f.ok(http.StatusAccepted, f.do(http.MethodPost, "/lines/"+merged+"/branch/draft", nil))
	f.dispatcher.Wait()
	detail := f.ok(http.StatusOK, f.do(http.MethodGet, "/lines/"+merged+"/branch", nil))
	f.ok(http.StatusOK, f.do(http.MethodPost, "/lines/"+merged+"/branch/merge", map[string]any{
		"card": detail["draft"].(map[string]any)["card"], "parentTipMessageId": detail["parentTipMessageId"],
		"noteChanges": []map[string]any{{"op": "add", "section": "to_confirm", "text": "Daily budget", "sourceMessageId": reply}},
	}))
	f.turn(main, "Thanks, noted.")
	f.runner.Queue(tangenttest.Reply{Err: tangenttest.ErrFake, Delay: turnDelay})
	f.turn(main, "This one fails")
	f.call("messages.list.rich", http.StatusOK, http.MethodGet, "/lines/"+main+"/messages?limit=100", nil)
	f.call("lines.get.rich", http.StatusOK, http.MethodGet, "/lines/"+main, nil)
	f.call("branches.list.rich", http.StatusOK, http.MethodGet, "/lines/"+main+"/branches", nil)
	f.call("branch.get.ready", http.StatusOK, http.MethodGet, "/lines/"+ready+"/branch", nil)
	f.call("notes.list.rich", http.StatusOK, http.MethodGet, "/lines/"+main+"/notes", nil)
	f.call("retry", http.StatusAccepted, http.MethodPost, "/lines/"+main+"/retry", nil)
	f.dispatcher.Wait()
	f.midTurn(main)
	f.errorVariants(main, reply)
	f.call("capabilities.viewer", http.StatusOK, http.MethodGet, "/capabilities", nil, readOnly())
}

// midTurn samples a turn while it streams: the pending message, the delta
// tail, a truncated tail and the refusal of a second turn.
func (f *flow) midTurn(main string) {
	f.runner.Queue(tangenttest.Reply{Chunks: []string{"Half of ", "the answer"}, Delay: time.Minute})
	turnID := f.ok(http.StatusAccepted, f.do(http.MethodPost, "/lines/"+main+"/messages", map[string]any{"content": "Slow question"}))["turnId"]
	waitFor(f.t, func() bool {
		deltas := f.ok(http.StatusOK, f.do(http.MethodGet, "/lines/"+main+"/stream?afterSeq=0", nil))["deltas"].([]any)
		last := deltas[len(deltas)-1].(map[string]any)
		if last["turnId"] != turnID || !strings.HasSuffix(last["text"].(string), "the answer") {
			return false
		}
		messages := f.ok(http.StatusOK, f.do(http.MethodGet, "/lines/"+main+"/messages?limit=100", nil))["messages"].([]any)
		return messages[len(messages)-1].(map[string]any)["content"] == "Half of the answer"
	})
	f.call("messages.list.pending", http.StatusOK, http.MethodGet, "/lines/"+main+"/messages?limit=100", nil)
	f.call("stream.midturn", http.StatusOK, http.MethodGet, "/lines/"+main+"/stream?afterSeq=0", nil)
	f.call("stream.truncated", http.StatusOK, http.MethodGet, "/lines/"+main+"/stream?afterSeq=1", nil)
	f.fail("error.turn_pending", http.StatusConflict, http.MethodPost, "/lines/"+main+"/messages", map[string]any{"content": "Again"})
	f.ok(http.StatusOK, f.do(http.MethodPost, "/lines/"+main+"/cancel", nil))
	f.dispatcher.Wait()
}

// errorVariants samples error answers with their extra fields.
func (f *flow) errorVariants(main, reply string) {
	r := f.do(http.MethodPost, "/lines", map[string]any{"title": "x"}, readOnly())
	f.wantError(r, http.StatusForbidden, "forbidden")
	f.s.route("error.forbidden", http.MethodPost, "/lines", map[string]any{"title": "x"}, r)
	r = f.do(http.MethodPost, "/lines", `{"title":"x"}`, contentType("text/plain"))
	f.wantError(r, http.StatusUnsupportedMediaType, "unsupported_media_type")
	f.s.route("error.unsupported_media_type", http.MethodPost, "/lines", `{"title":"x"}`, r)
	f.fail("error.too_long", http.StatusUnprocessableEntity, http.MethodPost, "/lines", map[string]any{"title": strings.Repeat("t", 201)})
	f.fail("error.nothing_to_retry", http.StatusConflict, http.MethodPost, "/lines/"+main+"/retry", nil)
	branch := f.harness.branch(main, reply, "Late branch")
	f.turn(branch, "q")
	tip := f.ok(http.StatusOK, f.do(http.MethodGet, "/lines/"+branch+"/branch", nil))["parentTipMessageId"]
	f.turn(main, "The main line moves on")
	f.fail("error.parent_moved", http.StatusConflict, http.MethodPost, "/lines/"+branch+"/branch/merge", map[string]any{
		"card": map[string]any{"question": "q", "conclusion": "c"}, "parentTipMessageId": tip,
	})
	f.s.write("event.stream.lagged", httpapi.LaggedEvent(tenantA, 3))
}

// fail sends a request that must fail with status and records it.
func (f *flow) fail(name string, status int, method, path string, body any) {
	f.t.Helper()
	r := f.do(method, path, body)
	if r.status != status {
		f.t.Fatalf("%s: %d %s", name, r.status, r.raw)
	}
	f.s.route(name, method, path, body, r)
}
