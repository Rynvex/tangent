package tangent_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// The glossary (B24): one "term → explanation" list per conversation; only
// the terms reach a prompt, in a trailing block.

// glossaryFeatures: the first batch (glossary among them), asides kept by
// B23's rules, spinoff for the moves.
func glossaryFeatures() []tangent.Feature {
	return append(tangent.AllFeatures(), tangent.Spinoff())
}

// glossaryEnv has the glossary features and a switch to turn any off.
func glossaryEnv(t *testing.T, opts ...tangent.Option) (*env, *switchPolicy) {
	t.Helper()
	policy := &switchPolicy{off: map[string]bool{}}
	return newEnvWith(t, glossaryFeatures(), append(opts, tangent.WithFeaturePolicy(policy))...), policy
}

func (e *env) saveTerm(lineID, term, explanation string) tangent.TermChange {
	e.t.Helper()
	out, err := e.engine.CreateTerm(e.ctx, scopeA, lineID, tangent.TermInput{Term: term, Explanation: explanation})
	if err != nil {
		e.t.Fatal(err)
	}
	return out
}

func TestGlossary_IsInAllFeatures(t *testing.T) {
	for _, f := range tangent.AllFeatures() {
		if f.Name() == tangent.FeatureGlossary {
			if f.AI() {
				t.Fatal("the glossary has no AI (DESIGN §12.10 D3)")
			}
			return
		}
	}
	t.Fatal("AllFeatures lacks the glossary (DESIGN §12.10 D4)")
}

func TestGlossary_TermsAreSavedListedEditedAndDeleted(t *testing.T) {
	e, _ := glossaryEnv(t)
	main := e.mainLine()
	turn := e.turn(main.ID, "what is MVCC?", "multi-version concurrency control")
	branch := e.branch(main.ID, turn.Message.ID, "Compare the engines")
	e.events.Reset()

	saved, err := e.engine.CreateTerm(e.ctx, scopeA, branch.Line.ID, tangent.TermInput{Term: "  MVCC ", Explanation: " versions\r\nof rows ", SourceMessageID: branch.Line.ID})
	wantCode(t, err, domain.CodeMessageNotFound)
	answer := e.turn(branch.Line.ID, "and WAL?", "write-ahead log")
	e.events.Reset()
	saved, err = e.engine.CreateTerm(e.ctx, scopeA, branch.Line.ID, tangent.TermInput{Term: "  MVCC ", Explanation: " versions\r\nof rows ", SourceMessageID: answer.Message.ID})
	if err != nil {
		t.Fatal(err)
	}
	term := saved.Term
	if saved.Change != tangent.TermCreated || saved.Kept != nil || term.Term != "MVCC" || term.TermKey != "mvcc" || term.Explanation != "versions\nof rows" {
		t.Fatalf("saved = %+v", saved)
	}
	if term.RootLineID != main.ID || term.SourceLineID != branch.Line.ID || term.SourceMessageID != answer.Message.ID || term.CreatedBy != "chang" {
		t.Fatalf("term = %+v", term)
	}
	if !strings.Contains(term.SourceLabel, "Compare the engines") {
		t.Fatalf("label = %q", term.SourceLabel)
	}
	e.wantTypes(tangent.EventTermsChanged)
	ev := e.events.Events()[0]
	if change := ev.Data.(tangent.TermsChange); change != (tangent.TermsChange{RootLineID: main.ID, TermID: term.ID, Change: tangent.TermCreated}) || ev.LineID != branch.Line.ID || ev.RootLineID != main.ID {
		t.Fatalf("event = %+v", ev)
	}
	e.saveTerm(main.ID, "B-tree", "a balanced tree")

	list, err := e.engine.ListTerms(e.ctx, scopeA, branch.Line.ID)
	if err != nil || list.RootLineID != main.ID || len(list.Terms) != 2 || list.Terms[0].Term != "B-tree" || list.Terms[1].ID != term.ID {
		t.Fatalf("list in key order: %+v %v", list, err)
	}

	renamed := "Multi-version CC"
	edited, err := e.engine.UpdateTerm(e.ctx, scopeA, term.ID, tangent.TermPatch{Term: &renamed})
	if err != nil || edited.Term.Term != renamed || edited.Term.TermKey != "multi-versioncc" || edited.Term.Explanation != "versions\nof rows" || edited.Change != tangent.TermUpdated {
		t.Fatalf("edited: %+v %v", edited, err)
	}
	clash := "b - TREE"
	_, err = e.engine.UpdateTerm(e.ctx, scopeA, term.ID, tangent.TermPatch{Term: &clash})
	wantCode(t, err, domain.CodeTermExists)
	_, err = e.engine.UpdateTerm(e.ctx, scopeA, term.ID, tangent.TermPatch{})
	wantCode(t, err, domain.CodeInvalidInput)

	e.events.Reset()
	deleted, err := e.engine.DeleteTerm(e.ctx, scopeA, term.ID)
	if err != nil || deleted.Term.ID != term.ID || deleted.Change != tangent.TermDeleted {
		t.Fatalf("deleted: %+v %v", deleted, err)
	}
	e.wantTypes(tangent.EventTermsChanged)
	_, err = e.engine.DeleteTerm(e.ctx, scopeA, term.ID)
	wantCode(t, err, domain.CodeTermNotFound)
	_, err = e.engine.UpdateTerm(e.ctx, scopeA, "not-a-uuid", tangent.TermPatch{Term: &renamed})
	wantCode(t, err, domain.CodeTermNotFound)
	_, err = e.engine.DeleteTerm(e.ctx, scopeB, list.Terms[0].ID)
	wantCode(t, err, domain.CodeTermNotFound)
	_, err = e.engine.ListTerms(e.ctx, scopeB, main.ID)
	wantCode(t, err, domain.CodeLineNotFound)
}

