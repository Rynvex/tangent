package httpapi_test

import (
	"encoding/json"
	"net/http"
	"sort"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// flow walks the whole API once, as tenant A, and records a contract sample
// of every route response and every event type.
type flow struct {
	*harness
	s      *sampler
	main   string
	reply  string
	branch string
}

// call sends a request, checks its status and records the sample.
func (f *flow) call(name string, status int, method, path string, body any, opts ...reqOpt) map[string]any {
	f.t.Helper()
	r := f.do(method, path, body, opts...)
	out := f.ok(status, r)
	f.s.route(name, method, path, body, r)
	return out
}

func TestContract_EveryRouteAndEventAgainstTheSamples(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) {
		// Every delta saves the partial reply, so the pending sample shows
		// content and meta.streamSeq.
		c.engineOpts = append(c.engineOpts, tangent.WithPricing(map[string]tangent.Price{"fake-1": {Input: 1, Output: 2}}),
			tangent.WithPartialFlush(time.Hour, 1), tangent.WithLimits(summaryDueSoon()), tangent.WithModelCatalog(
				tangent.ModelGroup{Provider: "fake", Models: []string{"fake-1"}},
				tangent.ModelGroup{Provider: "anthropic", Models: []string{"claude-haiku-4-5", "claude-sonnet-4-5"}},
			))
	})
	f := &flow{harness: h, s: newSampler(t)}
	f.linesAndTurns()
	f.branchAndCard()
	f.notesAndChapters()
	f.p1()
	f.memos()
	f.endings()
	f.p1b()
	f.p2()
	f.errors()
	f.lifecycle()
	f.variants()
	suggesting := f.p2Suggest()
	f.p2Fisheye()
	grouping := f.p2c()
	folding := f.p3()
	diverging := f.p3b()
	f.b14()
	f.b15Relations()
	f.b17()
	f.b18()
	f.b19()
	f.b20()
	f.b22()
	f.b23()
	f.glossary()
	f.importsAndPins()
	events := append(append(append(append(h.events.Events(), suggesting.events.Events()...), grouping.events.Events()...), folding.events.Events()...), diverging.events.Events()...)
	if tangenttest.ExtensionAvailable(t, tangent.FeatureMemory) {
		events = append(events, f.p3c().events.Events()...)
	} else {
		t.Log("the vector extension is missing: the memory samples are not checked")
		f.s.skipMemorySamples()
	}
	for _, ev := range events {
		f.s.event(ev)
	}
	for _, typ := range []string{
		tangent.EventLineCreated, tangent.EventLineUpdated, tangent.EventLineDeleted, tangent.EventMessageCreated,
		tangent.EventMessageUpdated, tangent.EventMessageDelta, tangent.EventNotesChanged, tangent.EventChaptersChanged,
		tangent.EventTurnRetrying, tangent.EventSuggestionChanged, tangent.EventLeafChanged, tangent.EventSeedsChanged, tangent.EventLinkChanged, tangent.EventSummaryDue,
		tangent.EventGoalChanged, tangent.EventGroupChanged, tangent.EventJobFailed, tangent.EventFoldChanged, tangent.EventComparisonChanged, tangent.EventMemoryChanged,
		tangent.EventMemoChanged, tangent.EventTermsChanged,
	} {
		if !f.s.written["event."+typ] {
			t.Errorf("no %s event was sampled", typ)
		}
	}
	for _, change := range []string{tangent.BranchCreated, tangent.BranchMoved, tangent.BranchPromoted, tangent.BranchDraft, tangent.BranchMerged, tangent.BranchDiscarded, tangent.BranchRenamed, tangent.BranchDetached, tangent.BranchKept} {
		if !f.s.written["event.branch.changed."+change] {
			t.Errorf("no branch.changed %s event was sampled", change)
		}
	}
	f.s.checkComplete()
}

