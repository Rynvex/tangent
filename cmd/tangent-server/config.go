package main

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// Defaults of the reference server.
const (
	defaultAddr        = ":8120"
	defaultDevAddr     = "127.0.0.1:8120"
	defaultDatabaseURL = "postgres://tangent:tangent@localhost:5444/tangent?sslmode=disable"
	defaultTenant      = "default"
	defaultActor       = "operator"
	// minTokenLength keeps guessable tokens out (openssl rand -hex 32 gives 64).
	minTokenLength = 32
)

// providerConfig is one model provider's settings.
type providerConfig struct {
	BaseURL string
	APIKey  string
	Model   string
}

// config is everything the server reads from the environment.
type config struct {
	DatabaseURL    string
	Addr           string
	Token          string
	ViewerToken    string
	Dev            bool
	Tenant         string
	Actor          string
	Provider       string
	OpenAI         providerConfig
	Anthropic      providerConfig
	FakeChunkDelay time.Duration
	JobModel       modelRef
	// Fallback (TANGENT_FALLBACK_MODEL) runs a turn once more when its own
	// provider reports a usage or rate limit; empty: none.
	Fallback      modelRef
	AllowedModels map[modelRef]bool // nil: any model of a configured provider
	// Allowlisted: TANGENT_ALLOWED_MODELS is set, so AllowedModels is
	// strict (no CLI presets or aliases are added).
	Allowlisted  bool
	Features     []tangent.Feature
	FeatureNames []string
	// Embedder names the memory feature's Embedder ("" without memory).
	Embedder         string
	Pricing          map[string]tangent.Price
	RateLimit        int // requests per minute per token
	RateBurst        int
	MaintainInterval time.Duration
	TurnTimeout      time.Duration
	MaxConcurrent    int
	MaxQueue         int
	MaxTenantTurns   int
	MaxStreams       int
	ShutdownTimeout  time.Duration
	StaticDir        string
	// DebugStats mounts GET /debug/stats (behind the token): goroutines,
	// memory, pool and dispatcher counters, for soak runs.
	DebugStats bool
	// CLI are the CLI providers' settings, by provider name (claude-cli,
	// codex-cli, agy-cli); CLIEnv are extra variable names they may see.
	CLI    map[string]cliSettings
	CLIEnv []string
	// CLIAutodetect (TANGENT_CLI_AUTODETECT; on by default with TANGENT_DEV=1)
	// enables every CLI provider whose executable is found at startup.
	CLIAutodetect bool
}

// loadConfig reads the environment; every refusal names the variable.
func loadConfig(getenv func(string) string) (config, error) {
	get := func(key string) string { return strings.TrimSpace(getenv(key)) }
	r := &reader{get: get}
	cfg := config{
		DatabaseURL: cmp.Or(get("TANGENT_DATABASE_URL"), defaultDatabaseURL),
		Token:       get("TANGENT_TOKEN"),
		ViewerToken: get("TANGENT_VIEWER_TOKEN"),
		Dev:         get("TANGENT_DEV") == "1",
		DebugStats:  get("TANGENT_DEBUG_STATS") == "1",
		Tenant:      cmp.Or(get("TANGENT_TENANT"), defaultTenant),
		Actor:       cmp.Or(get("TANGENT_ACTOR"), defaultActor),
		StaticDir:   get("TANGENT_STATIC_DIR"),
		OpenAI: providerConfig{
			BaseURL: get("TANGENT_OPENAI_BASE_URL"), APIKey: cmp.Or(get("TANGENT_OPENAI_API_KEY"), get("OPENAI_API_KEY")),
			Model: get("TANGENT_OPENAI_MODEL"),
		},
		Anthropic: providerConfig{
			BaseURL: get("TANGENT_ANTHROPIC_BASE_URL"), APIKey: cmp.Or(get("TANGENT_ANTHROPIC_API_KEY"), get("ANTHROPIC_API_KEY")),
			Model: get("TANGENT_ANTHROPIC_MODEL"),
		},
		FakeChunkDelay:   r.duration("TANGENT_FAKE_CHUNK_DELAY", 0),
		RateLimit:        r.number("TANGENT_RATE_LIMIT", 600),
		RateBurst:        r.number("TANGENT_RATE_BURST", 60),
		MaintainInterval: r.duration("TANGENT_MAINTAIN_INTERVAL", time.Minute),
		TurnTimeout:      r.duration("TANGENT_TURN_TIMEOUT", tangent.DefaultTurnTimeout),
		MaxConcurrent:    r.number("TANGENT_MAX_CONCURRENT", 8),
		MaxQueue:         r.number("TANGENT_MAX_QUEUE", tangent.DefaultMaxQueue),
		MaxTenantTurns:   r.number("TANGENT_MAX_TENANT_TURNS", tangent.DefaultMaxTenantTurns),
		MaxStreams:       r.number("TANGENT_MAX_STREAMS", 64),
		ShutdownTimeout:  r.duration("TANGENT_SHUTDOWN_TIMEOUT", 30*time.Second),
	}
	if r.err != nil {
		return config{}, r.err
	}
	steps := []func(*config, func(string) string) error{checkAccess, readCLI, checkProvider, readModels, readFeatures, readPricing}
	for _, step := range steps {
		if err := step(&cfg, get); err != nil {
			return config{}, err
		}
	}
	return cfg, nil
}

