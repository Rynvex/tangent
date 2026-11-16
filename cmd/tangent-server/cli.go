package main

import (
	"cmp"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"

	"github.com/Rynvex/tangent/runner/cli"
)

// CLI providers: a command-line AI tool the server's user is logged in to
// with a subscription (runner/cli).
const (
	providerClaudeCLI = "claude-cli"
	providerCodexCLI  = "codex-cli"
	providerAgyCLI    = "agy-cli"
)

// cliProvider is one CLI provider and the prefix of its variables:
// <prefix>_PATH, <prefix>_MODEL, <prefix>_MAX_CONCURRENT.
type cliProvider struct {
	name    string
	prefix  string
	backend cli.Backend
}

var cliProviders = []cliProvider{
	{providerClaudeCLI, "TANGENT_CLAUDE_CLI", cli.Claude},
	{providerCodexCLI, "TANGENT_CODEX_CLI", cli.Codex},
	{providerAgyCLI, "TANGENT_AGY_CLI", cli.Agy},
}

// cliSettings are one CLI provider's settings.
type cliSettings struct {
	Path          string
	Model         string
	MaxConcurrent int
	// Installed: the executable was found when the server started (the
	// runner looks it up again on every run, so installing it later works).
	Installed bool
}

// lookPath finds a CLI's executable (a variable so tests can stand in).
var lookPath = exec.LookPath

// executable is the provider's executable: its _PATH or the backend name.
func (p cliProvider) executable(s cliSettings) string {
	return cmp.Or(s.Path, string(p.backend))
}

// isCLIProvider reports whether name is a CLI provider.
func isCLIProvider(name string) bool {
	for _, p := range cliProviders {
		if p.name == name {
			return true
		}
	}
	return false
}

// providerNames lists every provider, for error messages.
const providerNames = "fake, openai, anthropic, claude-cli, codex-cli or agy-cli"

// readCLI reads the CLI providers' variables and TANGENT_CLI_ENV (extra
// variable names every CLI may see, comma separated).
func readCLI(cfg *config, get func(string) string) error {
	r := &reader{get: get}
	cfg.CLI = map[string]cliSettings{}
	for _, p := range cliProviders {
		s := cliSettings{
			Path: get(p.prefix + "_PATH"), Model: get(p.prefix + "_MODEL"),
			MaxConcurrent: r.number(p.prefix+"_MAX_CONCURRENT", cli.DefaultMaxConcurrent),
		}
		_, err := lookPath(p.executable(s))
		s.Installed = err == nil
		cfg.CLI[p.name] = s
	}
	if r.err != nil {
		return r.err
	}
	autodetect, err := readSwitch(get, "TANGENT_CLI_AUTODETECT", cfg.Dev)
	if err != nil {
		return err
	}
	cfg.CLIAutodetect = autodetect
	for _, name := range strings.Split(get("TANGENT_CLI_ENV"), ",") {
		if name = strings.TrimSpace(name); name != "" {
			cfg.CLIEnv = append(cfg.CLIEnv, name)
		}
	}
	// The same check cli.New makes, here so a bad name fails at startup.
	if _, err := cli.New(cli.Config{Backend: cli.Claude, Env: cfg.CLIEnv}); err != nil {
		return fmt.Errorf("TANGENT_CLI_ENV: %w", err)
	}
	return nil
}

// withCLIModel returns the settings of provider with model as its model.
func (c config) withCLIModel(provider, model string) map[string]cliSettings {
	out := make(map[string]cliSettings, len(c.CLI))
	for name, s := range c.CLI {
		out[name] = s
	}
	s := out[provider]
	s.Model = model
	out[provider] = s
	return out
}

// buildCLIRunners adds a runner for every CLI provider in use.
func buildCLIRunners(cfg config, out routedRunner, providers map[string]bool) error {
	for _, p := range cliProviders {
		if !providers[p.name] {
			continue
		}
		s := cfg.CLI[p.name]
		r, err := cli.New(cli.Config{Backend: p.backend, Path: s.Path, Model: s.Model, MaxConcurrent: s.MaxConcurrent, Env: cfg.CLIEnv})
		if err != nil {
			return fmt.Errorf("%s: %w", p.prefix, err)
		}
		out.runners[p.name] = r
	}
	return nil
}

// readSwitch reads an on/off variable (1, true, on / 0, false, off);
// fallback when it is not set.
func readSwitch(get func(string) string, key string, fallback bool) (bool, error) {
	switch strings.ToLower(get(key)) {
	case "":
		return fallback, nil
	case "1", "true", "on", "yes":
		return true, nil
	case "0", "false", "off", "no":
		return false, nil
	}
	return false, fmt.Errorf("%s must be 1 or 0, got %q", key, get(key))
}

// cliEnabled reports whether a CLI provider gets a runner: it is the
// default provider, has a model (TANGENT_<NAME>_CLI_MODEL), is the job or
// fallback model's provider, or was found on this machine while
// TANGENT_CLI_AUTODETECT is on.
func (c config) cliEnabled(p cliProvider) bool {
	s := c.CLI[p.name]
	return c.Provider == p.name || s.Model != "" || c.JobModel.Provider == p.name || c.Fallback.Provider == p.name ||
		(c.CLIAutodetect && s.Installed)
}

// logCLIStatus says at startup which CLI providers run and which are
// missing: a missing CLI never stops the server, its runs fail until it is
// installed (GET /capabilities reports it not ready).
func logCLIStatus(log *slog.Logger, cfg config) {
	runners := cfg.runnerProviders()
	for _, p := range cliProviders {
		s := cfg.CLI[p.name]
		switch {
		case runners[p.name] && s.Installed:
			log.Info("tangent-server: CLI provider ready", "provider", p.name, "executable", p.executable(s))
		case runners[p.name]:
			log.Warn("tangent-server: CLI provider configured but its executable was not found; its runs fail until it is installed", "provider", p.name, "executable", p.executable(s))
		case cfg.CLIAutodetect:
			log.Info("tangent-server: CLI provider skipped: executable not found", "provider", p.name, "executable", p.executable(s))
		}
	}
}
