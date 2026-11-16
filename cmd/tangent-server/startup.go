package main

import (
	"fmt"
	"log/slog"
	"strings"
)

// webDevURL is where `pnpm -C web dev` serves the demo UI (DESIGN §10).
const webDevURL = "http://localhost:5183"

// startupSummary is the readable banner logged once the server listens: where
// it listens, how it is guarded, which providers run and how many models each
// offers, the default, job and fallback models, and where the web UI is. It
// is pure (configuration in, lines out) and carries no secrets.
func startupSummary(cfg config, url string) []string {
	lines := []string{
		"tangent-server ready",
		"  address    " + url,
		"  access     " + accessSummary(cfg),
		"  providers",
	}
	for _, line := range providerSummary(cfg) {
		lines = append(lines, "    "+line)
	}
	lines = append(lines,
		"  default    "+modelRef{Provider: cfg.Provider, Model: cfg.defaultModel()}.String(),
		"  job model  "+orElse(cfg.JobModel.Provider != "", cfg.JobModel.String(), "same as the conversation's"),
		"  fallback   "+orElse(cfg.Fallback.Provider != "", cfg.Fallback.String(), "none"),
		"  web ui     "+webSummary(cfg, url),
	)
	return lines
}

// accessSummary says whether the API needs a token.
func accessSummary(cfg config) string {
	if cfg.Token == "" {
		return "dev mode: no token, loopback only"
	}
	text := "token required (Authorization: Bearer <token>)"
	if cfg.ViewerToken != "" {
		text += ", read-only viewer token set"
	}
	return text
}

// providerSummary is one line per provider: those with a runner and their
// model counts, then the CLI providers that are skipped or off.
func providerSummary(cfg config) []string {
	runners := cfg.runnerProviders()
	catalog := map[string]int{}
	ready := map[string]string{}
	for _, group := range cfg.modelCatalog() {
		catalog[group.Provider] = len(group.Models)
		switch {
		case group.Ready == nil:
		case *group.Ready:
			ready[group.Provider] = " (ready)"
		default:
			ready[group.Provider] = " (not ready: " + group.Reason + ")"
		}
	}
	var lines []string
	for _, name := range []string{providerFake, providerOpenAI, providerAnthropic} {
		if runners[name] {
			lines = append(lines, providerLine(name, catalog[name], ready[name]))
		}
	}
	for _, p := range cliProviders {
		s := cfg.CLI[p.name]
		switch {
		case runners[p.name]:
			lines = append(lines, providerLine(p.name, catalog[p.name], ready[p.name]))
		case cfg.CLIAutodetect:
			lines = append(lines, fmt.Sprintf("%s: skipped (%s binary not found)", p.name, p.executable(s)))
		default:
			lines = append(lines, p.name+": off (set "+p.prefix+"_MODEL or TANGENT_CLI_AUTODETECT=1)")
		}
	}
	return lines
}

func providerLine(name string, models int, status string) string {
	noun := "models"
	if models == 1 {
		noun = "model"
	}
	return fmt.Sprintf("%s: %d %s%s", name, models, noun, status)
}

// webSummary says where the web UI is: served by this process, or started
// with pnpm.
func webSummary(cfg config, url string) string {
	if cfg.StaticDir != "" {
		return "served at " + url + "/ (TANGENT_STATIC_DIR)"
	}
	return "not served here; run `VITE_TANGENT_API=http pnpm -C web dev` and open " + webDevURL
}

func orElse(ok bool, value, otherwise string) string {
	if ok {
		return value
	}
	return otherwise
}

// logStartupSummary logs the banner, one INFO line each.
func logStartupSummary(log *slog.Logger, cfg config, url string) {
	for _, line := range startupSummary(cfg, url) {
		log.Info(line)
	}
}

// Prefixes of the refusals that mean "nothing is configured yet"
// (config.go's checkAccess and checkProvider) and of an unreachable
// database (server.go's connect); explainStartupError matches them.
const (
	errTokenRequired    = "TANGENT_TOKEN is required"
	errProviderRequired = "TANGENT_PROVIDER is required"
	errDatabaseDown     = "cannot reach the database"
)

// startupGuide is what a first-time user needs after the matching refusal.
const startupGuide = `
Nothing is configured yet. Pick one way to start:

  1. Try it with no key and no login (fake replies, loopback only, no token):
       TANGENT_DEV=1 make serve

  2. A Claude Code or Codex subscription (log in once with "claude login" or "codex login"):
       export TANGENT_TOKEN=$(openssl rand -hex 32)
       TANGENT_PROVIDER=claude-cli TANGENT_CLAUDE_CLI_MODEL=sonnet make serve
       (Codex: TANGENT_PROVIDER=codex-cli TANGENT_CODEX_CLI_MODEL=<model>)

  3. An API key:
       export TANGENT_TOKEN=$(openssl rand -hex 32)
       TANGENT_PROVIDER=openai OPENAI_API_KEY=<key> TANGENT_MODEL=<model> make serve
       (Anthropic: TANGENT_PROVIDER=anthropic ANTHROPIC_API_KEY=<key> TANGENT_MODEL=<model>)

.env.example has these as copy-and-paste scenarios A to D; README.md has the full quickstart.`

// databaseGuide is the hint for an unreachable database.
const databaseGuide = `
Start the bundled Postgres with "make db-up" (docker compose, port 5444), or point TANGENT_DATABASE_URL at your own.`

// explainStartupError adds a how-to-start guide to the refusals a first-time
// user hits (no token or provider configured, no database); any other error
// is returned as its own text.
func explainStartupError(err error) string {
	text := err.Error()
	switch {
	case strings.HasPrefix(text, errTokenRequired), strings.HasPrefix(text, errProviderRequired):
		return text + "\n" + startupGuide
	case strings.HasPrefix(text, errDatabaseDown):
		return text + "\n" + databaseGuide
	}
	return text
}
