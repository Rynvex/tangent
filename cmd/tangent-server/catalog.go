package main

import (
	"github.com/Rynvex/tangent/runner/cli"
	"github.com/Rynvex/tangent/tangent"
)

// presetModel is a built-in model of a CLI provider: what the catalog
// offers when TANGENT_ALLOWED_MODELS is not set.
type presetModel struct {
	name    string
	display string
	status  string
	// noEffort: the model takes no reasoning effort although its CLI does.
	noEffort bool
	// aliases are other names the CLI takes for the same model; they are
	// allowed (without an allowlist) but not listed.
	aliases []string
}

// cliPresets are the CLI providers' built-in models, in the order a client
// offers them.
var cliPresets = map[string][]presetModel{
	providerClaudeCLI: {
		{name: "claude-opus-5-5", display: "Claude Opus 5.5", status: tangent.ModelCurrent, aliases: []string{"opus"}},
		{name: "claude-sonnet-5-5", display: "Claude Sonnet 5.5", status: tangent.ModelCurrent, aliases: []string{"sonnet"}},
		{name: "claude-haiku-5-5", display: "Claude Haiku 5.5", status: tangent.ModelCurrent, noEffort: true, aliases: []string{"haiku"}},
		{name: "claude-fable-5-2", display: "Claude Fable 5.2", status: tangent.ModelCurrent, aliases: []string{"fable"}},
	},
	providerCodexCLI: {
		{name: "gpt-6.1-sol", display: "GPT-6.1 Sol", status: tangent.ModelCurrent},
		{name: "gpt-6-astra", display: "GPT-6 Astra", status: tangent.ModelCurrent},
		{name: "gpt-6-luna", display: "GPT-6 Luna", status: tangent.ModelCurrent},
		{name: "gpt-5.4-mini", display: "GPT-5.4 mini", status: tangent.ModelLegacy},
	},
	providerAgyCLI: {
		{name: "gemini-4-carbon", display: "Gemini 4 Carbon", status: tangent.ModelCurrent},
		{name: "gemini-4-argon", display: "Gemini 4 Argon", status: tangent.ModelCurrent},
		{name: "gemini-3.8-flash", display: "Gemini 3.8 Flash", status: tangent.ModelLegacy},
		{name: "gemini-3.8-flash-high", display: "Gemini 3.8 Flash (high)", status: tangent.ModelLegacy},
		{name: "gemini-3.8-flash-medium", display: "Gemini 3.8 Flash (medium)", status: tangent.ModelLegacy},
		{name: "gemini-3.8-flash-low", display: "Gemini 3.8 Flash (low)", status: tangent.ModelLegacy},
	},
}

// findPreset is the preset model of provider named model (by its name or
// an alias); alias reports which.
func findPreset(provider, model string) (preset presetModel, alias, ok bool) {
	for _, p := range cliPresets[provider] {
		if p.name == model {
			return p, false, true
		}
		for _, a := range p.aliases {
			if a == model {
				return p, true, true
			}
		}
	}
	return presetModel{}, false, false
}

// isPresetAlias reports whether model is a preset's alias on provider.
func isPresetAlias(provider, model string) bool {
	_, alias, ok := findPreset(provider, model)
	return ok && alias
}

// cliBackendOf is the backend of a CLI provider ("" for other providers).
func cliBackendOf(provider string) cli.Backend {
	for _, p := range cliProviders {
		if p.name == provider {
			return p.backend
		}
	}
	return ""
}

// effortLevels are the reasoning efforts the server passes on for a model:
// its CLI's levels (claude --effort, codex model_reasoning_effort), none for
// a preset that takes none, for agy and for the API and fake providers
// (their runners have no such setting). A CLI model that is not a preset
// gets its CLI's levels.
func effortLevels(provider, model string) []string {
	if p, _, ok := findPreset(provider, model); ok && p.noEffort {
		return nil
	}
	return cli.EffortLevels(cliBackendOf(provider))
}

// modelDetail describes one listed model, or false when there is nothing
// to say beyond its name.
func modelDetail(provider, model string) (tangent.ModelDetail, bool) {
	d := tangent.ModelDetail{Model: model, EffortLevels: effortLevels(provider, model)}
	if p, alias, ok := findPreset(provider, model); ok {
		d.DisplayName, d.Status = p.display, p.status
		if alias {
			d.DisplayName += " (" + model + ")"
		}
	}
	return d, d.DisplayName != "" || len(d.EffortLevels) > 0
}

// presetOrder ranks a provider's models: the configured model first, then
// the presets in their order, then the rest (by name, the caller sorts).
func presetOrder(provider, configured, model string) int {
	if model == configured && configured != "" {
		return 0
	}
	for i, p := range cliPresets[provider] {
		if p.name == model {
			return i + 1
		}
	}
	return len(cliPresets[provider]) + 1
}
