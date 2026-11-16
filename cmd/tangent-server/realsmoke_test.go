package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// TestRealModelSmoke runs the core flow against a real provider. It only
// runs with TANGENT_REAL_SMOKE=1 and the provider settings of the reference
// server (TANGENT_PROVIDER, TANGENT_MODEL and the provider's API key, or a
// CLI provider's TANGENT_<NAME>_CLI_* variables) in the environment;
// otherwise it is skipped. Keys are never printed.
func TestRealModelSmoke(t *testing.T) {
	if os.Getenv("TANGENT_REAL_SMOKE") != "1" {
		t.Skip("set TANGENT_REAL_SMOKE=1 with TANGENT_PROVIDER, TANGENT_MODEL and an API key to run against a real model")
	}
	vars := env{}
	for _, key := range []string{
		"TANGENT_PROVIDER", "TANGENT_MODEL", "OPENAI_API_KEY", "TANGENT_OPENAI_API_KEY", "TANGENT_OPENAI_BASE_URL", "TANGENT_OPENAI_MODEL",
		"ANTHROPIC_API_KEY", "TANGENT_ANTHROPIC_API_KEY", "TANGENT_ANTHROPIC_BASE_URL", "TANGENT_ANTHROPIC_MODEL", "TANGENT_PRICING",
		"TANGENT_JOB_MODEL", "TANGENT_CLI_ENV",
	} {
		vars[key] = os.Getenv(key)
	}
	for _, p := range cliProviders {
		for _, suffix := range []string{"_PATH", "_MODEL", "_MAX_CONCURRENT"} {
			vars[p.prefix+suffix] = os.Getenv(p.prefix + suffix)
		}
	}
	vars["TANGENT_TOKEN"], vars["TANGENT_ADDR"] = testToken, "127.0.0.1:0"
	cfg, err := loadConfig(vars.get)
	if err != nil {
		t.Fatalf("configuration: %v", err)
	}
	cfg.ShutdownTimeout = 30 * time.Second
	s := &smoke{r: start(t, cfg)}
	main := s.post("/api/lines", `{"title":"real smoke"}`, http.StatusCreated)["id"].(string)
	s.turn(main, "In one sentence: what is a good first trip in Japan?")
	reply := s.turn(main, "In one sentence: why?")
	branch := s.post("/api/lines/"+main+"/branches", `{"anchorMessageId":"`+reply+`","purpose":"Check the cost","kind":"investigate"}`, http.StatusCreated)
	branchID := branch["line"].(map[string]any)["id"].(string)
	s.turn(branchID, "In one sentence: roughly how much does it cost?")
	s.post("/api/lines/"+branchID+"/branch/draft", "", http.StatusAccepted)
	s.r.app.dispatcher.Wait()
	detail := s.get("/api/lines/" + branchID + "/branch")
	draft := detail["draft"].(map[string]any)
	if draft["status"] != "ready" {
		t.Fatalf("the draft is %v: %v", draft["status"], draft["error"])
	}
	card, _ := json.Marshal(draft["card"])
	s.post("/api/lines/"+branchID+"/branch/merge", `{"card":`+string(card)+`,"parentTipMessageId":"`+detail["parentTipMessageId"].(string)+`"}`, http.StatusOK)
	t.Logf("real smoke passed with %s", cfg.Provider)
}

type smoke struct{ r *running }

func (s *smoke) post(path, body string, want int) map[string]any {
	s.r.t.Helper()
	status, raw := s.r.request(http.MethodPost, path, body, testToken)
	if status != want {
		s.r.t.Fatalf("POST %s: %d %s", path, status, raw)
	}
	var out map[string]any
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

func (s *smoke) get(path string) map[string]any {
	s.r.t.Helper()
	status, raw := s.r.request(http.MethodGet, path, "", testToken)
	if status != http.StatusOK {
		s.r.t.Fatalf("GET %s: %d %s", path, status, raw)
	}
	var out map[string]any
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

// turn sends a message, waits for the reply and checks it succeeded.
func (s *smoke) turn(lineID, content string) string {
	s.r.t.Helper()
	sent := s.post("/api/lines/"+lineID+"/messages", `{"content":"`+content+`"}`, http.StatusAccepted)
	s.r.app.dispatcher.Wait()
	page := s.get("/api/lines/" + lineID + "/messages")
	messages := page["messages"].([]any)
	last := messages[len(messages)-1].(map[string]any)
	if last["id"] != sent["turnId"] || last["status"] != "done" || strings.TrimSpace(last["content"].(string)) == "" {
		s.r.t.Fatalf("the reply failed: %v", last["meta"])
	}
	return last["id"].(string)
}
