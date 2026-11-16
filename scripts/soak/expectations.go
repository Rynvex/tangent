package main

import (
	"encoding/json"
	"slices"
)

// requiredByFeature are the operations a full run must have done with
// success at least once, by the feature they need ("" = core).
var requiredByFeature = map[string][]string{
	"":            {"send", "branch", "merge", "discard", "promote", "move", "pin", "unpin", "delete"},
	"suggestions": {"list suggestions", "dismiss suggestion"},
	"leaf":        {"leaf put", "leaf delete", "leaf draft"},
	"parking":     {"seed create", "seed expand", "seed drop"},
	"spinoff":     {"spinoff fresh", "spinoff detach", "spinoff preview"},
	"rebalance":   {"deep dive", "accept promote_or_spinoff"},
	"goal":        {"goal put", "goal delete", "goal propose"},
	"relations":   {"relation create", "relation label", "relation delete"},
	"open_loops":  {"open loops"},
	"group":       {"group create", "group rename", "group summarize", "group dissolve", "combine"},
	"fisheye":     {"fisheye preview"},
	"ibis":        {"tag set", "tag change", "tag clear"},
	"fold":        {"fold create", "fold create drafting", "fold edit", "fold delete"},
	"diverge":     {"diverge", "converge", "decide"},
	"memory":      {"memory create", "memory list", "memory search", "memory recall", "memory update", "memory supersede", "accept memory"},
}

// requiredOperations lists what a run with these features must have done.
// Some need two features or a mode: notes for seed to-note, fisheye with
// fold, a suggest-mode ibis for confirming the AI's drafts.
func requiredOperations(f features) []string {
	out := []string{}
	for feature, ops := range requiredByFeature {
		if feature == "" || f.on(feature) {
			out = append(out, ops...)
		}
	}
	if f.on("parking") && f.on("notes") {
		out = append(out, "seed to-note")
	}
	if f.on("fold") && f.on("fisheye") {
		out = append(out, "fold with fisheye")
	}
	if f["ibis"] == "suggest" {
		out = append(out, "tag confirm ai draft")
	}
	slices.Sort(out)
	return out
}

// Resource tolerances between the first and the last sample (the last is
// taken once the server is quiet).
const (
	// goroutineSlack covers the driver's keep-alive connections.
	goroutineSlack = 10
	// heapSlackBytes covers caches that are bounded but not empty.
	heapSlackBytes = 32 << 20
)

// serverSample is what the driver reads of /debug/stats.
type serverSample struct {
	Goroutines int `json:"goroutines"`
	InFlight   int `json:"inFlight"`
	Memory     struct {
		HeapAlloc int64 `json:"heapAllocBytes"`
	} `json:"memory"`
}

// resourceChecks compare the end with the start: goroutines and heap back
// near the start, nothing held by the dispatcher. Each counts the excess
// (0 passes); a missing sample counts 1.
func resourceChecks(samples []sample) map[string]int {
	checks := map[string]int{"goroutinesAboveStart": 1, "heapAboveStartMB": 1, "inFlightAtEnd": 1}
	if len(samples) < 2 {
		return checks
	}
	var start, end serverSample
	if json.Unmarshal(samples[0].Server, &start) != nil || json.Unmarshal(samples[len(samples)-1].Server, &end) != nil {
		return checks
	}
	checks["goroutinesAboveStart"] = max(0, end.Goroutines-start.Goroutines-goroutineSlack)
	checks["heapAboveStartMB"] = int(max(0, end.Memory.HeapAlloc-start.Memory.HeapAlloc-heapSlackBytes) >> 20)
	if excess := end.Memory.HeapAlloc - start.Memory.HeapAlloc - heapSlackBytes; excess > 0 && checks["heapAboveStartMB"] == 0 {
		checks["heapAboveStartMB"] = 1
	}
	checks["inFlightAtEnd"] = end.InFlight
	return checks
}
