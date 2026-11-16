package main

import (
	"strings"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

func TestLoadConfig_MemoryNeedsAnEmbedder(t *testing.T) {
	cfg, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "notes,memory"}.get)
	if err != nil || len(cfg.Features) != 2 || cfg.Features[1].Name() != tangent.FeatureMemory || cfg.Embedder != "fake" {
		t.Fatalf("the fake provider remembers with the fake Embedder: %+v %v", cfg.FeatureNames, err)
	}
	if got := cfg.migratedFeatures(); len(got) != 1 || got[0] != tangent.FeatureMemory {
		t.Fatalf("memory brings a migration: %v", got)
	}
	openai, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "notes,memory:auto", "TANGENT_EMBEDDER": "openai", "OPENAI_API_KEY": "sk-x", "TANGENT_EMBEDDING_DIM": "256"}.get)
	if err != nil || openai.Embedder != "openai text-embedding-3-small/256" {
		t.Fatalf("openai = %q %v", openai.Embedder, err)
	}
	for name, e := range map[string]env{
		"no key":       {"TANGENT_DEV": "1", "TANGENT_FEATURES": "notes,memory", "TANGENT_EMBEDDER": "openai"},
		"unknown":      {"TANGENT_DEV": "1", "TANGENT_FEATURES": "notes,memory", "TANGENT_EMBEDDER": "magic"},
		"bad size":     {"TANGENT_DEV": "1", "TANGENT_FEATURES": "notes,memory", "TANGENT_EMBEDDER": "fake", "TANGENT_EMBEDDING_DIM": "-1"},
		"real no auto": {"TANGENT_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "k", "TANGENT_MODEL": "m", "TANGENT_TOKEN": strings.Repeat("t", 32), "TANGENT_FEATURES": "notes,memory"},
	} {
		if _, err := loadConfig(e.get); err == nil || !strings.Contains(err.Error(), "TANGENT_EMBEDDER") && !strings.Contains(err.Error(), "TANGENT_EMBEDDING_DIM") {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if def, _ := loadConfig(env{"TANGENT_DEV": "1"}.get); def.Embedder != "" {
		t.Fatalf("memory is off by default: %q", def.Embedder)
	}
}