func TestGlossary_ASecondSaveIsTermExistsUnlessItReplaces(t *testing.T) {
	e, _ := glossaryEnv(t)
	main := e.mainLine()
	turn := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, turn.Message.ID, "Elsewhere")
	first := e.saveTerm(main.ID, "WAL", "first")

	_, err := e.engine.CreateTerm(e.ctx, scopeA, branch.Line.ID, tangent.TermInput{Term: "w a l", Explanation: "second"})
	wantCode(t, err, domain.CodeTermExists)
	if extra := domain.AsError(err, domain.DefaultLimits()).Extra["term"].(domain.Term); extra.ID != first.Term.ID || extra.Explanation != "first" {
		t.Fatalf("extra = %+v", extra)
	}
	e.events.Reset()
	replaced, err := e.engine.CreateTerm(e.ctx, scopeA, branch.Line.ID, tangent.TermInput{Term: "w a l", Explanation: "second", Replace: true})
	if err != nil || replaced.Change != tangent.TermUpdated || replaced.Term.ID != first.Term.ID || replaced.Term.Term != "WAL" {
		t.Fatalf("replaced: %+v %v", replaced, err)
	}
	if replaced.Term.Explanation != "second" || replaced.Term.SourceLineID != branch.Line.ID || replaced.Term.SourceLabel == first.Term.SourceLabel {
		t.Fatalf("replace overwrites the explanation and the source: %+v", replaced.Term)
	}
	if change := e.events.Events()[0].Data.(tangent.TermsChange); change.Change != tangent.TermUpdated {
		t.Fatalf("event = %+v", change)
	}
}

func TestGlossary_TheCapTheTextLimitsAndArchivedConversations(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Glossary.MaxPerTree = 2
	e, _ := glossaryEnv(t, tangent.WithLimits(limits))
	main := e.mainLine()
	e.saveTerm(main.ID, "one", "x")
	e.saveTerm(main.ID, "two", "x")
	_, err := e.engine.CreateTerm(e.ctx, scopeA, main.ID, tangent.TermInput{Term: "three", Explanation: "x"})
	wantCode(t, err, domain.CodeTermLimit)
	if got := domain.AsError(err, limits).Extra["limit"]; got != 2 {
		t.Fatalf("limit extra = %v", got)
	}
	_, err = e.engine.CreateTerm(e.ctx, scopeA, main.ID, tangent.TermInput{Term: " ", Explanation: "x"})
	wantCode(t, err, domain.CodeInvalidInput)
	_, err = e.engine.CreateTerm(e.ctx, scopeA, main.ID, tangent.TermInput{Term: strings.Repeat("字", 61), Explanation: "x"})
	wantCode(t, err, domain.CodeTooLong)
	_, err = e.engine.CreateTerm(e.ctx, scopeA, main.ID, tangent.TermInput{Term: "x", Explanation: strings.Repeat("a", 1001)})
	wantCode(t, err, domain.CodeTooLong)

	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, true); err != nil {
		t.Fatal(err)
	}
	list, err := e.engine.ListTerms(e.ctx, scopeA, main.ID)
	if err != nil || len(list.Terms) != 2 {
		t.Fatalf("an archived conversation still reads: %+v %v", list, err)
	}
	_, err = e.engine.DeleteTerm(e.ctx, scopeA, list.Terms[0].ID)
	wantCode(t, err, domain.CodeArchived)
	_, err = e.engine.CreateTerm(e.ctx, scopeA, main.ID, tangent.TermInput{Term: "y", Explanation: "x"})
	wantCode(t, err, domain.CodeArchived)
	if page, err := e.engine.SearchTerms(e.ctx, scopeA, tangent.TermQuery{}); err != nil || len(page.Terms) != 0 {
		t.Fatalf("an archived conversation is not searched: %+v %v", page, err)
	}
}

