package domain

import (
	"testing"
	"time"
)

func TestDefaultLimits_Defaults(t *testing.T) {
	l := DefaultLimits()
	branch := BranchLimits{
		PurposeMaxRunes: 200, ExcerptMaxRunes: 1500, SoftMaxDepth: 3, HardMaxDepth: 6, MaxOpenPerParent: 8, MaxPerTree: 200,
		MoveMaxMessages: 40, NoticeMaxPerTurn: 10, DraftTimeout: 3 * time.Minute, AsideRetention: 7 * 24 * time.Hour,
	}
	if l.Branch != branch {
		t.Fatalf("branch limits = %+v", l.Branch)
	}
	pack := PackLimits{
		RecentMessages: 8, AsideRecentMessages: 4, ExcerptRecentMessages: 3, TokenBudget: 6000, MessageTokenCap: 1500, HistoryScan: 200,
		LaterScan: 100, LaterTokenBudget: 1800, LaterRecentMessages: 3, LaterMessageTokenCap: 500,
	}
	if l.Pack != pack {
		t.Fatalf("pack limits = %+v", l.Pack)
	}
	if l.Notes != (NoteLimits{TokenBudget: 2000, MaxRunes: 400, MaxActive: 200, MaxTotal: 1000, MaxChangesPerMerge: 10}) {
		t.Fatalf("note limits = %+v", l.Notes)
	}
	chapters := ChapterLimits{IdleGap: 30 * time.Minute, MinMessages: 3, MaxCount: 60, MilestoneMaxPerTree: 200, MilestoneTitleMaxRunes: 80, TopicTitleMaxRunes: 120, MaxMessages: 20000}
	if l.Chapters != chapters {
		t.Fatalf("chapter limits = %+v", l.Chapters)
	}
	if l.History != (HistoryLimits{TokenBudget: 24000, MessageTokenCap: 4000, SummaryTriggerTokens: 16000}) {
		t.Fatalf("history limits = %+v", l.History)
	}
	if l.HistoryScan != 200 {
		t.Fatalf("history scan = %d", l.HistoryScan)
	}
	if err := l.Validate(); err != nil {
		t.Fatalf("defaults must validate: %v", err)
	}
}

func TestLimits_HistoryScanDefaultsAndValidates(t *testing.T) {
	if got := (Limits{}).WithDefaults().HistoryScan; got != 200 {
		t.Fatalf("defaulted history scan = %d", got)
	}
	if got := (Limits{HistoryScan: 50}).WithDefaults().HistoryScan; got != 50 {
		t.Fatalf("set history scan = %d", got)
	}
	if err := (Limits{HistoryScan: -1}).Validate(); err == nil {
		t.Fatal("a negative history scan must be refused")
	}
}

func TestLimits_ZeroSubStructsFallBackToDefaults(t *testing.T) {
	defaults := DefaultLimits()
	if (PackLimits{}).orDefault() != defaults.Pack || (ChapterLimits{}).orDefault() != defaults.Chapters ||
		(HistoryLimits{}).orDefault() != defaults.History || (NoteLimits{}).orDefault() != defaults.Notes ||
		(BranchLimits{}).orDefault() != defaults.Branch {
		t.Fatal("a zero sub-struct must mean the defaults")
	}
	custom := PackLimits{RecentMessages: 2, AsideRecentMessages: 1, ExcerptRecentMessages: 1, TokenBudget: 100, MessageTokenCap: 10, HistoryScan: 5, LaterScan: 5, LaterTokenBudget: 10, LaterRecentMessages: 1, LaterMessageTokenCap: 5}
	if custom.orDefault() != custom {
		t.Fatal("a set sub-struct must be kept")
	}
	if got := (Limits{}).WithDefaults(); got != defaults {
		t.Fatalf("WithDefaults = %+v", got)
	}
}

func TestLimits_ValidateRefusesNonsense(t *testing.T) {
	cases := map[string]func(*Limits){
		"soft above hard":           func(l *Limits) { l.Branch.SoftMaxDepth = 7 },
		"soft above a default hard": func(l *Limits) { l.Branch = BranchLimits{SoftMaxDepth: 9} },
		"negative open":             func(l *Limits) { l.Branch.MaxOpenPerParent = -1 },
		"negative budget":           func(l *Limits) { l.Pack.TokenBudget = -1 },
		"negative excerpt recent":   func(l *Limits) { l.Pack.ExcerptRecentMessages = -1 },
		"negative idle gap":         func(l *Limits) { l.Chapters.IdleGap = -time.Second },
		"negative history cap":      func(l *Limits) { l.History.MessageTokenCap = -5 },
		"negative note runes":       func(l *Limits) { l.Notes.MaxRunes = -1 },
		"negative move maximum":     func(l *Limits) { l.Branch.MoveMaxMessages = -40 },
	}
	for name, edit := range cases {
		l := DefaultLimits()
		edit(&l)
		if l.Validate() == nil {
			t.Errorf("%s: want an error", name)
		}
	}
	partial := Limits{Chapters: ChapterLimits{IdleGap: time.Minute}}
	if err := partial.Validate(); err != nil {
		t.Fatalf("zero fields mean defaults: %v", err)
	}
}

func TestLimits_PartlyFilledStructsAreDefaultedFieldByField(t *testing.T) {
	defaults := DefaultLimits()
	chapters := ChapterLimits{IdleGap: time.Minute}.orDefault()
	if chapters.IdleGap != time.Minute || chapters.MaxCount != defaults.Chapters.MaxCount || chapters.MinMessages != defaults.Chapters.MinMessages {
		t.Fatalf("chapters = %+v", chapters)
	}
	pack := PackLimits{TokenBudget: 3000, RecentMessages: -2}.orDefault()
	if pack.TokenBudget != 3000 || pack.RecentMessages != defaults.Pack.RecentMessages || pack.MessageTokenCap != defaults.Pack.MessageTokenCap {
		t.Fatalf("pack = %+v", pack)
	}
}

// Regression: a partly filled limits struct used to keep its zero fields and
// panic (MaxCount 0 in capBoundaries, RecentMessages 0 in BuildBranchPack).
func TestLimits_PartlyFilledStructsDoNotPanic(t *testing.T) {
	msgs := chapterMsgs(12, map[int]time.Duration{4: time.Hour, 8: time.Hour})
	if cs := ComputeChapters(msgs, nil, nil, ChapterLimits{IdleGap: time.Minute}); len(cs) == 0 {
		t.Fatal("no chapters")
	}
	if cs := ComputeChapters(msgs, nil, nil, ChapterLimits{MaxCount: -1, MinMessages: -3}); len(cs) == 0 {
		t.Fatal("no chapters with negative limits")
	}
	pack := BuildBranchPack(BranchPackInput{Purpose: "p", Messages: packConversation(12, "x"), Limits: PackLimits{TokenBudget: 3000}})
	if len(pack.Recent) != DefaultLimits().Pack.RecentMessages || pack.TokenBudget != 3000 {
		t.Fatalf("recent %d budget %d", len(pack.Recent), pack.TokenBudget)
	}
	pack = BuildBranchPack(BranchPackInput{Aside: true, Purpose: "p", Messages: packConversation(12, "x"), Limits: PackLimits{RecentMessages: 2}})
	if len(pack.Recent) != DefaultLimits().Pack.AsideRecentMessages {
		t.Fatalf("aside recent %d", len(pack.Recent))
	}
}
