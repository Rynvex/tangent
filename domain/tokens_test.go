package domain

import (
	"strings"
	"testing"
)

func TestEstimateTokens(t *testing.T) {
	if got := EstimateTokens(""); got != 0 {
		t.Fatalf("empty estimate = %d", got)
	}
	if got := EstimateTokens("abcd"); got != 1 {
		t.Fatalf("4 runes estimate = %d, want 1", got)
	}
	if got := EstimateTokens("abcde"); got != 2 {
		t.Fatalf("5 runes estimate = %d, want 2", got)
	}
	if got := EstimateTokens("中文字"); got != 3 {
		t.Fatalf("3 CJK runes estimate = %d, want 3", got)
	}
}

func TestEstimatePackTokens_DoesNotUndercountCJKOrEmoji(t *testing.T) {
	cjk := strings.Repeat("中", 1000)
	if got := EstimatePackTokens(cjk); got < 1000 {
		t.Fatalf("1000 CJK runes estimated at %d tokens, want at least 1000", got)
	}
	if got, base := EstimatePackTokens(cjk), EstimateTokens(cjk); got <= base {
		t.Fatalf("pack estimate %d must exceed the plain estimate %d for CJK", got, base)
	}
	emoji := strings.Repeat("😀", 400)
	if got := EstimatePackTokens(emoji); got < 400 {
		t.Fatalf("400 emoji estimated at %d tokens", got)
	}
	if got := EstimatePackTokens(strings.Repeat("abcd ", 80)); got != 100 {
		t.Fatalf("400 characters of ordinary words = %d tokens, want 100", got)
	}
}

func TestEstimatePackTokens_DoesNotUndercountDenseASCII(t *testing.T) {
	cases := map[string]string{
		"hex hash":      strings.Repeat("a1b2c3d4e5f6a7b8", 400),
		"base64":        strings.Repeat("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=", 170),
		"minified json": strings.Repeat(`{"id":12345,"ok":true,"v":[1,2,3]},`, 180),
		"url":           strings.Repeat("https://example.com/a/b/c?x=1&y=2#z", 180),
	}
	for name, text := range cases {
		if got, floor := EstimatePackTokens(text), len(text)/2; got < floor {
			t.Errorf("%s: %d chars estimated at %d tokens, want at least %d", name, len(text), got, floor)
		}
	}
	prose := strings.Repeat("the quick brown fox jumps over the lazy dog ", 100)
	if got := EstimatePackTokens(prose); got > len(prose)/3 {
		t.Errorf("ordinary prose should stay near a quarter token per character: %d for %d chars", got, len(prose))
	}
}
