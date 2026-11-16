package store_test

import (
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// B11 soak: a relation or group suggestion is about the main line (its
// line_id) but names other lines in its payload. A detach took such a line
// to a new tree (and the soak later deleted that tree): the suggestion
// stayed open in the old inbox, pointing at a line outside it, and
// accepting the relation answered 400 invalid_input ("a relation starts in
// the conversation it is drawn from").

// namingPayload is a suggestion payload naming lines the way relations
// (fromLineId, toLineId) and groups (members[].lineId) do.
func namingPayload(from, to string, members ...string) json.RawMessage {
	payload := map[string]any{}
	if from != "" {
		payload["fromLineId"], payload["toLineId"] = from, to
	}
	if len(members) > 0 {
		list := []map[string]string{}
		for _, m := range members {
			list = append(list, map[string]string{"lineId": m})
		}
		payload["members"] = list
	}
	raw, _ := json.Marshal(payload)
	return raw
}

func (f *fixture) proposeNaming(lineID, target string, payload json.RawMessage) store.Proposal {
	f.t.Helper()
	return f.propose(lineID, target, func(in *store.ProposeInput) { in.Payload = payload })
}

func (f *fixture) suggestionStatus(id string) string {
	f.t.Helper()
	s, err := f.store.GetSuggestion(f.ctx, tenant, id)
	if err != nil {
		f.t.Fatal(err)
	}
	return s.Status
}

func TestB11_ADetachExpiresTheOldTreesSuggestionsThatNameItsLines(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	stays := f.branch(main.ID, anchor.ID)
	leaves := f.branch(main.ID, anchor.ID)
	below := f.branch(leaves.ID, f.reply(leaves.ID).ID)
	relation := f.proposeNaming(main.ID, "relation:a", namingPayload(stays.ID, leaves.ID))
	group := f.proposeNaming(main.ID, "group:b", namingPayload("", "", stays.ID, below.ID))
	kept := f.proposeNaming(main.ID, "relation:c", namingPayload(stays.ID, main.ID))
	out := f.detach(leaves.ID)
	ids := []string{}
	for _, s := range out.ExpiredSuggestions {
		ids = append(ids, s.ID)
		if s.Status != domain.SuggestionExpired || s.RootLineID != main.ID {
			t.Fatalf("expired %+v", s)
		}
	}
	slices.Sort(ids)
	want := []string{relation.Suggestion.ID, group.Suggestion.ID}
	slices.Sort(want)
	if !slices.Equal(ids, want) {
		t.Fatalf("expired %v, want %v", ids, want)
	}
	if f.suggestionStatus(relation.Suggestion.ID) != domain.SuggestionExpired || f.suggestionStatus(kept.Suggestion.ID) != domain.SuggestionOpen {
		t.Fatal("only the suggestions naming the detached lines expire")
	}
}

func TestB11_AProposalNamingALineOutsideTheTreeIsNotRaised(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	inTree := f.branch(main.ID, anchor.ID)
	gone := f.branch(main.ID, anchor.ID)
	f.detach(gone.ID)
	other, _ := f.mainLine()
	for i, payload := range []json.RawMessage{
		namingPayload(inTree.ID, gone.ID),
		namingPayload("", "", inTree.ID, other.ID),
		namingPayload(inTree.ID, "7c5de9b4-5d74-499f-84f6-b49cb135f356"), // no such line
	} {
		if p := f.proposeNaming(main.ID, fmt.Sprintf("outside:%d", i), payload); p.Created {
			t.Fatalf("payload %s was raised: %+v", payload, p.Suggestion)
		}
	}
	if p := f.proposeNaming(main.ID, "inside", namingPayload(inTree.ID, main.ID, inTree.ID)); !p.Created {
		t.Fatal("a payload naming the tree's own lines is raised")
	}
}

func TestB11_APurgedAsideExpiresTheSuggestionsThatNameIt(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	f := newFixture(t, store.WithClock(clock.Now))
	main, anchor := f.mainLine()
	branch := f.branch(main.ID, anchor.ID)
	aside := f.aside(main.ID, anchor.ID)
	naming := f.proposeNaming(main.ID, "relation:aside", namingPayload(branch.ID, aside.ID))
	f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE line_id = $1`, aside.ID)
	clock.now = time.Now().Add(domain.DefaultLimits().Branch.AsideRetention + time.Hour)
	purged, err := f.store.PurgeExpiredAsides(f.ctx, 0)
	if err != nil || len(purged) != 1 || len(purged[0].ExpiredSuggestions) != 1 || purged[0].ExpiredSuggestions[0].ID != naming.Suggestion.ID {
		t.Fatalf("purged %+v err=%v", purged, err)
	}
	if f.suggestionStatus(naming.Suggestion.ID) != domain.SuggestionExpired {
		t.Fatal("the suggestion naming the purged aside stays open")
	}
}
