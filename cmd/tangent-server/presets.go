package main

import (
	"cmp"
	"errors"
	"fmt"
	"log/slog"
	"strings"
)

// Feature presets of TANGENT_FEATURES (B25). A preset names a feature list;
// presets and single features mix in one comma separated value, read left
// to right: a later entry for a feature replaces an earlier one in place,
// and none clears everything before it. Presets are a reference-server
// notion: the library's AllFeatures does not change.
const (
	presetEssential = "essential"
	presetStandard  = "standard"
	presetFull      = "full"
	presetNone      = "none"
)

// essentialFeatures is the main loop only: a conversation, its asides and
// branches with their cards, and the quiet helpers that cost no model call
// on their own (DESIGN §12.10 B25 D2).
const essentialFeatures = "notes,chapters,aside,summary:suggest,card_draft,leaf:manual,parking,spinoff,search,memo,glossary"

// fullFeatures is standard plus fisheye and memory (memory still needs
// TANGENT_EMBEDDER, or the fake provider's default fake one).
const fullFeatures = defaultFeatures + ",fisheye,memory"

var featurePresets = map[string]string{
	presetEssential: essentialFeatures,
	presetStandard:  defaultFeatures,
	presetFull:      fullFeatures,
}

// presetNames lists the presets for error messages.
const presetNames = "essential, standard, full or none"

// featureItem is one feature entry: its name and, when given, its mode.
type featureItem struct {
	name    string
	mode    string
	hasMode bool
}

// String is the entry as TANGENT_FEATURES would say it.
func (i featureItem) String() string {
	if i.hasMode {
		return i.name + ":" + i.mode
	}
	return i.name
}

// readFeatures parses TANGENT_FEATURES (unset means standard, D1) and
// builds the features it lists.
func readFeatures(cfg *config, get func(string) string) error {
	items, err := expandFeatures(cmp.Or(get("TANGENT_FEATURES"), presetStandard))
	if err != nil {
		return fmt.Errorf("TANGENT_FEATURES: %w", err)
	}
	for _, item := range items {
		feature, err := buildConfiguredFeature(cfg, get, item.name, item.mode, item.hasMode)
		if err != nil {
			return fmt.Errorf("TANGENT_FEATURES: %w", err)
		}
		cfg.Features = append(cfg.Features, feature)
		cfg.FeatureNames = append(cfg.FeatureNames, item.String())
	}
	return nil
}

// expandFeatures reads a TANGENT_FEATURES value into feature entries:
// presets (any case) expand to their lists, none clears what came before,
// and a later entry for a feature replaces the earlier one in its place.
func expandFeatures(text string) ([]featureItem, error) {
	var out []featureItem
	for _, raw := range strings.Split(text, ",") {
		name, mode, hasMode := strings.Cut(strings.TrimSpace(raw), ":")
		item := featureItem{name: strings.TrimSpace(name), mode: strings.TrimSpace(mode), hasMode: hasMode}
		key := strings.ToLower(item.name)
		preset, isPreset := featurePresets[key]
		switch {
		case item.name == "":
			return nil, errors.New("an empty entry (two commas in a row?)")
		case (isPreset || key == presetNone) && hasMode:
			return nil, fmt.Errorf("%s is a preset and has no mode", item.name)
		case key == presetNone:
			out = nil
		case isPreset:
			expanded, err := expandFeatures(preset)
			if err != nil {
				return nil, err
			}
			out = mergeFeatures(out, expanded...)
		default:
			out = mergeFeatures(out, item)
		}
	}
	return out, nil
}

// mergeFeatures returns list with items added in order; an item whose
// feature is listed already replaces that entry where it stands.
func mergeFeatures(list []featureItem, items ...featureItem) []featureItem {
	out := append([]featureItem(nil), list...)
	for _, item := range items {
		replaced := false
		for i := range out {
			if out[i].name == item.name {
				out[i], replaced = item, true
				break
			}
		}
		if !replaced {
			out = append(out, item)
		}
	}
	return out
}

// logStartupWarnings logs, once at startup, the settings that work but
// probably are not what the operator wants.
func logStartupWarnings(log *slog.Logger, cfg config) {
	for _, base := range cfg.insecureBaseURLs() {
		log.Warn("tangent-server: a provider base URL is plain http to another host; the API key travels unencrypted", "baseURL", base)
	}
	if cfg.Embedder == embedderFake {
		log.Warn("tangent-server: the memory feature runs on the fake embedder; its recall means nothing (only fit to test the flow), set TANGENT_EMBEDDER=openai for real use")
	}
}
