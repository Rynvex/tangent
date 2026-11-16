package main

import (
	"bytes"
	"log/slog"
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

// featureNames lists the names of the configured features, in order.
func featureNames(cfg config) []string {
	out := make([]string, 0, len(cfg.Features))
	for _, f := range cfg.Features {
		out = append(out, f.Name())
	}
	return out
}

func TestFeaturePresets_ExpandToTheirLists(t *testing.T) {
	essential, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "essential"}.get)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		tangent.FeatureNotes, tangent.FeatureChapters, tangent.FeatureAside, tangent.FeatureSummary, tangent.FeatureCardDraft,
		tangent.FeatureLeaf, tangent.FeatureParking, tangent.FeatureSpinoff, tangent.FeatureSearch, tangent.FeatureMemo, tangent.FeatureGlossary,
	}
	if got := featureNames(essential); !slices.Equal(got, want) {
		t.Fatalf("essential = %v, want %v", got, want)
	}
	if !slices.Contains(essential.FeatureNames, "leaf:manual") || !slices.Contains(essential.FeatureNames, "summary:suggest") {
		t.Fatalf("essential keeps its modes: %v", essential.FeatureNames)
	}
	unset, err := loadConfig(env{"TANGENT_DEV": "1"}.get)
	if err != nil {
		t.Fatal(err)
	}
	standard, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "Standard"}.get)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(featureNames(standard), featureNames(unset)) || !slices.Equal(standard.FeatureNames, unset.FeatureNames) {
		t.Fatalf("standard is the default (D1): %v vs %v", standard.FeatureNames, unset.FeatureNames)
	}
	full, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "full"}.get)
	if err != nil {
		t.Fatal(err)
	}
	if got := featureNames(full); !slices.Equal(got[:len(got)-2], featureNames(standard)) ||
		!slices.Equal(got[len(got)-2:], []string{tangent.FeatureFisheye, tangent.FeatureMemory}) || full.Embedder != embedderFake {
		t.Fatalf("full = standard + fisheye + memory: %v (embedder %q)", got, full.Embedder)
	}
}

func TestFeaturePresets_MixWithFeaturesLaterWins(t *testing.T) {
	cfg, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "essential,goal:manual,relations:manual,leaf:auto"}.get)
	if err != nil {
		t.Fatal(err)
	}
	names := featureNames(cfg)
	if len(names) != 13 || names[11] != tangent.FeatureGoal || names[12] != tangent.FeatureRelations {
		t.Fatalf("essential plus goal and relations: %v", names)
	}
	if names[5] != tangent.FeatureLeaf || cfg.FeatureNames[5] != "leaf:auto" || slices.Contains(cfg.FeatureNames, "leaf:manual") {
		t.Fatalf("a later leaf:auto replaces essential's leaf:manual in place: %v", cfg.FeatureNames)
	}
	over, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "summary:auto,essential"}.get)
	if err != nil {
		t.Fatal(err)
	}
	if over.FeatureNames[0] != "summary:suggest" || len(over.Features) != 11 {
		t.Fatalf("a preset after a feature overrides it: %v", over.FeatureNames)
	}
	reset, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "full,none,notes"}.get)
	if err != nil || !slices.Equal(featureNames(reset), []string{tangent.FeatureNotes}) || reset.Embedder != "" {
		t.Fatalf("none clears what came before: %v %v (embedder %q)", reset.FeatureNames, err, reset.Embedder)
	}
	dup, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "notes,notes"}.get)
	if err != nil || len(dup.Features) != 1 {
		t.Fatalf("a repeated feature is listed once: %v %v", dup.FeatureNames, err)
	}
}

func TestFeaturePresets_Refusals(t *testing.T) {
	cases := map[string]struct {
		env  env
		want []string
	}{
		"unknown name": {env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "minimal"}, []string{"minimal", "essential", "standard", "full"}},
		"preset mode":  {env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "essential:auto"}, []string{"essential", "no mode"}},
		"empty item":   {env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "essential,,notes"}, []string{"empty"}},
		"full without an embedder": {env{
			"TANGENT_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "k", "TANGENT_MODEL": "m", "TANGENT_TOKEN": strings.Repeat("t", 32), "TANGENT_FEATURES": "full",
		}, []string{"TANGENT_EMBEDDER"}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := loadConfig(c.env.get)
			if err == nil {
				t.Fatal("refused expected")
			}
			for _, want := range c.want {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("err = %v, want it to mention %q", err, want)
				}
			}
		})
	}
}

func TestStartupWarnings_MemoryOnTheFakeEmbedder(t *testing.T) {
	fakeMemory, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": "essential,memory"}.get)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	logStartupWarnings(slog.New(slog.NewTextHandler(&buf, nil)), fakeMemory)
	if out := buf.String(); strings.Count(out, "level=WARN") != 1 || !strings.Contains(out, "memory") || !strings.Contains(out, "fake") {
		t.Fatalf("one WARN about memory on the fake embedder: %q", out)
	}
	for name, e := range map[string]env{
		"no memory":         {"TANGENT_DEV": "1", "TANGENT_FEATURES": "essential"},
		"a real embedder":   {"TANGENT_DEV": "1", "TANGENT_FEATURES": "memory", "TANGENT_EMBEDDER": "openai", "OPENAI_API_KEY": "sk-x"},
		"the default setup": {"TANGENT_DEV": "1"},
	} {
		cfg, err := loadConfig(e.get)
		if err != nil {
			t.Fatal(err)
		}
		buf.Reset()
		logStartupWarnings(slog.New(slog.NewTextHandler(&buf, nil)), cfg)
		if buf.Len() != 0 {
			t.Errorf("%s: no warning expected, got %q", name, buf.String())
		}
	}
}
