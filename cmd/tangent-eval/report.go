package main

import (
	"fmt"
	"io"
)

// Markdown writes the report as a table (one row per ask and the total)
// and a line about grading.
func (r Report) Markdown(w io.Writer) {
	fmt.Fprintln(w, "| Sample | Line | Default tokens | Fisheye tokens | Saved | full / summary / leaf_only / hidden | Score default / fisheye |")
	fmt.Fprintln(w, "|---|---|---|---|---|---|---|")
	for _, result := range r.Results {
		score := "—"
		if r.Graded {
			score = fmt.Sprintf("%d / %d", result.DefaultScore, result.FisheyeScore)
		}
		fmt.Fprintf(w, "| %s | %s | %d | %d | %.0f%% | %d / %d / %d / %d | %s |\n", result.Sample, result.Line, result.DefaultTokens, result.FisheyeTokens,
			100*result.Reduction(), result.Full, result.Summary, result.LeafOnly, result.Hidden, score)
	}
	plain, fish := r.totals()
	fmt.Fprintf(w, "| **Total** | | %d | %d | %.0f%% | | |\n\n", plain, fish, 100*r.Reduction())
	if !r.Graded {
		fmt.Fprintf(w, "Quality grading skipped: %s.\n", r.SkipReason)
	}
}

// Markdown writes one row per query, the totals and the Embedder.
func (r RecallReport) Markdown(w io.Writer) {
	fmt.Fprintln(w, "| Sample | Query | Expected | Found by search | First rank | Found in the turn | Memory tokens | Stale recalled |")
	fmt.Fprintln(w, "|---|---|---|---|---|---|---|---|")
	for _, x := range r.Results {
		rank := "—"
		if x.FirstRank > 0 {
			rank = fmt.Sprint(x.FirstRank)
		}
		fmt.Fprintf(w, "| %s | %s | %d | %d | %s | %d | %d | %d |\n", x.Sample, x.Query, x.Expected, x.SearchFound, rank, x.TurnFound, x.TurnTokens, x.StaleRecalled)
	}
	fmt.Fprintf(w, "| **Recall@%d** | | %d | %.0f%% | | %.0f%% | | %d |\n\n", r.K, r.expected(), 100*r.SearchRecall(), 100*r.TurnRecall(), r.Stale())
	fmt.Fprintf(w, "Embedder: %s (%s).\n", r.Embedder, r.Note)
}
