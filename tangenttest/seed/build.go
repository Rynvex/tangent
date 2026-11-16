package seed

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type lineRow struct {
	id, title  string
	activityAt time.Time
}

type messageRow struct {
	id, lineID, role, kind, content string
	meta                            []byte
	at                              time.Time
}

type branchRow struct {
	lineID, parentID, anchorID, purpose, kind, status, origin string
	depth                                                     int
	pack                                                      []byte
	cardID, conclusion                                        string
	at                                                        time.Time
}

// build lays out the main line, then the branches: a first chain down to
// MaxDepth, the rest on random parents.
func (p *plan) build() {
	main := &lineState{id: p.id(), open: true}
	p.tree.MainID = main.id
	p.byLine[main.id] = main
	p.lines = append(p.lines, lineRow{id: main.id, title: p.cfg.Title, activityAt: p.at(p.cfg.MainMessages)})
	main.messages = p.chat(main.id, p.cfg.MainMessages, 0)
	p.tree.MainMessages = append([]string{}, main.messages...)
	parent := main
	for i := 0; i < p.cfg.Branches; i++ {
		if i >= p.cfg.MaxDepth || parent.depth >= p.cfg.MaxDepth {
			parent = p.randomParent()
		}
		parent = p.branch(parent, i)
	}
}

// randomParent is the main line a third of the time, else a branch that
// can still have children, preferring an open one with room (so the tree
// keeps plenty of open branches).
func (p *plan) randomParent() *lineState {
	if p.rng.IntN(3) == 0 || len(p.tree.Branches) == 0 {
		return p.byLine[p.tree.MainID]
	}
	var fallback *lineState
	for range 30 {
		b := p.tree.Branches[p.rng.IntN(len(p.tree.Branches))]
		if b.Depth >= p.cfg.MaxDepth || b.Kind == "aside" {
			continue
		}
		state := p.byLine[b.LineID]
		if state.open && state.openKids < p.cfg.OpenPerParent {
			return state
		}
		fallback = state
	}
	if fallback != nil {
		return fallback
	}
	return p.byLine[p.tree.MainID]
}

// branch adds one branch under parent and returns its line.
func (p *plan) branch(parent *lineState, n int) *lineState {
	kind := []string{"investigate", "investigate", "alternative", "aside"}[p.rng.IntN(4)]
	if n < p.cfg.MaxDepth {
		kind = "investigate" // the first chain reaches MaxDepth; an aside has no children
	}
	status := p.status(parent, kind)
	child := &lineState{id: p.id(), depth: parent.depth + 1, open: status == "open"}
	p.byLine[child.id] = child
	anchor := parent.messages[p.rng.IntN(len(parent.messages))]
	purpose := fmt.Sprintf("branch %d: %s", n+1, sentence(p.rng, 4))
	count := 2 + 2*p.rng.IntN(p.cfg.BranchMessages/2)
	if kind == "aside" {
		count = 2
	}
	at := p.at(p.cfg.MainMessages + n*p.cfg.BranchMessages)
	child.messages = p.chat(child.id, count, p.cfg.MainMessages+n*p.cfg.BranchMessages)
	row := branchRow{
		lineID: child.id, parentID: parent.id, anchorID: anchor, purpose: purpose, kind: kind, status: status,
		origin: "button", depth: child.depth, pack: p.pack(anchor, purpose), at: at,
	}
	if status == "merged" {
		row.cardID, row.conclusion = p.card(parent.id, purpose, at.Add(time.Duration(count)*time.Minute))
	}
	p.lines = append(p.lines, lineRow{id: child.id, title: purpose, activityAt: at.Add(time.Duration(count) * time.Minute)})
	p.branches = append(p.branches, row)
	p.tree.Branches = append(p.tree.Branches, Branch{
		LineID: child.id, ParentLineID: parent.id, AnchorMessageID: anchor, Kind: kind, Status: status, Depth: child.depth, Messages: child.messages,
	})
	return child
}

