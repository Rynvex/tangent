package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

func TestModelCatalog_ListsTheModelsOfTheConfiguredRunners(t *testing.T) {
	dev, err := loadConfig(env{"TANGENT_DEV": "1"}.get)
	if err != nil {
		t.Fatal(err)
	}
	if got := dev.modelCatalog(); !reflect.DeepEqual(got, []tangent.ModelGroup{{Provider: "fake", Models: []string{"fake-1"}}}) {
		t.Fatalf("dev: %+v", got)
	}
	base := env{"TANGENT_TOKEN": writerToken, "TANGENT_PROVIDER": "anthropic", "TANGENT_MODEL": "claude-x", "ANTHROPIC_API_KEY": "k",
		"TANGENT_JOB_MODEL": "anthropic:claude-haiku"}
	cfg, err := loadConfig(base.get)
	if err != nil {
		t.Fatal(err)
	}
	want := []tangent.ModelGroup{{Provider: "anthropic", Models: []string{"claude-haiku", "claude-x"}}}
	if got := cfg.modelCatalog(); !reflect.DeepEqual(got, want) {
		t.Fatalf("configured models: %+v", got)
	}
	base["TANGENT_ALLOWED_MODELS"] = "openai:gpt-5,anthropic:claude-opus,openai:gpt-4o"
	base["OPENAI_API_KEY"] = "k2"
	listed, err := loadConfig(base.get)
	if err != nil {
		t.Fatal(err)
	}
	want = []tangent.ModelGroup{{Provider: "anthropic", Models: []string{"claude-opus"}}, {Provider: "openai", Models: []string{"gpt-4o", "gpt-5"}}}
	if got := listed.modelCatalog(); !reflect.DeepEqual(got, want) {
		t.Fatalf("an allowlist, default provider first: %+v", got)
	}
	delete(base, "OPENAI_API_KEY")
	noRunner, _ := loadConfig(base.get)
	if got := noRunner.modelCatalog(); len(got) != 1 || got[0].Provider != "anthropic" {
		t.Fatalf("a provider without a runner is left out: %+v", got)
	}
}

func TestServer_CapabilitiesSearchAndStats(t *testing.T) {
	r := start(t, testConfig(t, func(c *config) { c.DebugStats = true }))
	_, body := r.request(http.MethodGet, "/api/capabilities", "", testToken)
	if !strings.Contains(body, `"models":[{"provider":"fake","models":["fake-1"]}]`) || !strings.Contains(body, `"name":"search"`) {
		t.Fatalf("capabilities %s", body)
	}
	if status, body := r.request(http.MethodGet, "/api/search?q=hello", "", testToken); status != http.StatusOK || !strings.Contains(body, `"hits":[]`) {
		t.Fatalf("search %d %s", status, body)
	}
	if status, _ := r.request(http.MethodGet, "/debug/stats", "", ""); status != http.StatusUnauthorized {
		t.Fatalf("stats need the token: %d", status)
	}
	status, body := r.request(http.MethodGet, "/debug/stats?gc=1", "", testToken)
	var stats struct {
		Goroutines int `json:"goroutines"`
		Pool       struct {
			Total int32 `json:"totalConns"`
			Max   int32 `json:"maxConns"`
		} `json:"pool"`
		Memory struct {
			HeapAlloc uint64 `json:"heapAllocBytes"`
		} `json:"memory"`
		Streams int `json:"streams"`
	}
	if err := json.Unmarshal([]byte(body), &stats); status != http.StatusOK || err != nil || stats.Goroutines == 0 || stats.Pool.Max == 0 || stats.Memory.HeapAlloc == 0 {
		t.Fatalf("stats %d %s %v", status, body, err)
	}
	plain := start(t, testConfig(t))
	if status, _ := plain.request(http.MethodGet, "/debug/stats", "", testToken); status != http.StatusNotFound {
		t.Fatalf("stats are off by default: %d", status)
	}
}

func TestLoadConfig_DebugStats(t *testing.T) {
	cfg, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_DEBUG_STATS": "1"}.get)
	if err != nil || !cfg.DebugStats {
		t.Fatalf("cfg %+v %v", cfg.DebugStats, err)
	}
}

func TestServer_FakeLinesTakeTheFakeDefaultModel(t *testing.T) {
	r := start(t, testConfig(t))
	status, body := r.request(http.MethodPost, "/api/lines", `{"title":"t"}`, testToken)
	if status != http.StatusCreated || !strings.Contains(body, `"provider":"fake"`) || !strings.Contains(body, `"model":"fake-1"`) {
		t.Fatalf("create: %d %s", status, body)
	}
}