func TestGlossary_SavingFromAnAsideKeepsItFromThePurge(t *testing.T) {
	shift := time.Duration(0)
	e := newEnvWith(t, glossaryFeatures(), tangent.WithClock(func() time.Time { return time.Now().Add(shift) }))
	_, _, aside := e.answeredAside()
	e.events.Reset()
	saved := e.saveTerm(aside.Line.ID, "connection pool", "reused connections")
	if saved.Kept == nil || saved.Kept.KeptAt == nil {
		t.Fatalf("saved = %+v", saved)
	}
	e.wantTypes(tangent.EventTermsChanged, tangent.EventBranchChanged)
	if e.events.Events()[1].Data.(tangent.BranchChange).Change != tangent.BranchKept {
		t.Fatalf("events = %+v", e.events.Events())
	}
	shift = 2 * domain.DefaultLimits().Branch.AsideRetention
	if n := e.purged(); n != 0 {
		t.Fatalf("a saved aside was purged (%d)", n)
	}
	e.events.Reset()
	e.saveTerm(aside.Line.ID, "pool size", "x")
	e.wantTypes(tangent.EventTermsChanged)
	e.rollsBack("CreateTerm", func(opt tangent.TxOption) error {
		_, err := e.engine.CreateTerm(e.ctx, scopeA, aside.Line.ID, tangent.TermInput{Term: "z", Explanation: "x"}, opt)
		return err
	})
}

func TestGlossary_SearchFindsTheTenantsTermsWithTheirConversation(t *testing.T) {
	e, _ := glossaryEnv(t)
	main := e.mainLine()
	e.saveTerm(main.ID, "Prompt cache", "x")
	e.saveTerm(main.ID, "cache line", "x")
	other, err := e.engine.CreateLine(e.ctx, scopeB, tangent.LineInput{Title: "B", Provider: "fake", Model: "fake-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.CreateTerm(e.ctx, scopeB, other.ID, tangent.TermInput{Term: "cache", Explanation: "x"}); err != nil {
		t.Fatal(err)
	}
	page, err := e.engine.SearchTerms(e.ctx, scopeA, tangent.TermQuery{Query: "Cache"})
	if err != nil || len(page.Terms) != 2 || page.Terms[0].Term.Term != "cache line" || page.Terms[0].RootTitle != main.Title {
		t.Fatalf("page = %+v %v", page, err)
	}
}

func TestGlossary_ThePromptCarriesOnlyTheTermsInTheTrailingBlock(t *testing.T) {
	e, _ := glossaryEnv(t)
	main := e.mainLine()
	turn := e.turn(main.ID, "what is MVCC?", "versions")
	branch := e.branch(main.ID, turn.Message.ID, "Deeper")
	const secret = "EXPLANATION-ONLY-OKAPI-4410"
	e.saveTerm(main.ID, "MVCC", "multi-version "+secret)
	e.saveTerm(main.ID, "WAL", "x")

	for _, line := range []string{main.ID, branch.Line.ID} {
		preview, err := e.engine.PreviewTurn(e.ctx, scopeA, line, "next")
		if err != nil {
			t.Fatal(err)
		}
		block, ok := trailingSection(preview.Prompt, domain.SectionGlossary)
		if !ok || !strings.Contains(block.Body, "Terms the user has already asked about: MVCC, WAL") {
			t.Fatalf("trailing = %+v", preview.Prompt.Trailing)
		}
		for _, s := range preview.Prompt.Sections {
			if s.Key == domain.SectionGlossary {
				t.Fatal("the glossary is in the cacheable prefix")
			}
		}
		raw, _ := json.Marshal(preview)
		if strings.Contains(string(raw), secret) {
			t.Fatal("an explanation reached the prompt")
		}
		if share := budgetShare(preview.Budget, tangent.FeatureGlossary); share == 0 || share > 300 {
			t.Fatalf("budget = %+v", preview.Budget)
		}
	}
	e.turn(main.ID, "next", "ok")
	requests := e.runner.Requests()
	last := requests[len(requests)-1]
	if !strings.Contains(last.System, "MVCC, WAL") || strings.Contains(last.System, secret) {
		t.Fatalf("system:\n%s", last.System)
	}
}

func TestGlossary_TheBlockIsTrailingBeforeTheReplyLines(t *testing.T) {
	e, _ := glossaryEnv(t)
	main := e.mainLine()
	e.saveTerm(main.ID, "MVCC", "x")
	// A first turn with a long message asks for a [TOPIC] line: reply_lines.
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, strings.Repeat("how do databases keep many versions of a row? ", 4))
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{}
	for _, s := range preview.Prompt.Trailing {
		keys = append(keys, s.Key)
	}
	if got := strings.Join(keys, ","); got != domain.SectionGlossary+","+domain.SectionReplyLines {
		t.Fatalf("trailing = %s", got)
	}
}