func (f *flow) linesAndTurns() {
	f.call("capabilities", http.StatusOK, http.MethodGet, "/capabilities", nil)
	line := f.call("lines.create", http.StatusCreated, http.MethodPost, "/lines", map[string]any{"title": "Trip planning", "provider": "fake", "model": "fake-1"})
	f.main = line["id"].(string)
	f.call("lines.update", http.StatusOK, http.MethodPatch, "/lines/"+f.main, map[string]any{"title": "Trip to Kyoto"})
	f.runner.Queue(tangenttest.Reply{Chunks: []string{"Kyoto in autumn ", "is lovely."}, Retries: 1, Delay: turnDelay})
	sent := f.call("messages.send", http.StatusAccepted, http.MethodPost, "/lines/"+f.main+"/messages", map[string]any{"content": "When should I go to Kyoto?"})
	f.dispatcher.Wait()
	f.reply = sent["turnId"].(string)
	f.call("stream", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/stream?afterSeq=0", nil)
	f.turn(f.main, "And where should I stay?")
	f.call("messages.list", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/messages?afterSeq=0&limit=50", nil)
	f.call("lines.get", http.StatusOK, http.MethodGet, "/lines/"+f.main, nil)
	f.call("lines.list", http.StatusOK, http.MethodGet, "/lines?limit=10", nil)
	f.call("preview", http.StatusOK, http.MethodPost, "/lines/"+f.main+"/preview", map[string]any{"content": "What about food?"})
	f.call("search", http.StatusOK, http.MethodGet, "/search?q=kyoto&limit=10", nil)
}

func (f *flow) branchAndCard() {
	f.call("branches.preview", http.StatusOK, http.MethodPost, "/lines/"+f.main+"/branches/preview", map[string]any{
		"anchorMessageId": f.reply, "purpose": "Compare ryokan and hotels", "kind": "investigate", "excerpt": "Kyoto in autumn", "includeLater": true,
	})
	created := f.call("branches.create", http.StatusCreated, http.MethodPost, "/lines/"+f.main+"/branches", map[string]any{
		"anchorMessageId": f.reply, "purpose": "Compare ryokan and hotels", "kind": "investigate", "excerpt": "Kyoto in autumn",
	})
	f.branch = field(created, "line", "id").(string)
	f.call("branch.rename", http.StatusOK, http.MethodPatch, "/lines/"+f.branch+"/branch", map[string]any{"purpose": "Compare ryokan and business hotels"})
	f.turn(f.branch, "Is a ryokan worth it?")
	f.call("branches.list", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/branches?includeAside=true", nil)
	f.call("branch.draft", http.StatusAccepted, http.MethodPost, "/lines/"+f.branch+"/branch/draft", nil)
	f.dispatcher.Wait()
	detail := f.call("branch.get", http.StatusOK, http.MethodGet, "/lines/"+f.branch+"/branch", nil)
	card := field(detail, "draft", "card")
	if card == nil {
		f.t.Fatalf("the draft is not ready: %v", detail["draft"])
	}
	f.call("branch.merge", http.StatusOK, http.MethodPost, "/lines/"+f.branch+"/branch/merge", map[string]any{
		"card": card, "parentTipMessageId": detail["parentTipMessageId"],
		"noteChanges": []map[string]any{{"op": "add", "section": "decided", "text": "Stay one night in a ryokan"}},
	})
	f.turn(f.main, "Great, what next?")
}

func (f *flow) notesAndChapters() {
	notes := f.call("notes.list", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/notes", nil)
	if len(notes["notes"].([]any)) != 1 {
		f.t.Fatalf("the merge wrote a note: %v", notes)
	}
	note := f.call("notes.create", http.StatusCreated, http.MethodPost, "/lines/"+f.main+"/notes", map[string]any{"section": "todo", "text": "Book the train"})
	noteID := field(note, "note", "id").(string)
	f.call("notes.update", http.StatusOK, http.MethodPatch, "/lines/"+f.main+"/notes/"+noteID, map[string]any{"status": "done"})
	f.call("notes.supersede", http.StatusCreated, http.MethodPost, "/lines/"+f.main+"/notes/"+noteID+"/supersede", map[string]any{"text": "Book the 9:00 train"})
	added := f.call("chapters.milestones.add", http.StatusCreated, http.MethodPost, "/lines/"+f.main+"/chapters/milestones", map[string]any{"messageId": f.reply, "title": "Planning"})
	f.call("chapters.list", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/chapters", nil)
	f.call("chapters.milestones.delete", http.StatusNoContent, http.MethodDelete, "/lines/"+f.main+"/chapters/milestones/"+field(added, "milestone", "id").(string), nil)
	f.call("compact", http.StatusAccepted, http.MethodPost, "/lines/"+f.main+"/compact", nil)
	f.dispatcher.Wait()
}

func (f *flow) endings() {
	discard := f.branch2("Look at Osaka instead")
	f.call("branch.discard", http.StatusOK, http.MethodPost, "/lines/"+discard+"/branch/discard", nil)
	promote := f.branch2("Go in spring instead")
	f.turn(promote, "Cherry blossoms?")
	f.call("branch.promote", http.StatusOK, http.MethodPost, "/lines/"+promote+"/branch/promote", map[string]any{"confirm": true})
	f.turn(f.main, "Spring it is. Which week?")
	f.call("branches.move", http.StatusCreated, http.MethodPost, "/lines/"+f.main+"/branches/move", map[string]any{"count": 2, "purpose": "Pick the week"})
	f.runner.Queue(tangenttest.Reply{Content: "slow", Delay: time.Minute})
	f.ok(http.StatusAccepted, f.do(http.MethodPost, "/lines/"+f.main+"/messages", map[string]any{"content": "Never mind"}))
	f.call("cancel", http.StatusOK, http.MethodPost, "/lines/"+f.main+"/cancel", nil)
	f.dispatcher.Wait()
}

// branch2 opens a branch on the first reply of the main line.
func (f *flow) branch2(purpose string) string {
	f.t.Helper()
	return f.harness.branch(f.main, f.firstReply(), purpose)
}

// firstReply is the newest finished assistant message of the main line
// that is still on it (the original anchor may have moved).
func (f *flow) firstReply() string {
	f.t.Helper()
	page := f.ok(http.StatusOK, f.do(http.MethodGet, "/lines/"+f.main+"/messages", nil))
	for _, m := range page["messages"].([]any) {
		msg := m.(map[string]any)
		if msg["role"] == "assistant" && msg["status"] == "done" {
			return msg["id"].(string)
		}
	}
	f.t.Fatal("no finished reply on the main line")
	return ""
}

func (f *flow) errors() {
	r := f.do(http.MethodGet, "/lines/00000000-0000-4000-8000-000000000999", nil)
	f.wantError(r, http.StatusNotFound, "line_not_found")
	f.s.route("error.line_not_found", http.MethodGet, "/lines/00000000-0000-4000-8000-000000000999", nil, r)
	branch := f.branch2("Check the budget")
	body := map[string]any{"card": map[string]any{"question": "", "conclusion": "x", "extra": 1}, "parentTipMessageId": f.reply}
	r = f.do(http.MethodPost, "/lines/"+branch+"/branch/merge", body)
	f.wantError(r, http.StatusUnprocessableEntity, "invalid_card")
	f.s.route("error.invalid_card", http.MethodPost, "/lines/"+branch+"/branch/merge", body, r)
}

func (f *flow) lifecycle() {
	f.call("lines.read", http.StatusOK, http.MethodPost, "/lines/"+f.main+"/read", nil)
	for _, op := range []string{"archive", "unarchive"} {
		path := "/lines/" + f.main + "/" + op
		r := f.do(http.MethodPost, path, nil)
		f.ok(http.StatusOK, r)
		f.s.route("lines."+op, http.MethodPost, path, nil, branchesByTitle(f.t, r))
	}
	f.call("lines.delete", http.StatusOK, http.MethodDelete, "/lines/"+f.main, nil)
}

// branchesByTitle orders the branch lines after the main line by title: the
// store returns them in id order, which differs from run to run.
func branchesByTitle(t *testing.T, r response) response {
	t.Helper()
	var body struct {
		Lines []map[string]any `json:"lines"`
	}
	if err := json.Unmarshal(r.raw, &body); err != nil || len(body.Lines) == 0 {
		t.Fatalf("lines body %s: %v", r.raw, err)
	}
	rest := body.Lines[1:]
	sort.SliceStable(rest, func(i, j int) bool { return rest[i]["title"].(string) < rest[j]["title"].(string) })
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r.raw = raw
	return r
}

// summaryDueSoon makes a summary due after a few turns, so the flow sees
// summary.due (summary is in suggest mode).
func summaryDueSoon() domain.Limits {
	limits := domain.DefaultLimits()
	limits.History.SummaryTriggerTokens = 20
	return limits
}
