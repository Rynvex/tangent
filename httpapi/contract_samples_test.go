package httpapi_test

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// update rewrites the contract samples: go test ./httpapi -update
var update = flag.Bool("update", false, "rewrite httpapi/testdata/contract")

const contractDir = "testdata/contract"

// serverSamples are written by cmd/tangent-server (its gate's answers:
// go test ./cmd/tangent-server -update); this package does not check them.
var serverSamples = map[string]bool{"route.error.unauthorized": true, "route.error.rate_limited": true}

var (
	uuidPattern = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	// minutePattern is a chapter title taken from its start time.
	minutePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$`)
	// fixedTime stands for every timestamp in a sample.
	fixedTime = "2026-01-01T00:00:00Z"
)

// sampler writes (with -update) or checks the contract samples: one file
// per route response and per event type, with ids, times and other
// run-dependent values replaced by stable placeholders.
type sampler struct {
	t       *testing.T
	written map[string]bool
}

func newSampler(t *testing.T) *sampler {
	return &sampler{t: t, written: map[string]bool{}}
}

// route records a route sample: the request and the response.
func (s *sampler) route(name, method, path string, request any, r response) {
	s.t.Helper()
	sample := map[string]any{"method": method, "path": "/api" + path, "status": r.status}
	if request != nil {
		sample["request"] = request
	}
	if len(r.raw) > 0 {
		var body any
		if err := json.Unmarshal(r.raw, &body); err != nil {
			s.t.Fatalf("%s: response is not JSON: %s", name, r.raw)
		}
		sample["response"] = body
	}
	s.write("route."+name, sample)
}

// event records the first event of each type (and each branch change).
func (s *sampler) event(ev tangent.Event) {
	s.t.Helper()
	name := "event." + ev.Type
	if change, ok := ev.Data.(tangent.BranchChange); ok {
		name += "." + change.Change
	}
	if s.written[name] {
		return
	}
	s.write(name, ev)
}

func (s *sampler) write(name string, v any) {
	s.t.Helper()
	if s.written[name] {
		s.t.Fatalf("sample %s written twice", name)
	}
	s.written[name] = true
	got := normalized(s.t, v)
	file := filepath.Join(contractDir, name+".json")
	if *update {
		if err := os.MkdirAll(contractDir, 0o755); err != nil {
			s.t.Fatal(err)
		}
		if err := os.WriteFile(file, got, 0o644); err != nil {
			s.t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(file)
	if err != nil {
		s.t.Errorf("sample %s missing (run go test ./httpapi -update): %v", name, err)
		return
	}
	if !bytes.Equal(got, want) {
		s.t.Errorf("sample %s changed; if intended, run go test ./httpapi -update and tell the frontend.\n--- got\n%s\n--- want\n%s", name, got, want)
	}
}

// checkComplete fails when a sample file exists that this run did not
// produce (a route or event that went away).
func (s *sampler) checkComplete() {
	s.t.Helper()
	files, err := filepath.Glob(filepath.Join(contractDir, "*.json"))
	if err != nil {
		s.t.Fatal(err)
	}
	for _, file := range files {
		name := strings.TrimSuffix(filepath.Base(file), ".json")
		if s.written[name] || serverSamples[name] {
			continue
		}
		if *update {
			_ = os.Remove(file)
			continue
		}
		s.t.Errorf("sample %s is no longer produced (run -update)", name)
	}
}

// normalized renders v as indented JSON with placeholders.
func normalized(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var tree any
	if err := json.Unmarshal(raw, &tree); err != nil {
		t.Fatal(err)
	}
	n := &normalizer{ids: map[string]string{}, seqs: map[float64]float64{}}
	out, err := json.MarshalIndent(n.walk("", tree), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return append(out, '\n')
}

type normalizer struct {
	ids  map[string]string
	seqs map[float64]float64
}

// deltaSeqFloor separates the in-memory delta counters (microseconds since
// the epoch) from database seqs.
const deltaSeqFloor = 1e12

func (n *normalizer) walk(key string, v any) any {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		// Ids as keys (the export's messagesByLine) are placeholders too;
		// they are walked in the order of the placeholders already given
		// (the export's branches come first), so the sample is stable.
		sort.Slice(keys, func(i, j int) bool { return n.keyOrder(keys[i]) < n.keyOrder(keys[j]) })
		out := make(map[string]any, len(x))
		for _, k := range keys {
			name := k
			if uuidPattern.MatchString(k) && uuidPattern.FindString(k) == k {
				name = n.text("", k)
			}
			out[name] = n.walk(k, x[k])
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = n.walk(key, item)
		}
		return out
	case string:
		return n.text(key, x)
	case float64:
		return n.number(key, x)
	}
	return v
}

// keyOrder sorts a map key: an id by its placeholder when it has one.
func (n *normalizer) keyOrder(k string) string {
	if placeholder, ok := n.ids[k]; ok {
		return placeholder
	}
	return k
}

func (n *normalizer) text(key, s string) string {
	if key == "nextCursor" && s != "" {
		return "CURSOR"
	}
	if _, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return fixedTime
	}
	if minutePattern.MatchString(s) {
		return "2026-01-01 00:00"
	}
	return uuidPattern.ReplaceAllStringFunc(s, func(id string) string {
		if placeholder, ok := n.ids[id]; ok {
			return placeholder
		}
		placeholder := fmt.Sprintf("00000000-0000-4000-8000-%012d", len(n.ids)+1)
		n.ids[id] = placeholder
		return placeholder
	})
}

func (n *normalizer) number(key string, f float64) float64 {
	switch {
	case key == "durationMs":
		return 42
	case (key == "seq" || key == "streamSeq") && f > deltaSeqFloor:
		if mapped, ok := n.seqs[f]; ok {
			return mapped
		}
		mapped := float64(1000 + len(n.seqs))
		n.seqs[f] = mapped
		return mapped
	}
	return f
}