func TestGlossary_TheBlockKeepsTheMostRecentTermsWithinTheBudget(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Glossary.TokenBudget = 60
	e, _ := glossaryEnv(t, tangent.WithLimits(limits))
	main := e.mainLine()
	names := []string{"alpha term", "bravo term", "charlie term", "delta term", "echo term", "foxtrot term", "golf term", "hotel term"}
	for _, name := range names {
		e.saveTerm(main.ID, name, "x")
	}
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next")
	if err != nil {
		t.Fatal(err)
	}
	block, ok := trailingSection(preview.Prompt, domain.SectionGlossary)
	if !ok || domain.EstimateTokens(block.Body) > 60 {
		t.Fatalf("block (%d tokens): %q", domain.EstimateTokens(block.Body), block.Body)
	}
	if !strings.Contains(block.Body, "hotel term") || strings.Contains(block.Body, "alpha term") {
		t.Fatalf("the newest stay, the oldest go: %q", block.Body)
	}
}

// DESIGN §12.10 (B24): the glossary block is trailing, so the cacheable
// prefix is the same byte for byte whether the feature is on or off.
func TestGlossary_TheStablePrefixIsTheSameWithTheFeatureOnOrOff(t *testing.T) {
	e, policy := glossaryEnv(t)
	main := e.mainLine()
	turn := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, turn.Message.ID, "Deeper")
	e.saveTerm(main.ID, "MVCC", "x")
	for _, line := range []string{main.ID, branch.Line.ID} {
		on, err := e.engine.PreviewTurn(e.ctx, scopeA, line, "next")
		if err != nil {
			t.Fatal(err)
		}
		policy.set(tangent.FeatureGlossary, true)
		off, err := e.engine.PreviewTurn(e.ctx, scopeA, line, "next")
		policy.set(tangent.FeatureGlossary, false)
		if err != nil {
			t.Fatal(err)
		}
		stableOn, volatileOn, _ := on.Prompt.ChatBlocks()
		stableOff, volatileOff, _ := off.Prompt.ChatBlocks()
		if stableOn != stableOff {
			t.Fatalf("the stable prefix changed:\n--- on\n%s\n--- off\n%s", stableOn, stableOff)
		}
		if !strings.Contains(volatileOn, "MVCC") || strings.Contains(volatileOff, "MVCC") {
			t.Fatalf("volatile on %q / off %q", volatileOn, volatileOff)
		}
	}
}

