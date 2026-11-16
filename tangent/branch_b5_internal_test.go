package tangent

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/Rynvex/tangent/domain"
)

func TestCleanCatalog_KeepsDetailsOfListedModelsOnly(t *testing.T) {
	ready := false
	groups := []ModelGroup{{
		Provider: " claude-cli ", Models: []string{"opus", "sonnet"}, Ready: &ready, Reason: " binary not found ",
		Details: []ModelDetail{
			{Model: " opus ", DisplayName: " Opus ", Status: ModelCurrent, EffortLevels: []string{"low", " ", "high"}},
			{Model: "opus", DisplayName: "again"},
			{Model: "haiku", DisplayName: "not listed"},
			{Model: "sonnet", Status: ModelLegacy, EffortLevels: []string{" "}},
		},
	}}
	got := cleanCatalog(groups)
	notReady := false
	want := []ModelGroup{{
		Provider: "claude-cli", Models: []string{"opus", "sonnet"}, Ready: &notReady, Reason: "binary not found",
		Details: []ModelDetail{{Model: "opus", DisplayName: "Opus", Status: ModelCurrent, EffortLevels: []string{"low", "high"}}, {Model: "sonnet", Status: ModelLegacy}},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
	ready = true
	if *got[0].Ready {
		t.Fatal("Ready is copied, not shared")
	}
}

func TestModelGroup_OldShapeWithoutDetails(t *testing.T) {
	raw, err := json.Marshal(cleanCatalog([]ModelGroup{{Provider: "fake", Models: []string{"fake-1"}}}))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `[{"provider":"fake","models":["fake-1"]}]` {
		t.Fatalf("a group without the optional fields keeps the B5 shape: %s", raw)
	}
}

func TestModelCatalog_ReturnsADeepCopy(t *testing.T) {
	ready := true
	e := &Engine{catalog: cleanCatalog([]ModelGroup{{Provider: "codex-cli", Models: []string{"m"}, Ready: &ready,
		Details: []ModelDetail{{Model: "m", EffortLevels: []string{"low"}}}}})}
	first := e.ModelCatalog()
	*first[0].Ready = false
	first[0].Details[0].EffortLevels[0] = "changed"
	second := e.ModelCatalog()
	if !*second[0].Ready || second[0].Details[0].EffortLevels[0] != "low" {
		t.Fatalf("the engine's catalog changed through a copy: %+v", second)
	}
}

func TestTurnRequest_CarriesTheOperatorMessageHostMeta(t *testing.T) {
	turn := Turn{Provider: "claude-cli", Model: "opus", UserMessage: domain.Message{HostMeta: json.RawMessage(`{"reasoningEffort":"high"}`)}}
	req := turn.Request()
	if string(req.HostMeta) != `{"reasoningEffort":"high"}` || req.ReasoningEffort != "" {
		t.Fatalf("request %+v", req)
	}
	req.HostMeta[2] = 'X'
	if string(turn.UserMessage.HostMeta) != `{"reasoningEffort":"high"}` {
		t.Fatal("the request has its own copy of the host_meta")
	}
	for _, empty := range []string{"", "{}", " { } ", "null"} {
		if (Turn{UserMessage: domain.Message{HostMeta: json.RawMessage(empty)}}).Request().HostMeta != nil {
			t.Fatalf("an empty host_meta %q is not passed on", empty)
		}
	}
	if ChatRequest(domain.Prompt{}, "p", "m").HostMeta != nil || (Job{}).Request().HostMeta != nil {
		t.Fatal("ChatRequest and jobs carry no host_meta")
	}
}
