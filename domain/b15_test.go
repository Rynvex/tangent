package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestNormalizeRelationKind_DefaultsAndRefusals(t *testing.T) {
	for in, want := range map[string]string{"": RelationKindRelated, "  ": RelationKindRelated, "supports": RelationKindSupports, " contradicts ": RelationKindContradicts, "depends_on": RelationKindDependsOn, "related": RelationKindRelated} {
		got, err := NormalizeRelationKind(in)
		if err != nil || got != want {
			t.Errorf("NormalizeRelationKind(%q) = %q %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"Contradicts", "opposes", "depends-on"} {
		if _, err := NormalizeRelationKind(bad); CodeOf(err) != CodeInvalidInput {
			t.Errorf("NormalizeRelationKind(%q) = %v; want invalid_input", bad, err)
		}
	}
}

func TestParseRelationKind_EmptyIsRefusedOnEdit(t *testing.T) {
	for in, want := range map[string]string{"supports": RelationKindSupports, " depends_on ": RelationKindDependsOn, "related": RelationKindRelated} {
		got, err := ParseRelationKind(in)
		if err != nil || got != want {
			t.Errorf("ParseRelationKind(%q) = %q %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "  ", "Supports", "rivals"} {
		_, err := ParseRelationKind(bad)
		var refusal *Error
		if CodeOf(err) != CodeInvalidInput || !errors.As(err, &refusal) || refusal.Extra["field"] != "relationKind" {
			t.Errorf("ParseRelationKind(%q) = %v; want invalid_input on relationKind", bad, err)
		}
	}
}

func TestRelationSuggestions_KindIsReadLeniently(t *testing.T) {
	known := map[string]bool{"B1": true, "B2": true, "B3": true}
	reply := RelationSuggestMarker + `{"relations":[{"to":"B1","kind":"Contradicts"},{"to":"B2","kind":"depends-on"},{"to":"B3","kind":" Depends  On "}]}`
	got, err := ParseRelationSuggestions(reply, known, DefaultLimits().Relations)
	if err != nil || len(got) != 3 {
		t.Fatalf("relations = %+v %v", got, err)
	}
	if got[0].Kind != RelationKindContradicts || got[1].Kind != RelationKindDependsOn || got[2].Kind != RelationKindDependsOn {
		t.Fatalf("case, dashes and spaces are forgiven: %+v", got)
	}
	for _, odd := range []string{"depends_on_it", "SUPPORTS!", "_"} {
		if kind := proposedRelationKind(odd); kind != RelationKindRelated {
			t.Errorf("proposedRelationKind(%q) = %q; want related", odd, kind)
		}
	}
}

func TestRelationSuggestions_KindFromTheModelOrRelated(t *testing.T) {
	prompt := BuildRelationSuggestPrompt(RelationSuggestInput{
		Branch: RelationCandidate{Key: "B0", Purpose: "Ryokan prices"},
		Others: []RelationCandidate{{Key: "B1", Purpose: "Hotel prices"}},
	})
	for _, kind := range RelationKinds {
		if !strings.Contains(prompt, kind) {
			t.Errorf("the prompt names the kind %s: %q", kind, prompt)
		}
	}
	known := map[string]bool{"B1": true, "B2": true, "B3": true}
	got, err := ParseRelationSuggestions(RelationSuggestMarker+`{"relations":[{"to":"B1","label":"a","kind":"contradicts"},{"to":"B2","label":"b","kind":"rivals"},{"to":"B3","label":"c"}]}`, known, DefaultLimits().Relations)
	if err != nil || len(got) != 3 {
		t.Fatalf("relations = %+v %v", got, err)
	}
	if got[0].Kind != RelationKindContradicts || got[1].Kind != RelationKindRelated || got[2].Kind != RelationKindRelated {
		t.Fatalf("kinds = %+v", got)
	}
}

func TestLink_RelationKindIsLeftOutWhenEmpty(t *testing.T) {
	spinoff, _ := json.Marshal(Link{ID: "l", Kind: LinkKindSpinoff})
	relation, _ := json.Marshal(Link{ID: "l", Kind: LinkKindRelation, RelationKind: RelationKindSupports})
	if strings.Contains(string(spinoff), "relationKind") || !strings.Contains(string(relation), `"relationKind":"supports"`) {
		t.Fatalf("spinoff = %s, relation = %s", spinoff, relation)
	}
}

func TestNormalizeTagStatus_AndItsSource(t *testing.T) {
	for in, want := range map[string]string{"": TagStatusConfirmed, "confirmed": TagStatusConfirmed, " draft ": TagStatusDraft} {
		got, err := NormalizeTagStatus(in)
		if err != nil || got != want {
			t.Errorf("NormalizeTagStatus(%q) = %q %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"Draft", "pending", "ai"} {
		if _, err := NormalizeTagStatus(bad); CodeOf(err) != CodeInvalidInput {
			t.Errorf("NormalizeTagStatus(%q) = %v; want invalid_input", bad, err)
		}
	}
	if TagSourceOf(TagStatusDraft) != TagSourceAI || TagSourceOf(TagStatusConfirmed) != TagSourceUser {
		t.Fatal("a draft is the model's, a confirmed tag the operator's")
	}
}
