package main

import (
	"cmp"
	"fmt"
	"net"
	"net/url"
	"slices"
	"strings"

	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// modelRef is a provider and a model.
type modelRef struct {
	Provider string
	Model    string
}

func (m modelRef) String() string {
	if m.Provider == "" {
		return "(the conversation's)"
	}
	return m.Provider + ":" + m.Model
}

// options is the JobModel option of a set job model.
func (m modelRef) options() []tangent.FeatureOption {
	if m.Provider == "" {
		return nil
	}
	return []tangent.FeatureOption{tangent.JobModel(m.Provider, m.Model)}
}

// parseModelRef reads "provider:model".
func parseModelRef(key, text string) (modelRef, error) {
	provider, model, ok := strings.Cut(strings.TrimSpace(text), ":")
	provider, model = strings.ToLower(strings.TrimSpace(provider)), strings.TrimSpace(model)
	if !ok || provider == "" || model == "" {
		return modelRef{}, fmt.Errorf("%s must be provider:model (for example anthropic:claude-haiku-4-5), got %q", key, text)
	}
	if !knownProvider(provider) {
		return modelRef{}, fmt.Errorf("%s: unknown provider %q (%s)", key, provider, providerNames)
	}
	return modelRef{Provider: provider, Model: model}, nil
}

func knownProvider(name string) bool {
	return name == providerFake || name == providerOpenAI || name == providerAnthropic || isCLIProvider(name)
}

// readModels reads TANGENT_JOB_MODEL, TANGENT_FALLBACK_MODEL and
// TANGENT_ALLOWED_MODELS. Without an allowlist, conversations may use the
// configured models and the presets of every CLI provider that runs (the
// fake provider takes any name); with one, exactly the listed models.
func readModels(cfg *config, get func(string) string) error {
	for _, v := range []struct {
		key string
		dst *modelRef
	}{{"TANGENT_JOB_MODEL", &cfg.JobModel}, {"TANGENT_FALLBACK_MODEL", &cfg.Fallback}} {
		text := get(v.key)
		if text == "" {
			continue
		}
		ref, err := parseModelRef(v.key, text)
		if err != nil {
			return err
		}
		if ref.Provider == providerAnthropic && cfg.Anthropic.APIKey == "" {
			return fmt.Errorf("%s uses anthropic, which needs ANTHROPIC_API_KEY", v.key)
		}
		*v.dst = ref
	}
	cfg.AllowedModels = map[modelRef]bool{}
	text := get("TANGENT_ALLOWED_MODELS")
	if text == "" {
		refs := []modelRef{{providerOpenAI, cfg.OpenAI.Model}, {providerAnthropic, cfg.Anthropic.Model}, cfg.JobModel, cfg.Fallback}
		runners := cfg.runnerProviders()
		for _, p := range cliProviders {
			refs = append(refs, modelRef{p.name, cfg.CLI[p.name].Model})
			if !runners[p.name] {
				continue
			}
			for _, preset := range cliPresets[p.name] {
				refs = append(refs, modelRef{p.name, preset.name})
			}
		}
		for _, ref := range refs {
			if ref.Model != "" {
				cfg.AllowedModels[ref] = true
			}
		}
		return nil
	}
	cfg.Allowlisted = true
	for _, item := range strings.Split(text, ",") {
		ref, err := parseModelRef("TANGENT_ALLOWED_MODELS", item)
		if err != nil {
			return err
		}
		cfg.AllowedModels[ref] = true
	}
	return nil
}

// allowModel is the engine's model check: the fake takes anything; other
// providers take the allowed models; an empty pair is the default.
func (c config) allowModel(provider, model string) bool {
	provider = strings.ToLower(strings.TrimSpace(provider))
	switch provider {
	case "":
		return model == "" || c.allowModel(c.Provider, model)
	case providerFake:
		return c.Provider == providerFake || c.Dev
	}
	model = strings.TrimSpace(model)
	if c.AllowedModels[modelRef{Provider: provider, Model: model}] {
		return true
	}
	// Without an allowlist a preset's alias (opus, sonnet…) is allowed
	// wherever its CLI runs; it is not listed in the catalog.
	return !c.Allowlisted && isPresetAlias(provider, model) && c.runnerProviders()[provider]
}

// defaultModel is the model of the default provider (the fake's own,
// fake-1, so fake lines get a model and a price can apply).
func (c config) defaultModel() string { return c.providerModel(c.Provider) }

// insecureBaseURLs names the configured base URLs that send the API key in
// the clear to another machine (http:// to a host that is not loopback).
func (c config) insecureBaseURLs() []string {
	out := []string{}
	for _, base := range []string{c.OpenAI.BaseURL, c.Anthropic.BaseURL} {
		u, err := url.Parse(base)
		if err != nil || u.Scheme != "http" {
			continue
		}
		host := u.Hostname()
		if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			out = append(out, base)
		}
	}
	return out
}