func TestGlossary_OffRefusesTheCallsLeavesThePromptAndKeepsTheTerms(t *testing.T) {
	e, policy := glossaryEnv(t)
	main := e.mainLine()
	saved := e.saveTerm(main.ID, "MVCC", "x")
	policy.set(tangent.FeatureGlossary, true)
	text := "x"
	calls := map[string]error{}
	_, calls["list"] = e.engine.ListTerms(e.ctx, scopeA, main.ID)
	_, calls["create"] = e.engine.CreateTerm(e.ctx, scopeA, main.ID, tangent.TermInput{Term: "y", Explanation: "x"})
	_, calls["update"] = e.engine.UpdateTerm(e.ctx, scopeA, saved.Term.ID, tangent.TermPatch{Explanation: &text})
	_, calls["delete"] = e.engine.DeleteTerm(e.ctx, scopeA, saved.Term.ID)
	_, calls["search"] = e.engine.SearchTerms(e.ctx, scopeA, tangent.TermQuery{})
	for name, err := range calls {
		if domain.CodeOf(err) != domain.CodeFeatureDisabled {
			t.Errorf("%s: %v", name, err)
		}
	}
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := trailingSection(preview.Prompt, domain.SectionGlossary); ok || budgetShare(preview.Budget, tangent.FeatureGlossary) != 0 {
		t.Fatal("a glossary block while the feature is off")
	}
	export, err := e.engine.ExportTree(e.ctx, scopeA, main.ID)
	if err != nil || export.Terms == nil || len(export.Terms) != 0 {
		t.Fatalf("export terms while off = %v, %v", export.Terms, err)
	}
	policy.set(tangent.FeatureGlossary, false)
	list, err := e.engine.ListTerms(e.ctx, scopeA, main.ID)
	if err != nil || len(list.Terms) != 1 {
		t.Fatalf("the terms were kept: %+v %v", list, err)
	}
	export, err = e.engine.ExportTree(e.ctx, scopeA, main.ID)
	if err != nil || len(export.Terms) != 1 || export.Terms[0].ID != saved.Term.ID {
		t.Fatalf("export terms = %+v, %v", export.Terms, err)
	}
}

func TestGlossary_AFreshSpinoffCopiesNoTerms(t *testing.T) {
	e, _ := glossaryEnv(t)
	main := e.mainLine()
	turn := e.turn(main.ID, "q", "a")
	e.saveTerm(main.ID, "MVCC", "x")
	out, err := e.engine.Spinoff(e.ctx, scopeA, main.ID, tangent.SpinoffInput{Mode: domain.SpinoffFresh, AtMessageID: turn.Message.ID})
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := e.engine.ListTerms(e.ctx, scopeA, out.Line.ID)
	if err != nil || len(fresh.Terms) != 0 {
		t.Fatalf("the new conversation's glossary: %+v %v", fresh, err)
	}
	if old, _ := e.engine.ListTerms(e.ctx, scopeA, main.ID); len(old.Terms) != 1 {
		t.Fatalf("the source's glossary: %+v", old)
	}
}

func TestGlossary_WritesRollBackWithTheHost(t *testing.T) {
	e, _ := glossaryEnv(t)
	main := e.mainLine()
	saved := e.saveTerm(main.ID, "MVCC", "x")
	text := "y"
	e.rollsBack("UpdateTerm", func(opt tangent.TxOption) error {
		_, err := e.engine.UpdateTerm(e.ctx, scopeA, saved.Term.ID, tangent.TermPatch{Explanation: &text}, opt)
		return err
	})
	e.rollsBack("DeleteTerm", func(opt tangent.TxOption) error {
		_, err := e.engine.DeleteTerm(e.ctx, scopeA, saved.Term.ID, opt)
		return err
	})
	var got store.TermChange
	if _, err := e.engine.UpdateTerm(e.ctx, scopeA, saved.Term.ID, tangent.TermPatch{Explanation: &text}, tangent.InTx(func(_ context.Context, _ store.Tx, result any) error {
		got = result.(store.TermChange)
		return nil
	})); err != nil || got.Term.Explanation != "y" {
		t.Fatalf("hook saw %+v, %v", got, err)
	}
}

// trailingSection is the prompt's trailing section with key.
func trailingSection(p domain.Prompt, key string) (domain.PromptSection, bool) {
	for _, s := range p.Trailing {
		if s.Key == key {
			return s, true
		}
	}
	return domain.PromptSection{}, false
}

// budgetShare is what owner took of a prompt's budget.
func budgetShare(b tangent.PromptBudget, owner string) int {
	total := 0
	for _, share := range b.Shares {
		if share.Owner == owner {
			total += share.Tokens
		}
	}
	return total
}
