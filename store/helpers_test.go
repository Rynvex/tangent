package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangenttest"
)

const (
	tenant      = "tenant-a"
	otherTenant = "tenant-b"
)

// fixture is one migrated schema with a store over it.
type fixture struct {
	t     *testing.T
	ctx   context.Context
	pool  *pgxpool.Pool
	store *store.Store
}

func newFixture(t *testing.T, opts ...store.Option) *fixture {
	t.Helper()
	pool := tangenttest.Open(t)
	s, err := store.New(pool, domain.DefaultLimits(), opts...)
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t: t, ctx: tangenttest.Context(t), pool: pool, store: s}
}

// exec runs raw SQL to set up a state the API would refuse to create.
func (f *fixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.pool.Exec(f.ctx, sql, args...); err != nil {
		f.t.Fatalf("exec %q: %v", sql, err)
	}
}

func (f *fixture) count(sql string, args ...any) int {
	f.t.Helper()
	var n int
	if err := f.pool.QueryRow(f.ctx, sql, args...).Scan(&n); err != nil {
		f.t.Fatalf("count %q: %v", sql, err)
	}
	return n
}

// mainLine creates a main line with one operator message and one finished
// assistant reply and returns the line and the reply (a valid anchor).
func (f *fixture) mainLine() (domain.LineView, domain.Message) {
	f.t.Helper()
	line, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant, Title: "main", Provider: "anthropic", Model: "sonnet", CreatedBy: "chang"})
	if err != nil {
		f.t.Fatal(err)
	}
	return line, f.reply(line.ID)
}

// reply adds a finished operator message and assistant reply and returns the reply.
func (f *fixture) reply(lineID string) domain.Message {
	f.t.Helper()
	f.message(lineID, domain.RoleUser, "question")
	return f.message(lineID, domain.RoleAssistant, "answer")
}

// exchange adds an operator message and a reply with the given texts and
// returns the reply.
func (f *fixture) exchange(lineID, question, answer string) domain.Message {
	f.t.Helper()
	f.message(lineID, domain.RoleUser, question)
	return f.message(lineID, domain.RoleAssistant, answer)
}

func (f *fixture) message(lineID, role, content string) domain.Message {
	f.t.Helper()
	message, err := f.store.InsertMessage(f.ctx, tenant, lineID, store.NewMessage{Role: role, Content: content})
	if err != nil {
		f.t.Fatal(err)
	}
	return message
}

// card inserts an undelivered conclusion card into the line.
func (f *fixture) card(lineID string) domain.Message {
	f.t.Helper()
	card := domain.BranchCard{Question: "q", Conclusion: "c"}
	message, err := f.store.InsertMessage(f.ctx, tenant, lineID, store.NewMessage{
		Role: domain.RoleSystem, Kind: domain.MessageKindBranchCard, Content: "card", Meta: domain.MessageMeta{Card: &card},
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return message
}

func (f *fixture) branchInput(parentID, anchorID string) store.CreateBranchInput {
	return store.CreateBranchInput{
		Tenant: tenant, ParentLineID: parentID, AnchorMessageID: anchorID, Purpose: "check it", Kind: domain.BranchKindInvestigate,
		Origin: domain.BranchOriginButton, Model: "haiku", CreatedBy: "chang",
		Pack: domain.BranchPack{Rendered: "pack text", AnchorMessageID: anchorID},
	}
}

func (f *fixture) branch(parentID, anchorID string) domain.LineView {
	f.t.Helper()
	created, err := f.store.CreateBranch(f.ctx, f.branchInput(parentID, anchorID))
	if err != nil {
		f.t.Fatal(err)
	}
	return created.Line
}

// openBranch creates a main line and a branch with one exchange in it.
func (f *fixture) openBranch() (domain.LineView, domain.LineView) {
	f.t.Helper()
	parent, anchor := f.mainLine()
	branch := f.branch(parent.ID, anchor.ID)
	f.reply(branch.ID)
	return parent, branch
}

// insertBranchDirect adds a branch row without the limit checks.
func (f *fixture) insertBranchDirect(parentID, rootID, anchorID string, depth int, status string) string {
	f.t.Helper()
	id := uuid.NewString()
	f.exec(`INSERT INTO tangent_line (id, tenant_id, title) VALUES ($1, $2, 'b')`, id, tenant)
	f.exec(`INSERT INTO tangent_branch (line_id, tenant_id, parent_line_id, root_line_id, anchor_message_id, purpose, kind, depth, origin, status, closed_at)
		VALUES ($1, $2, $3, $4, $5, 'p', 'investigate', $6, 'button', $7, CASE WHEN $7 = 'open' THEN NULL ELSE now() END)`, id, tenant, parentID, rootID, anchorID, depth, status)
	return id
}

// busy leaves a pending turn on the line.
func (f *fixture) busy(lineID string) store.BegunTurn {
	f.t.Helper()
	turn, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: lineID, Content: "still going"})
	if err != nil {
		f.t.Fatal(err)
	}
	return turn
}

// answer completes a turn successfully.
func (f *fixture) answer(turnID, content string) store.CompletedTurn {
	f.t.Helper()
	done, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: turnID, Outcome: domain.ResolveTurnOutcome(content, "")})
	if err != nil {
		f.t.Fatal(err)
	}
	return done
}

// texts lists the contents of a line's messages in seq order.
func (f *fixture) texts(lineID string) []string {
	f.t.Helper()
	messages, err := f.store.ListMessages(f.ctx, tenant, lineID, 0, 500)
	if err != nil {
		f.t.Fatal(err)
	}
	out := make([]string, 0, len(messages))
	for _, message := range messages {
		out = append(out, message.Content)
	}
	return out
}

func (f *fixture) line(id string) domain.LineView {
	f.t.Helper()
	line, err := f.store.GetLine(f.ctx, tenant, id)
	if err != nil {
		f.t.Fatal(err)
	}
	return line
}

func (f *fixture) branchView(id string) domain.BranchView {
	f.t.Helper()
	detail, err := f.store.GetBranch(f.ctx, tenant, id)
	if err != nil {
		f.t.Fatal(err)
	}
	return detail.Branch
}

func (f *fixture) parentTip(lineID string) string {
	f.t.Helper()
	tip, err := f.store.ParentTipMessageID(f.ctx, tenant, lineID)
	if err != nil {
		f.t.Fatal(err)
	}
	return tip
}

func (f *fixture) cardsIn(lineID string) int {
	f.t.Helper()
	return f.count(`SELECT count(*) FROM tangent_message WHERE line_id = $1 AND kind = 'branch_card'`, lineID)
}

// fakeClock is a settable clock for draft timeouts.
type fakeClock struct{ now time.Time }

func (c *fakeClock) Now() time.Time { return c.now }

// failingHook is a transaction hook that refuses the write.
func failingHook(err error) store.TxHook {
	return func(context.Context, store.Tx, any) error { return err }
}
