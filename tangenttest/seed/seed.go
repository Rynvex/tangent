// Package seed writes a large, reproducible conversation tree straight into
// tangent's tables, for performance budgets and load tests: a main line of
// 2,000 messages and 200 branches down to depth 6 by default, in English,
// Chinese and both mixed. The data keeps DESIGN §5's invariants (anchors on
// finished messages of the parent, open branches only under open ones, at
// most Limits.Branch.MaxOpenPerParent open per parent, a delivered card for
// every merged branch), so every engine call works on it.
package seed

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Config shapes one tree. Zero fields take the defaults.
type Config struct {
	Tenant string
	// Seed makes the tree reproducible: the same seed gives the same ids,
	// texts and shape (two trees in one schema need two seeds).
	Seed uint64
	// MainMessages on the main line (default 2,000).
	MainMessages int
	// Branches in the tree, every status counted (default 200).
	Branches int
	// MaxDepth is the deepest branch; one chain always reaches it (default 6).
	MaxDepth int
	// OpenPerParent caps the open branches under one line (default 4, below
	// the engine's 8, so a promotion that lifts children still fits).
	OpenPerParent int
	// BranchMessages is the most messages of one branch (default 12; each
	// has 2 to that many, in exchanges).
	BranchMessages int
	// Title of the main line (default "Seeded conversation").
	Title string
}

func (c Config) withDefaults() Config {
	c.Tenant = cmp.Or(c.Tenant, "seed")
	c.MainMessages = cmp.Or(c.MainMessages, 2000)
	c.Branches = cmp.Or(c.Branches, 200)
	c.MaxDepth = cmp.Or(c.MaxDepth, 6)
	c.OpenPerParent = cmp.Or(c.OpenPerParent, 4)
	c.BranchMessages = cmp.Or(c.BranchMessages, 12)
	c.Title = cmp.Or(c.Title, "Seeded conversation")
	return c
}

func (c Config) check() error {
	switch {
	case c.MainMessages < 2:
		return errors.New("seed: the main line needs at least 2 messages")
	case c.Branches < 0 || c.MaxDepth < 1 || c.OpenPerParent < 1 || c.BranchMessages < 2:
		return errors.New("seed: branches, depth, open per parent and branch messages must be positive")
	}
	return nil
}

// Tree is what was written.
type Tree struct {
	MainID string
	// MainMessages are the main line's chat messages, oldest first (cards of
	// merged branches follow them on the line).
	MainMessages []string
	// Branches in creation order.
	Branches []Branch
}

// Branch is one seeded branch.
type Branch struct {
	LineID, ParentLineID, AnchorMessageID string
	Kind, Status                          string
	Depth                                 int
	// Messages are its chat messages, oldest first.
	Messages []string
}

// Open returns the open branches, in creation order.
func (t Tree) Open() []Branch {
	out := []Branch{}
	for _, b := range t.Branches {
		if b.Status == "open" {
			out = append(out, b)
		}
	}
	return out
}

// MaxDepth is the deepest branch.
func (t Tree) MaxDepth() int {
	deepest := 0
	for _, b := range t.Branches {
		deepest = max(deepest, b.Depth)
	}
	return deepest
}

// Write builds the tree in memory and copies it into the pool's schema
// (migrated) in one transaction.
func Write(ctx context.Context, pool *pgxpool.Pool, cfg Config) (Tree, error) {
	cfg = cfg.withDefaults()
	if err := cfg.check(); err != nil {
		return Tree{}, err
	}
	p := newPlan(cfg)
	p.build()
	if err := p.copy(ctx, pool); err != nil {
		return Tree{}, fmt.Errorf("seed: %w", err)
	}
	return p.tree, nil
}

// plan is the tree being built before it is copied.
type plan struct {
	cfg      Config
	rng      *rand.Rand
	base     time.Time
	tree     Tree
	lines    []lineRow
	messages []messageRow
	branches []branchRow
	cards    []messageRow
	byLine   map[string]*lineState
}

// lineState is what the planner knows about a line while it builds.
type lineState struct {
	id       string
	depth    int
	open     bool
	openKids int
	messages []string // chat messages a branch may hang on
}

func newPlan(cfg Config) *plan {
	return &plan{
		cfg: cfg, rng: rand.New(rand.NewPCG(cfg.Seed, 0x7a6e)), byLine: map[string]*lineState{},
		base: time.Now().Add(-time.Duration(cfg.MainMessages+cfg.Branches*cfg.BranchMessages) * time.Minute).Truncate(time.Second),
	}
}

func (p *plan) id() string { return newID(p.rng).String() }

// at is the time of the n-th thing written, a minute apart.
func (p *plan) at(n int) time.Time { return p.base.Add(time.Duration(n) * time.Minute) }