// reader parses numbers and durations, keeping the first error.
type reader struct {
	get func(string) string
	err error
}

func (r *reader) number(key string, fallback int) int {
	text := r.get(key)
	if text == "" {
		return fallback
	}
	n, err := strconv.Atoi(text)
	if err != nil || n <= 0 {
		r.fail(fmt.Errorf("%s must be a positive whole number, got %q", key, text))
		return fallback
	}
	return n
}

func (r *reader) duration(key string, fallback time.Duration) time.Duration {
	text := r.get(key)
	if text == "" {
		return fallback
	}
	d, err := time.ParseDuration(text)
	if err != nil || d < 0 {
		r.fail(fmt.Errorf("%s must be a duration such as 30s or 5m, got %q", key, text))
		return fallback
	}
	return d
}

func (r *reader) fail(err error) {
	if r.err == nil {
		r.err = err
	}
}

// checkAccess decides the address and whether a token is required: only a
// dev server listening on loopback may run without one.
func checkAccess(cfg *config, get func(string) string) error {
	cfg.Addr = get("TANGENT_ADDR")
	if cfg.Addr == "" {
		cfg.Addr = defaultAddr
		if cfg.Dev && cfg.Token == "" {
			cfg.Addr = defaultDevAddr
		}
	}
	switch {
	case cfg.Token != "" && len(cfg.Token) < minTokenLength:
		return fmt.Errorf("TANGENT_TOKEN must be at least %d characters (for example: openssl rand -hex 32)", minTokenLength)
	case cfg.ViewerToken != "" && len(cfg.ViewerToken) < minTokenLength:
		return fmt.Errorf("TANGENT_VIEWER_TOKEN must be at least %d characters (for example: openssl rand -hex 32)", minTokenLength)
	case cfg.ViewerToken != "" && cfg.ViewerToken == cfg.Token:
		return errors.New("TANGENT_VIEWER_TOKEN must differ from TANGENT_TOKEN")
	case cfg.ViewerToken != "" && cfg.Token == "":
		return errors.New("TANGENT_VIEWER_TOKEN needs TANGENT_TOKEN as well")
	case cfg.Token != "":
		return nil
	case !cfg.Dev:
		return errors.New("TANGENT_TOKEN is required (clients send it as Authorization: Bearer <token>); set TANGENT_DEV=1 and listen on 127.0.0.1 to run without one")
	case !loopback(cfg.Addr):
		return fmt.Errorf("TANGENT_TOKEN is required when listening on %s; without a token TANGENT_ADDR must be a loopback address such as 127.0.0.1:8120", cfg.Addr)
	}
	return nil
}

// loopback reports whether addr only listens on this machine.
func loopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Provider names.
const (
	providerFake      = "fake"
	providerOpenAI    = "openai"
	providerAnthropic = "anthropic"
)

