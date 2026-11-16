package main

import (
	"encoding/json"
	"net/http"
	"runtime"
)

// serverStats is GET /debug/stats: what a soak run watches for leaks.
type serverStats struct {
	Goroutines int         `json:"goroutines"`
	Memory     memoryStats `json:"memory"`
	Pool       poolStats   `json:"pool"`
	// Streams is the number of open /events clients; InFlight the turns and
	// jobs the dispatcher holds (running or waiting for a slot).
	Streams  int `json:"streams"`
	InFlight int `json:"inFlight"`
}

type memoryStats struct {
	HeapAlloc   uint64 `json:"heapAllocBytes"`
	HeapObjects uint64 `json:"heapObjects"`
	Sys         uint64 `json:"sysBytes"`
	NumGC       uint32 `json:"numGC"`
}

type poolStats struct {
	Total        int32 `json:"totalConns"`
	Idle         int32 `json:"idleConns"`
	Acquired     int32 `json:"acquiredConns"`
	Constructing int32 `json:"constructingConns"`
	Max          int32 `json:"maxConns"`
	Acquires     int64 `json:"acquireCount"`
}

// stats answers the counters; only mounted with TANGENT_DEBUG_STATS=1.
// ?gc=1 collects garbage first, so heap numbers compare across samples.
func (a *app) stats(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("gc") == "1" {
		runtime.GC()
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	pool := a.pool.Stat()
	body := serverStats{
		Goroutines: runtime.NumGoroutine(),
		Memory:     memoryStats{HeapAlloc: mem.HeapAlloc, HeapObjects: mem.HeapObjects, Sys: mem.Sys, NumGC: mem.NumGC},
		Pool: poolStats{
			Total: pool.TotalConns(), Idle: pool.IdleConns(), Acquired: pool.AcquiredConns(), Constructing: pool.ConstructingConns(),
			Max: pool.MaxConns(), Acquires: pool.AcquireCount(),
		},
		Streams: a.hub.Clients(), InFlight: a.dispatcher.InFlight(),
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(body)
}
