package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestInvariants_EndedBranchesStayEnded(t *testing.T) {
	v := newInvariants()
	v.observeBranches([]branchView{{LineID: "a", Status: "open"}, {LineID: "b", Status: "merged"}})
	v.observeBranches([]branchView{{LineID: "a", Status: "discarded"}, {LineID: "b", Status: "merged"}})
	if got := v.list(); len(got) != 0 {
		t.Fatalf("legal moves: %v", got)
	}
	v.observeBranches([]branchView{{LineID: "a", Status: "open"}, {LineID: "b", Status: "promoted"}})
	if got := v.list(); len(got) != 2 || !strings.Contains(got[0], "discarded to open") {
		t.Fatalf("reversals: %v", got)
	}
}

func TestInvariants_MessagesAndDeltas(t *testing.T) {
	if err := checkMessages([]message{{Seq: 1}, {Seq: 3, Status: "pending"}}); err != nil {
		t.Fatal(err)
	}
	if err := checkMessages([]message{{Seq: 2}, {Seq: 2}}); err == nil {
		t.Fatal("equal seqs")
	}
	if err := checkMessages([]message{{Seq: 1, Status: "pending"}, {Seq: 2, Status: "pending"}}); err == nil {
		t.Fatal("two pending")
	}
	v := newInvariants()
	v.observeMessages("l", []message{{Seq: 5}, {Seq: 4}})
	v.observeDelta("t", 1)
	v.observeDelta("t", 2)
	v.observeDelta("t", 2)
	if got := v.list(); len(got) != 2 {
		t.Fatalf("violations %v", got)
	}
	for i := range maxViolations + 5 {
		v.violate("n %d", i)
	}
	if len(v.list()) != maxViolations {
		t.Fatal("the report is bounded")
	}
}

func TestCounters_ClassifyRefusals(t *testing.T) {
	c := newCounters()
	if !c.classify("x", nil) || !c.classify("x", &apiError{Status: 409, Code: "turn_pending"}) || !c.classify("x", context.Canceled) || !c.classify("x", errStopped) {
		t.Fatal("expected outcomes")
	}
	if c.classify("x", &apiError{Status: 422, Code: "invalid_card"}) || c.classify("x", errors.New("boom")) {
		t.Fatal("unexpected outcomes")
	}
	c.refusal("GET /x", &apiError{Status: 500, Code: "internal"})
	c.refusal("GET /x", &apiError{Status: 503, Code: "unavailable"})
	c.transport("GET /x")
	if c.outcomes["unexpected"] != 2 || len(c.failures) != 3 || c.refusals["500 internal"] != 1 {
		t.Fatalf("counters %+v %v", c.outcomes, c.failures)
	}
	if fmt.Sprint(routeOf("/lines/7c5de9b4-5d74-499f-84f6-b49cb135f356/messages?limit=5")) != "/lines/{id}/messages" {
		t.Fatalf("route %s", routeOf("/lines/7c5de9b4-5d74-499f-84f6-b49cb135f356/messages?limit=5"))
	}
}

func TestCounters_TallyEveryOperation(t *testing.T) {
	c := newCounters()
	c.classify("seed drop", nil)
	c.classify("seed drop", &apiError{Status: 409, Code: "seed_not_open"}, "seed_not_open")
	c.classify("seed drop", &apiError{Status: 409, Code: "fold_overlap"})
	c.op("deep dive", "ok")
	c.fail("pin", "not pinned")
	want := map[string]int{"ok": 1, "refused seed_not_open": 1, "unexpected": 1}
	if fmt.Sprint(c.ops["seed drop"]) != fmt.Sprint(want) || c.ops["deep dive"]["ok"] != 1 || c.ops["pin"]["failed"] != 1 || len(c.failures) != 2 {
		t.Fatalf("ops %v failures %v", c.ops, c.failures)
	}
	if got := missingOperations(c.ops, []string{"seed drop", "pin", "deep dive", "memory create"}); fmt.Sprint(got) != "[pin memory create]" {
		t.Fatalf("missing %v", got)
	}
}

func TestRequiredOperations_FollowTheFeatures(t *testing.T) {
	core := requiredOperations(features{})
	if !slices.Contains(core, "send") || slices.Contains(core, "seed create") {
		t.Fatalf("core %v", core)
	}
	full := requiredOperations(features{"parking": "on", "notes": "on", "fold": "auto", "fisheye": "on", "ibis": "suggest"})
	for _, op := range []string{"seed to-note", "fold with fisheye", "tag confirm ai draft", "fisheye preview"} {
		if !slices.Contains(full, op) {
			t.Fatalf("%s missing from %v", op, full)
		}
	}
	if slices.Contains(requiredOperations(features{"ibis": "auto"}), "tag confirm ai draft") {
		t.Fatal("auto tags have no drafts to confirm")
	}
}

func TestResourceChecks_CompareTheEndWithTheStart(t *testing.T) {
	at := func(goroutines, inFlight int, heap int64) sample {
		return sample{Server: json.RawMessage(fmt.Sprintf(`{"goroutines":%d,"inFlight":%d,"memory":{"heapAllocBytes":%d}}`, goroutines, inFlight, heap))}
	}
	if got := resourceChecks([]sample{at(8, 0, 1<<20), at(17, 4, 9<<20), at(12, 0, 3<<20)}); got["goroutinesAboveStart"]+got["heapAboveStartMB"]+got["inFlightAtEnd"] != 0 {
		t.Fatalf("back near the start: %v", got)
	}
	got := resourceChecks([]sample{at(8, 0, 1<<20), at(40, 2, 100<<20)})
	if got["goroutinesAboveStart"] != 22 || got["heapAboveStartMB"] != 67 || got["inFlightAtEnd"] != 2 {
		t.Fatalf("leaks: %v", got)
	}
	if got := resourceChecks([]sample{at(8, 0, 0)}); got["goroutinesAboveStart"] != 1 {
		t.Fatalf("one sample: %v", got)
	}
}

func TestJSONObject_IsWhatA2xxBodyMustBe(t *testing.T) {
	for raw, want := range map[string]bool{`{"a":1}`: true, " {}\n": true, `[]`: false, `null`: false, `{"a":`: false, ``: false} {
		if jsonObject([]byte(raw)) != want {
			t.Fatalf("%q: want %v", raw, want)
		}
	}
}