// checkProvider checks the default provider has what it needs.
func checkProvider(cfg *config, get func(string) string) error {
	cfg.Provider = strings.ToLower(get("TANGENT_PROVIDER"))
	if cfg.Provider == "" && cfg.Dev {
		cfg.Provider = providerFake
	}
	model := get("TANGENT_MODEL")
	switch cfg.Provider {
	case providerFake:
		return nil
	case providerOpenAI:
		cfg.OpenAI.Model = cmp.Or(model, cfg.OpenAI.Model)
		return needModel(cfg.OpenAI.Model)
	case providerAnthropic:
		cfg.Anthropic.Model = cmp.Or(model, cfg.Anthropic.Model)
		if cfg.Anthropic.APIKey == "" {
			return errors.New("TANGENT_PROVIDER=anthropic needs ANTHROPIC_API_KEY (or TANGENT_ANTHROPIC_API_KEY)")
		}
		return needModel(cfg.Anthropic.Model)
	case "":
		return errors.New("TANGENT_PROVIDER is required: " + providerNames)
	}
	if isCLIProvider(cfg.Provider) {
		cfg.CLI = cfg.withCLIModel(cfg.Provider, cmp.Or(model, cfg.CLI[cfg.Provider].Model))
		return needModel(cfg.CLI[cfg.Provider].Model)
	}
	return fmt.Errorf("TANGENT_PROVIDER must be %s, got %q", providerNames, cfg.Provider)
}

func needModel(model string) error {
	if model == "" {
		return errors.New("TANGENT_MODEL is required for this provider (the model conversations use when they name none)")
	}
	return nil
}

// buildConfiguredFeature is buildFeature, with memory's Embedder read from
// the environment.
func buildConfiguredFeature(cfg *config, get func(string) string, name, modeText string, hasMode bool) (tangent.Feature, error) {
	if name != tangent.FeatureMemory {
		return buildFeature(name, modeText, hasMode, cfg.JobModel.options())
	}
	mode, ok := modes[strings.ToLower(cmp.Or(modeText, "suggest"))]
	if !ok {
		return nil, fmt.Errorf("unknown mode %q for memory (off, manual, suggest or auto)", modeText)
	}
	embedder, err := readEmbedder(cfg, get)
	if err != nil {
		return nil, err
	}
	return tangent.Memory(mode, tangent.MemoryConfig{Embedder: embedder}, cfg.JobModel.options()...), nil
}

// defaultFeatures is the standard preset (presets.go) and what an unset
// TANGENT_FEATURES means: tangent.AllFeatures (glossary among them, B24) plus search, the P1 features
// (leaf, parking, spinoff, rebalance), the P2 ones (goal, relations,
// open_loops, group), the P3 ones of B10 (ibis, fold, diverge) and memo
// (B13, focus mode's memos), as
// TANGENT_FEATURES would say it. memory stays off (it needs a real
// Embedder to be useful: TANGENT_FEATURES=…,memory with TANGENT_EMBEDDER).
// fisheye stays
// off until the evaluation clears it (TANGENT_FEATURES=…,fisheye). Search needs the pg_trgm
// extension (the server installs it at startup); leave it out of
// TANGENT_FEATURES on a database without it. suggestion_probe (tests and
// e2e only) is never on by default.
const defaultFeatures = "notes,chapters,aside,summary:suggest,card_draft,branch_suggest:suggest,glossary,search,leaf:suggest,parking,spinoff,rebalance:suggest," +
	"goal:suggest,relations:suggest,open_loops,group:suggest,ibis:suggest,fold:suggest,diverge:manual,memo"

var modes = map[string]tangent.Mode{
	"off": tangent.ModeOff, "manual": tangent.ModeManual, "suggest": tangent.ModeSuggest, "auto": tangent.ModeAuto,
}

