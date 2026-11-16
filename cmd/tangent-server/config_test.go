package main

import (
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/tangent"
)

// env is a fake environment.
type env map[string]string

func (e env) get(key string) string { return e[key] }

func TestLoadConfig_DefaultsInDevMode(t *testing.T) {
	cfg, err := loadConfig(env{"TANGENT_DEV": "1"}.get)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != "127.0.0.1:8120" || cfg.Token != "" || cfg.Provider != "fake" || cfg.Tenant != "default" {
		t.Fatalf("cfg = %+v", cfg)
	}
	if !strings.Contains(cfg.DatabaseURL, ":5444/tangent") || cfg.RateLimit <= 0 || cfg.MaintainInterval != time.Minute {
		t.Fatalf("cfg = %+v", cfg)
	}
	if len(cfg.Features) != len(tangent.AllFeatures())+13 || cfg.Features[len(tangent.AllFeatures())].Name() != tangent.FeatureSearch ||
		cfg.Features[len(cfg.Features)-4].Name() != tangent.FeatureIbis || cfg.Features[len(cfg.Features)-2].Name() != tangent.FeatureDiverge ||
		cfg.Features[len(cfg.Features)-1].Name() != tangent.FeatureMemo {
		t.Fatalf("every first-batch feature (glossary among them), search, leaf, parking, spinoff, rebalance, goal, relations, open_loops, group, ibis, fold, diverge and memo by default: %d", len(cfg.Features))
	}
	custom, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "notes,ibis:auto,fold:manual"}.get)
	if err != nil || len(custom.Features) != 3 || custom.Features[1].Name() != tangent.FeatureIbis || custom.Features[2].Name() != tangent.FeatureFold {
		t.Fatalf("ibis and fold take a mode: %+v %v", custom.Features, err)
	}
	if got := cfg.migratedFeatures(); len(got) != 1 || got[0] != tangent.FeatureSearch {
		t.Fatalf("features with migrations: %v", got)
	}
}

func TestLoadConfig_RefusesWhatCannotWork(t *testing.T) {
	cases := []struct {
		name string
		env  env
		want string
	}{
		{"no token", env{"TANGENT_PROVIDER": "fake"}, "TANGENT_TOKEN"},
		{"dev on every interface", env{"TANGENT_DEV": "1", "TANGENT_ADDR": ":8120"}, "TANGENT_TOKEN"},
		{"no provider", env{"TANGENT_TOKEN": "0123456789abcdef0123456789abcdef"}, "TANGENT_PROVIDER"},
		{"unknown provider", env{"TANGENT_TOKEN": "0123456789abcdef0123456789abcdef", "TANGENT_PROVIDER": "nope"}, "TANGENT_PROVIDER"},
		{"anthropic without key", env{"TANGENT_TOKEN": "0123456789abcdef0123456789abcdef", "TANGENT_PROVIDER": "anthropic", "TANGENT_MODEL": "m"}, "ANTHROPIC_API_KEY"},
		{"model required", env{"TANGENT_TOKEN": "0123456789abcdef0123456789abcdef", "TANGENT_PROVIDER": "openai", "OPENAI_API_KEY": "k"}, "TANGENT_MODEL"},
		{"bad feature", env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "notes,teleport"}, "teleport"},
		{"bad mode", env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "summary:sometimes"}, "sometimes"},
		{"mode on a plain feature", env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "notes:auto"}, "notes"},
		{"bad pricing", env{"TANGENT_DEV": "1", "TANGENT_PRICING": "{"}, "TANGENT_PRICING"},
		{"negative price", env{"TANGENT_DEV": "1", "TANGENT_PRICING": `{"m":{"input":-1}}`}, "TANGENT_PRICING"},
		{"bad duration", env{"TANGENT_DEV": "1", "TANGENT_MAINTAIN_INTERVAL": "soon"}, "TANGENT_MAINTAIN_INTERVAL"},
		{"bad number", env{"TANGENT_DEV": "1", "TANGENT_RATE_LIMIT": "-3"}, "TANGENT_RATE_LIMIT"},
		{"short token", env{"TANGENT_TOKEN": "abc", "TANGENT_PROVIDER": "fake"}, "TANGENT_TOKEN"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := loadConfig(c.env.get)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want it to mention %q", err, c.want)
			}
		})
	}
}

