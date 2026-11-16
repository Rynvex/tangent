package tangent

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
)

// stream pushes the pieces and the final flush, returning each emission.
func stream(markers []string, pieces ...string) []string {
	f := &lineFilter{markers: markers}
	out := []string{}
	for _, p := range pieces {
		out = append(out, f.push(p))
	}
	return append(out, f.flush())
}

func TestLineFilter_DropsAMarkerSplitAcrossDeltas(t *testing.T) {
	got := stream(domain.ProtocolMarkers(nil), "Hello there.\n[BRAN", "CH-SUGG", `EST]{"purpose":"p","kind":"investigate"}`, "\nMore text")
	if strings.Contains(strings.Join(got, ""), "BRANCH") || strings.Join(got, "") != "Hello there.\nMore text" {
		t.Fatalf("got %q", got)
	}
}

func TestLineFilter_DropsAMarkerOnTheLastLineWithoutABreak(t *testing.T) {
	got := stream(domain.ProtocolMarkers(nil), "Answer.\n", "  [BRANCH-SUGGEST]", `{"purpose":"p"}`)
	if strings.Join(got, "") != "Answer." {
		t.Fatalf("got %q", got)
	}
	extra := stream(domain.ProtocolMarkers([]string{"[NEEDS-INPUT]"}), "ok\n[NEEDS-", "INPUT] what?")
	if strings.Join(extra, "") != "ok" {
		t.Fatalf("host markers are filtered too: %q", extra)
	}
	unfinished := stream(domain.ProtocolMarkers(nil), "tail [x\n", "[BRANCH")
	if strings.Join(unfinished, "") != "tail [x\n[BRANCH" {
		t.Fatalf("a line that never became a marker is flushed at the end: %q", unfinished)
	}
}

func TestLineFilter_ANormalBracketLinePassesPromptly(t *testing.T) {
	got := stream(domain.ProtocolMarkers(nil), "[1] first source", " and more", "\n[link](x)\n")
	if got[0] != "[1] first source" || got[1] != " and more" || got[2] != "\n[link](x)" || got[3] != "" {
		t.Fatalf("got %q", got)
	}
	words := stream(domain.ProtocolMarkers(nil), "Hel", "lo")
	if words[0] != "Hel" || words[1] != "lo" {
		t.Fatalf("plain words are not held: %q", words)
	}
}

func TestLineFilter_TheStreamIsByteIdenticalToTheStoredReply(t *testing.T) {
	replies := []string{
		"Intro\n\n  \nBody line\n[BRANCH-SUGGEST]{\"purpose\":\"Look into it\",\"kind\":\"investigate\"}\n\nLast  \n\n",
		"Hello world\n\n  ",
		"\n\n  Leading space\nand\u00a0a no-break space\u00a0\n\t",
		"[BRANCH-SUGGEST]{\"purpose\":\"First\",\"kind\":\"investigate\"}\n\nThen text",
		"  ",
	}
	for _, reply := range replies {
		// What CompleteTurn stores: the outcome, then the suggestion filter.
		stored, _ := domain.ExtractBranchSuggestions(domain.ResolveTurnOutcome(reply, "").Content, domain.DefaultLimits().Branch)
		if domain.ResolveTurnOutcome(reply, "").Failed {
			stored = ""
		}
		// Runners stream whole runes (deltas are decoded JSON strings), so
		// the pieces are cut at rune boundaries.
		runes := []rune(reply)
		for size := 1; size <= len(runes); size++ {
			pieces := []string{}
			for i := 0; i < len(runes); i += size {
				pieces = append(pieces, string(runes[i:min(i+size, len(runes))]))
			}
			if got := strings.Join(stream(domain.ProtocolMarkers(nil), pieces...), ""); got != stored {
				t.Fatalf("reply %q in pieces of %d: streamed %q, stored %q", reply, size, got, stored)
			}
		}
	}
}

func TestStreamFilters_SweepAndTheSizeCap(t *testing.T) {
	now := time.Unix(0, 0)
	s := newStreamFilters(domain.ProtocolMarkers(nil), time.Hour, 1<<30)
	s.push("old", "x", now)
	s.push("new", "y", now.Add(time.Hour))
	s.sweep(now.Add(time.Minute))
	if _, ok := s.turns["old"]; ok {
		t.Fatal("an idle stream is swept")
	}
	if _, ok := s.turns["new"]; !ok {
		t.Fatal("an active stream stays")
	}
	if _, due := s.emitted("new", strings.Repeat("z", partialTextMax+1), 5, now); due {
		t.Fatal("text over the cap is not saved")
	}
	if _, ok := s.snapshot("new"); ok {
		t.Fatal("a capped stream has no snapshot (the run keeps the cancel text)")
	}
	if _, due := s.emitted("missing", "a", 1, now); due {
		t.Fatal("an unknown turn saves nothing")
	}
}