// buildFeature builds one feature; jobs are the options of the features
// that run jobs (summary, card_draft, leaf, goal, relations, group, ibis,
// fold, diverge).
func buildFeature(name, modeText string, hasMode bool, jobs []tangent.FeatureOption) (tangent.Feature, error) {
	plain := map[string]func() tangent.Feature{
		tangent.FeatureNotes: tangent.Notes, tangent.FeatureChapters: tangent.Chapters, tangent.FeatureAside: tangent.Aside,
		tangent.FeatureCardDraft: func() tangent.Feature { return tangent.CardDraft(jobs...) }, tangent.FeatureSearch: tangent.Search,
		tangent.FeatureParking: tangent.Parking, tangent.FeatureSuggestionProbe: tangent.SuggestionProbe, tangent.FeatureSpinoff: tangent.Spinoff,
		tangent.FeatureOpenLoops: tangent.OpenLoops, tangent.FeatureFisheye: tangent.Fisheye, tangent.FeatureMemo: tangent.Memo,
		tangent.FeatureGlossary: tangent.Glossary,
	}
	moded := map[string]func(tangent.Mode) tangent.Feature{
		tangent.FeatureSummary:       func(m tangent.Mode) tangent.Feature { return tangent.Summary(m, jobs...) },
		tangent.FeatureBranchSuggest: func(m tangent.Mode) tangent.Feature { return tangent.BranchSuggest(m) },
		tangent.FeatureLeaf:          func(m tangent.Mode) tangent.Feature { return tangent.Leaf(m, jobs...) },
		tangent.FeatureRebalance:     func(m tangent.Mode) tangent.Feature { return tangent.Rebalance(m) },
		tangent.FeatureGoal:          func(m tangent.Mode) tangent.Feature { return tangent.Goal(m, jobs...) },
		tangent.FeatureRelations:     func(m tangent.Mode) tangent.Feature { return tangent.Relations(m, jobs...) },
		tangent.FeatureGroup:         func(m tangent.Mode) tangent.Feature { return tangent.Group(m, jobs...) },
		tangent.FeatureIbis:          func(m tangent.Mode) tangent.Feature { return tangent.Ibis(m, jobs...) },
		tangent.FeatureFold:          func(m tangent.Mode) tangent.Feature { return tangent.Fold(m, jobs...) },
		tangent.FeatureDiverge:       func(m tangent.Mode) tangent.Feature { return tangent.Diverge(m, jobs...) },
	}
	if build, ok := plain[name]; ok {
		if hasMode {
			return nil, fmt.Errorf("%s has no mode (it is on or off)", name)
		}
		return build(), nil
	}
	build, ok := moded[name]
	if !ok {
		return nil, fmt.Errorf("unknown feature %q (or a preset: %s)", name, presetNames)
	}
	mode, ok := modes[strings.ToLower(cmp.Or(modeText, "suggest"))]
	if !ok {
		return nil, fmt.Errorf("unknown mode %q for %s (off, manual, suggest or auto)", modeText, name)
	}
	return build(mode), nil
}

// readPricing parses TANGENT_PRICING: {"model": {"input": 3, "output": 15,
// "cacheRead": 0.3, "cacheWrite": 3.75}} in USD per million tokens.
func readPricing(cfg *config, get func(string) string) error {
	text := get("TANGENT_PRICING")
	if text == "" {
		return nil
	}
	var prices map[string]tangent.Price
	if err := json.Unmarshal([]byte(text), &prices); err != nil {
		return fmt.Errorf("TANGENT_PRICING must be a JSON object of model prices: %w", err)
	}
	for model, p := range prices {
		if p.Input < 0 || p.Output < 0 || p.CacheRead < 0 || p.CacheWrite < 0 {
			return fmt.Errorf("TANGENT_PRICING: the price of %s is negative", model)
		}
	}
	cfg.Pricing = prices
	return nil
}

// String summarises the configuration for the startup log, without secrets.
func (c config) String() string {
	token := "none (dev, loopback only)"
	if c.Token != "" {
		token = "set"
	}
	viewer := "none"
	if c.ViewerToken != "" {
		viewer = "set"
	}
	fallback := "none"
	if c.Fallback.Provider != "" {
		fallback = c.Fallback.String()
	}
	return fmt.Sprintf("addr=%s token=%s viewerToken=%s tenant=%s provider=%s jobModel=%s fallbackModel=%s cliAutodetect=%v features=%s embedder=%q pricing=%d static=%q debugStats=%v",
		c.Addr, token, viewer, c.Tenant, c.Provider, c.JobModel, fallback, c.CLIAutodetect, strings.Join(c.FeatureNames, ","), c.Embedder, len(c.Pricing), c.StaticDir, c.DebugStats)
}