func TestLoadConfig_ReadsProvidersFeaturesAndPricing(t *testing.T) {
	cfg, err := loadConfig(env{
		"TANGENT_TOKEN": "0123456789abcdef0123456789abcdef", "TANGENT_ADDR": ":9000", "TANGENT_PROVIDER": "anthropic", "TANGENT_MODEL": "claude-x",
		"ANTHROPIC_API_KEY": "sk-ant", "OPENAI_API_KEY": "sk-oa", "TANGENT_OPENAI_MODEL": "gpt-x", "TANGENT_OPENAI_BASE_URL": "http://localhost:11434/v1",
		"TANGENT_FEATURES": "notes, summary:auto ,branch_suggest:manual", "TANGENT_PRICING": `{"claude-x":{"input":3,"output":15,"cacheRead":0.3}}`,
		"TANGENT_STATIC_DIR": "web/apps/demo/dist", "TANGENT_FAKE_CHUNK_DELAY": "20ms", "TANGENT_TENANT": "acme",
	}.get)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != ":9000" || cfg.Provider != "anthropic" || cfg.Anthropic.APIKey != "sk-ant" || cfg.Anthropic.Model != "claude-x" {
		t.Fatalf("cfg = %+v", cfg)
	}
	if cfg.OpenAI.APIKey != "sk-oa" || cfg.OpenAI.Model != "gpt-x" || cfg.OpenAI.BaseURL != "http://localhost:11434/v1" {
		t.Fatalf("openai = %+v", cfg.OpenAI)
	}
	if len(cfg.Features) != 3 || cfg.Pricing["claude-x"].Output != 15 || cfg.StaticDir == "" || cfg.FakeChunkDelay != 20*time.Millisecond || cfg.Tenant != "acme" {
		t.Fatalf("cfg = %+v", cfg)
	}
	none, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "none"}.get)
	if err != nil || len(none.Features) != 0 {
		t.Fatalf("none = %+v %v", none.Features, err)
	}
	fisheye, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "leaf:manual,fisheye"}.get)
	if err != nil || len(fisheye.Features) != 2 || fisheye.Features[1].Name() != tangent.FeatureFisheye {
		t.Fatalf("fisheye is opt-in: %+v %v", fisheye.Features, err)
	}
	if _, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "fisheye:auto"}.get); err == nil {
		t.Fatal("fisheye has no mode")
	}
	if strings.Contains(cfg.String(), "sk-ant") || strings.Contains(cfg.String(), "0123456789abcdef") {
		t.Fatalf("the summary leaks secrets: %s", cfg.String())
	}
}

func TestLoadConfig_ViewerTokenJobModelAndAllowedModels(t *testing.T) {
	base := env{"TANGENT_TOKEN": writerToken, "TANGENT_PROVIDER": "anthropic", "TANGENT_MODEL": "claude-x", "ANTHROPIC_API_KEY": "k"}
	with := func(extra env) env {
		out := env{}
		for k, v := range base {
			out[k] = v
		}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	cfg, err := loadConfig(with(env{"TANGENT_VIEWER_TOKEN": viewerToken, "TANGENT_JOB_MODEL": "anthropic:claude-haiku"}).get)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ViewerToken != viewerToken || cfg.JobModel != (modelRef{"anthropic", "claude-haiku"}) || !strings.Contains(cfg.String(), "viewerToken=set") {
		t.Fatalf("cfg = %+v", cfg)
	}
	if !cfg.allowModel("anthropic", "claude-x") || !cfg.allowModel("anthropic", "claude-haiku") || cfg.allowModel("anthropic", "claude-opus") {
		t.Fatal("without a list, the configured models are allowed")
	}
	if !cfg.allowModel("", "") || !cfg.allowModel("", "claude-x") || cfg.allowModel("fake", "x") || cfg.allowModel("openai", "gpt-5") {
		t.Fatal("defaults and other providers")
	}
	if cfg.defaultModel() != "claude-x" || len(cfg.Features) != 20 {
		t.Fatalf("default model %q, %d features", cfg.defaultModel(), len(cfg.Features))
	}
	listed, err := loadConfig(with(env{"TANGENT_ALLOWED_MODELS": "anthropic:claude-opus, openai:gpt-5"}).get)
	if err != nil || !listed.allowModel("openai", "gpt-5") || listed.allowModel("anthropic", "claude-x") {
		t.Fatalf("an explicit list replaces the defaults: %v", err)
	}
	refusals(t, with)
}

// refusals checks the settings B4.1 added refuse what cannot work.
func refusals(t *testing.T, with func(env) env) {
	t.Helper()
	for _, bad := range []env{
		{"TANGENT_VIEWER_TOKEN": "short"}, {"TANGENT_VIEWER_TOKEN": writerToken}, {"TANGENT_JOB_MODEL": "haiku"},
		{"TANGENT_JOB_MODEL": "mystery:m"}, {"TANGENT_ALLOWED_MODELS": "anthropic:"},
	} {
		if _, err := loadConfig(with(bad).get); err == nil {
			t.Errorf("%v must be refused", bad)
		}
	}
	if _, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_VIEWER_TOKEN": viewerToken}.get); err == nil {
		t.Error("a viewer token needs a writer token")
	}
	if _, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_JOB_MODEL": "anthropic:h"}.get); err == nil {
		t.Error("an anthropic job model needs a key")
	}
	dev, _ := loadConfig(env{"TANGENT_DEV": "1"}.get)
	if !dev.allowModel("fake", "anything") || dev.defaultModel() != fake.DefaultModel {
		t.Error("the fake takes any model")
	}
	insecure := config{OpenAI: providerConfig{BaseURL: "http://10.0.0.5:11434/v1"}, Anthropic: providerConfig{BaseURL: "http://localhost:1"}}
	if got := insecure.insecureBaseURLs(); len(got) != 1 || !strings.Contains(got[0], "10.0.0.5") {
		t.Errorf("insecure = %v", got)
	}
	if (modelRef{}).String() == "" || (modelRef{}).options() != nil {
		t.Error("an unset job model")
	}
}