func TestStreamFilters_AFinishedTurnTakesNoMoreText(t *testing.T) {
	now := time.Unix(0, 0)
	s := newStreamFilters(domain.ProtocolMarkers(nil), time.Hour, 1<<20)
	s.push("turn", "a", now)
	s.finish("turn", now)
	if got := s.push("turn", "late", now); got != "" || len(s.turns) != 0 {
		t.Fatalf("a late delta reopened the stream: %q %d", got, len(s.turns))
	}
	s.finish("never-streamed", now)
	if s.push("never-streamed", "x", now) != "" {
		t.Fatal("a turn finished before its first delta is refused too")
	}
	s.sweepTombstones(now.Add(time.Second))
	if len(s.finished) != 0 {
		t.Fatal("old tombstones are swept")
	}
	for i := range maxTombstone + 10 {
		s.finish(fmt.Sprintf("t%d", i), now)
	}
	if len(s.finished) > maxTombstone {
		t.Fatalf("tombstones are bounded: %d", len(s.finished))
	}
}

// TestLineFilter_AgreesWithTheReplyFilterOnInvisibleCharacters: an
// invisible character before a marker does not hide the line (it is a
// marker line for the stream and for the reply parser alike); one inside a
// marker makes it no marker for either (shown as written, never parsed).
// Either way what streams is what CompleteTurn stores.
func TestLineFilter_AgreesWithTheReplyFilterOnInvisibleCharacters(t *testing.T) {
	suggestion := `{"purpose":"look into it","kind":"investigate"}`
	for _, c := range []struct {
		line       string
		isMarker   bool
		suggestion bool
	}{
		{"\uFEFF[BRANCH-SUGGEST]" + suggestion, true, true},
		{" \u200B\u202A[BRANCH-SUGGEST]" + suggestion, true, true},
		{"\u2060[NEEDS-INPUT] what?", true, false},
		{"[BRANCH-\u200BSUGGEST]" + suggestion, false, false},
		{"[BRANCH-\u202ASUGGEST]" + suggestion, false, false},
	} {
		reply := "Answer.\n" + c.line
		streamed := strings.Join(stream(domain.ProtocolMarkers([]string{"[NEEDS-INPUT]"}), reply), "")
		stored, suggestions := domain.ExtractBranchSuggestions(reply, domain.DefaultLimits().Branch)
		if c.isMarker != (streamed == "Answer.") || (len(suggestions) == 1) != c.suggestion {
			t.Fatalf("%q: streamed %q, %d suggestions", c.line, streamed, len(suggestions))
		}
		if strings.HasPrefix(c.line, "\u2060[NEEDS") {
			continue // a host marker is the host's to parse; only the stream drops it
		}
		if streamed != stored {
			t.Fatalf("%q: streamed %q, stored %q", c.line, streamed, stored)
		}
	}
}

func TestLineFilter_HidesTitleMarkersSplitAcrossDeltas(t *testing.T) {
	markers := domain.ProtocolMarkers(nil)
	topic := stream(markers, "Answer.\n[TO", "PI", `C]{"title":"NAS"}`)
	if got := strings.Join(topic, ""); got != "Answer." {
		t.Fatalf("topic: got %q", got)
	}
	chapter := stream(markers, "Answer.\n  [CHAP", `TER]{"title":"Stage"}`, "\nMore")
	if got := strings.Join(chapter, ""); got != "Answer.\nMore" {
		t.Fatalf("chapter: got %q", got)
	}
	reply := "Intro\n" + domain.TopicMarker + `{"title":"T"}` + "\n" + domain.ChapterCutMarker + `{"title":"C"}` + "\n"
	stored, _ := domain.ExtractTopicSummary(reply, domain.DefaultLimits().Text)
	stored, _ = domain.ExtractChapterCut(stored, domain.DefaultLimits().Chapters)
	runes := []rune(reply)
	for size := 1; size <= len(runes); size++ {
		pieces := []string{}
		for i := 0; i < len(runes); i += size {
			pieces = append(pieces, string(runes[i:min(i+size, len(runes))]))
		}
		if got := strings.Join(stream(markers, pieces...), ""); got != stored {
			t.Fatalf("pieces of %d: streamed %q, stored %q", size, got, stored)
		}
	}
}