// runnerProviders names the providers this server registers a runner for
// (buildRunner): the fake in dev or as the default, openai with a key, a
// base URL or as the default, anthropic with a key, a CLI provider as
// cliEnabled says.
func (c config) runnerProviders() map[string]bool {
	out := map[string]bool{}
	if c.Provider == providerFake || c.Dev {
		out[providerFake] = true
	}
	if c.Provider == providerOpenAI || c.OpenAI.APIKey != "" || c.OpenAI.BaseURL != "" {
		out[providerOpenAI] = true
	}
	if c.Anthropic.APIKey != "" {
		out[providerAnthropic] = true
	}
	for _, p := range cliProviders {
		if c.cliEnabled(p) {
			out[p.name] = true
		}
	}
	return out
}

// modelCatalog is what GET /capabilities offers: the allowed models
// (TANGENT_ALLOWED_MODELS, or the configured ones and the CLI presets) of
// the providers that have a runner, plus the fake's default model when the
// fake runs. The default provider comes first, then by name. A CLI
// provider's configured model comes first, then its presets in their
// order, then the rest by name (other providers' models are by name). CLI providers say whether their executable was found;
// models the server knows more about carry details.
func (c config) modelCatalog() []tangent.ModelGroup {
	runners := c.runnerProviders()
	byProvider := map[string][]string{}
	if runners[providerFake] {
		byProvider[providerFake] = []string{fake.DefaultModel}
	}
	for ref := range c.AllowedModels {
		if runners[ref.Provider] && ref.Provider != providerFake {
			byProvider[ref.Provider] = append(byProvider[ref.Provider], ref.Model)
		}
	}
	providers := make([]string, 0, len(byProvider))
	for provider := range byProvider {
		providers = append(providers, provider)
	}
	slices.SortFunc(providers, func(a, b string) int {
		switch {
		case a == c.Provider:
			return -1
		case b == c.Provider:
			return 1
		}
		return strings.Compare(a, b)
	})
	out := make([]tangent.ModelGroup, 0, len(providers))
	for _, provider := range providers {
		out = append(out, c.modelGroup(provider, byProvider[provider]))
	}
	return out
}

// modelGroup is one provider's catalog entry (modelCatalog).
func (c config) modelGroup(provider string, models []string) tangent.ModelGroup {
	configured := ""
	if isCLIProvider(provider) {
		configured = c.CLI[provider].Model
	}
	slices.SortFunc(models, func(a, b string) int {
		return cmp.Or(cmp.Compare(presetOrder(provider, configured, a), presetOrder(provider, configured, b)), strings.Compare(a, b))
	})
	group := tangent.ModelGroup{Provider: provider, Models: slices.Compact(models)}
	if isCLIProvider(provider) {
		ready := c.CLI[provider].Installed
		group.Ready = &ready
		if !ready {
			group.Reason = "binary not found"
		}
	}
	for _, model := range group.Models {
		if d, ok := modelDetail(provider, model); ok {
			group.Details = append(group.Details, d)
		}
	}
	return group
}

// providerModel is the model configured for provider ("" when none).
func (c config) providerModel(provider string) string {
	switch provider {
	case providerFake:
		return fake.DefaultModel
	case providerOpenAI:
		return c.OpenAI.Model
	case providerAnthropic:
		return c.Anthropic.Model
	}
	return c.CLI[provider].Model
}

// migratedFeatures names the enabled features that bring migrations of
// their own (store.MigrateFeatures runs them at startup).
func (c config) migratedFeatures() []string {
	var out []string
	for _, f := range c.Features {
		if _, ok := store.FeatureExtension(f.Name()); ok {
			out = append(out, f.Name())
		}
	}
	return out
}