// status is open when the parent is open and has room (asides are answered
// and so ended), else merged or discarded.
func (p *plan) status(parent *lineState, kind string) string {
	if kind != "aside" && parent.open && parent.openKids < p.cfg.OpenPerParent && p.rng.IntN(10) < 6 {
		parent.openKids++
		return "open"
	}
	if kind != "aside" && p.rng.IntN(3) == 0 {
		return "merged"
	}
	return "discarded"
}

// chat adds count finished messages (operator first) to a line and
// returns their ids.
func (p *plan) chat(lineID string, count, minute int) []string {
	ids := make([]string, 0, count)
	for i := range count {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		id := p.id()
		words := 8 + p.rng.IntN(60)
		p.messages = append(p.messages, messageRow{id: id, lineID: lineID, role: role, kind: "chat", content: sentence(p.rng, words), meta: []byte(`{}`), at: p.at(minute + i)})
		ids = append(ids, id)
	}
	return ids
}

// pack is a plausible stored background.
func (p *plan) pack(anchor, purpose string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"rendered":        "## Branch background (seeded)\n\nPurpose of this branch: " + purpose + "\n\n> " + sentence(p.rng, 120),
		"anchorMessageId": anchor, "purpose": purpose, "recent": []any{}, "tokenEstimate": 400, "tokenBudget": 6000,
	})
	return raw
}

// card writes a delivered conclusion card onto the parent (after its other
// messages) and returns its id and conclusion line.
func (p *plan) card(parentID, purpose string, at time.Time) (string, string) {
	conclusion := "Seeded conclusion: " + sentence(p.rng, 8)
	meta, _ := json.Marshal(map[string]any{
		"card":      map[string]any{"question": purpose, "conclusion": conclusion, "evidence": []any{}, "openItems": []any{}, "needsDecision": []any{}, "excerpts": []any{}},
		"delivered": true,
	})
	id := p.id()
	p.cards = append(p.cards, messageRow{id: id, lineID: parentID, role: "system", kind: "branch_card", content: "## Branch conclusion\n\n" + conclusion, meta: meta, at: at})
	return id, conclusion
}

// copy writes lines, messages (chat, then cards) and branches in one
// transaction.
func (p *plan) copy(ctx context.Context, pool *pgxpool.Pool) error {
	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		lines := make([][]any, 0, len(p.lines))
		for _, l := range p.lines {
			lines = append(lines, []any{l.id, p.cfg.Tenant, l.title, "fake", "fake-1", l.activityAt, l.activityAt})
		}
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"tangent_line"}, []string{"id", "tenant_id", "title", "provider", "model", "last_activity_at", "created_at"}, pgx.CopyFromRows(lines)); err != nil {
			return fmt.Errorf("copy lines: %w", err)
		}
		messages := make([][]any, 0, len(p.messages)+len(p.cards))
		for _, m := range append(p.messages, p.cards...) {
			messages = append(messages, []any{m.id, m.lineID, p.cfg.Tenant, m.role, m.kind, m.content, "done", string(m.meta), m.at})
		}
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"tangent_message"}, []string{"id", "line_id", "tenant_id", "role", "kind", "content", "status", "meta", "created_at"}, pgx.CopyFromRows(messages)); err != nil {
			return fmt.Errorf("copy messages: %w", err)
		}
		return p.copyBranches(ctx, tx)
	})
}

func (p *plan) copyBranches(ctx context.Context, tx pgx.Tx) error {
	rows := make([][]any, 0, len(p.branches))
	for _, b := range p.branches {
		var card, closed any
		if b.cardID != "" {
			card = b.cardID
		}
		if b.status != "open" {
			closed = b.at.Add(time.Hour)
		}
		rows = append(rows, []any{b.lineID, p.cfg.Tenant, b.parentID, p.tree.MainID, b.anchorID, b.purpose, b.kind, b.status, b.depth, b.origin, string(b.pack), card, b.conclusion, closed, b.at})
	}
	columns := []string{"line_id", "tenant_id", "parent_line_id", "root_line_id", "anchor_message_id", "purpose", "kind", "status", "depth", "origin", "pack", "card_message_id", "conclusion_line", "closed_at", "created_at"}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"tangent_branch"}, columns, pgx.CopyFromRows(rows)); err != nil {
		return fmt.Errorf("copy branches: %w", err)
	}
	return nil
}
