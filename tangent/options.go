package tangent

import (
	"context"
	"log/slog"
	"time"

	"github.com/Rynvex/tangent/domain"
)

// Option configures an Engine.
type Option func(*config)

type config struct {
	limits       domain.Limits
	publisher    Publisher
	contributor  PromptContributor
	gate         TurnGate
	markers      []string
	now          func() time.Time
	logger       *slog.Logger
	features     []Feature
	policy       FeaturePolicy
	staleTurn    time.Duration
	pricing      map[string]Price
	defaults     modelPair
	allowModel   func(provider, model string) bool
	partialEvery time.Duration
	partialBytes int
	catalog      []ModelGroup
	labels       *domain.NoteSourceLabels
	leafTexts    domain.LeafTexts
	deltaSink    DeltaSink
}

func defaultConfig() config {
	return config{
		limits: domain.DefaultLimits(), publisher: nopPublisher{}, now: time.Now, logger: slog.Default(),
		policy: openPolicy{}, staleTurn: DefaultStaleTurnAge, partialEvery: DefaultPartialInterval, partialBytes: DefaultPartialBytes,
	}
}

// DefaultStaleTurnAge is how long a turn may stay pending before Maintain
// fails it; longer than the runner dispatcher's DefaultTurnTimeout.
const DefaultStaleTurnAge = 15 * time.Minute

// WithStaleTurnAge sets how long a turn may stay pending before Maintain
// fails it.
func WithStaleTurnAge(d time.Duration) Option {
	return func(c *config) {
		if d > 0 {
			c.staleTurn = d
		}
	}
}

// WithLimits replaces the limits; fields left at zero take their defaults.
func WithLimits(l domain.Limits) Option {
	return func(c *config) { c.limits = l }
}

// WithPublisher receives every event after its commit.
func WithPublisher(p Publisher) Option {
	return func(c *config) {
		if p != nil {
			c.publisher = p
		}
	}
}

// WithPromptContributor adds the host's sections to every turn prompt.
func WithPromptContributor(p PromptContributor) Option {
	return func(c *config) { c.contributor = p }
}

// WithTurnGate is asked before every turn starts.
func WithTurnGate(g TurnGate) Option {
	return func(c *config) { c.gate = g }
}

// WithExtraMarkers names the host's protocol markers; they are removed from
// every block the library renders into a prompt.
func WithExtraMarkers(markers ...string) Option {
	return func(c *config) { c.markers = append([]string{}, markers...) }
}

// WithClock replaces the engine's and the store's clock (tests).
func WithClock(now func() time.Time) Option {
	return func(c *config) {
		if now != nil {
			c.now = now
		}
	}
}

// WithLogger is where the engine logs what it cannot return (a failed
// publish, a write-back after a crashed run).
func WithLogger(l *slog.Logger) Option {
	return func(c *config) {
		if l != nil {
			c.logger = l
		}
	}
}

// Publisher receives events after their commit.
type Publisher interface {
	Publish(ctx context.Context, ev Event)
}

// PromptContributor adds the host's sections to a turn prompt (for example:
// plan and blackboard blocks).
type PromptContributor interface {
	Contribute(ctx context.Context, scope Scope, line domain.LineView) ([]domain.PromptSection, error)
}

// TurnGate is an advisory check before a turn starts (for example: is the
// daemon online). It runs before the transaction; an error refuses the turn.
type TurnGate interface {
	AllowTurn(ctx context.Context, scope Scope, line domain.LineView) error
}

type nopPublisher struct{}

func (nopPublisher) Publish(context.Context, Event) {}

// WithPartialFlush sets how often a streaming turn saves its text so far on
// the pending message: after interval, or once bytes of new text streamed,
// whichever comes first (checked as deltas arrive).
func WithPartialFlush(interval time.Duration, bytes int) Option {
	return func(c *config) {
		if interval > 0 {
			c.partialEvery = interval
		}
		if bytes > 0 {
			c.partialBytes = bytes
		}
	}
}

// WithLeafTexts sets the templates of the leaves the library writes itself
// (default domain.DefaultLeafTexts, Traditional Chinese;
// domain.EnglishLeafTexts for English): a decision's dead ends.
func WithLeafTexts(texts domain.LeafTexts) Option {
	return func(c *config) { c.leafTexts = texts }
}

// WithNoteSourceLabels sets the templates of the source label a note is
// written with (default domain.DefaultNoteSourceLabels, Traditional
// Chinese; domain.EnglishNoteSourceLabels for English).
func WithNoteSourceLabels(labels domain.NoteSourceLabels) Option {
	return func(c *config) { c.labels = &labels }
}
