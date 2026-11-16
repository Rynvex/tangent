// Package fake is a deterministic tangent.Runner for the reference server,
// smoke tests and browser e2e: no network, no key. A turn is answered by
// echoing the operator's message in streamed chunks; a card-draft job gets
// a valid conclusion card (with one note proposal when the prompt asks for
// noteChanges), a summary job a valid summary and a leaf draft job a valid
// leaf.
//
// Directives in the operator's message script the run:
//
//	[fake:error]      fail the run (a RunnerError with a public text)
//	[fake:retry]      report one automatic retry through OnRetry first
//	[fake:slow]       wait SlowDelay before answering (a cancel stops it)
//	[fake:reasoning]  stream a reasoning delta before the text
//	[fake:suggest]    end the reply with a [BRANCH-SUGGEST] line
//	[fake:topic]      end the reply with a [TOPIC] line ("Fake topic")
//	[fake:chapter]    end the reply with a [CHAPTER] line ("Fake chapter")
//	[fake:wait=250ms] wait that long first (a Go duration, at most MaxWait)
//	[fake:job-error]  in a job's prompt (for example quoted from a branch
//	                  message a card draft reads): fail the job
//	[fake:drift]      in a message a drift check reads: report a drift
//
// An ibis_tag job tags the operator's messages as questions and the
// assistant's as ideas, a fold summary is fixed text, a diverge job proposes
// "Direction 1 (fake runner)" … as many as asked, and a converge job scores
// the first option best and recommends it. A memory extraction remembers
// the first line of its source as a fact; a consolidation merges. A goal proposal gets
// a fixed goal, a drift check reports no drift unless
// told to, a relation job relates the branch to the first other one, a
// group summary is fixed text, and a group suggestion groups the first two
// ended branches (with one conflict) and the first two open ones.
package fake

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// Defaults of a Config.
const (
	DefaultModel      = "fake-1"
	DefaultChunkRunes = 16
	DefaultSlowDelay  = 3 * time.Second
	DefaultMaxWait    = 30 * time.Second
	// echoMaxRunes caps how much of the operator's message is echoed.
	echoMaxRunes = 400
)

// Directives understood in the operator's message.
const (
	DirectiveError     = "[fake:error]"
	DirectiveRetry     = "[fake:retry]"
	DirectiveSlow      = "[fake:slow]"
	DirectiveReasoning = "[fake:reasoning]"
	DirectiveSuggest   = "[fake:suggest]"
	DirectiveTopic     = "[fake:topic]"
	DirectiveChapter   = "[fake:chapter]"
	DirectiveJobError  = "[fake:job-error]"
	DirectiveDrift     = "[fake:drift]"
)

// waitDirective is [fake:wait=<duration>].
var waitDirective = regexp.MustCompile(`\[fake:wait=([0-9a-zµ.]+)\]`)

// Config tunes the fake.
type Config struct {
	// Model is reported when a request names none.
	Model string
	// ChunkRunes is the size of a streamed text piece.
	ChunkRunes int
	// ChunkDelay waits between streamed pieces (0: none).
	ChunkDelay time.Duration
	// SlowDelay is the wait of [fake:slow].
	SlowDelay time.Duration
	// MaxWait caps [fake:wait=…] (default 30s).
	MaxWait time.Duration
}

// Runner is the fake runner.
type Runner struct{ cfg Config }

// New returns a fake runner.
func New(cfg Config) *Runner {
	cfg.Model = cmp.Or(strings.TrimSpace(cfg.Model), DefaultModel)
	if cfg.ChunkRunes <= 0 {
		cfg.ChunkRunes = DefaultChunkRunes
	}
	if cfg.SlowDelay <= 0 {
		cfg.SlowDelay = DefaultSlowDelay
	}
	if cfg.MaxWait <= 0 {
		cfg.MaxWait = DefaultMaxWait
	}
	return &Runner{cfg: cfg}
}

// DefaultModel is the model reported when a request names none.
func (r *Runner) DefaultModel() string { return r.cfg.Model }

// Run answers a turn (a request with OnDelta) or a job (without).
func (r *Runner) Run(ctx context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
	last := lastUserMessage(req.Messages)
	var reply string
	if req.OnDelta == nil {
		if strings.Contains(last, DirectiveJobError) {
			return tangent.RunResult{}, &tangent.RunnerError{Public: "the fake runner was told to fail this job"}
		}
		reply = jobReply(last)
	} else {
		var err error
		if reply, err = r.turn(ctx, req, last); err != nil {
			return tangent.RunResult{}, err
		}
	}
	return tangent.RunResult{
		Content: reply, StopReason: "end_turn", Model: cmp.Or(strings.TrimSpace(req.Model), r.cfg.Model),
		Usage: domain.Usage{InputTokens: int64(promptTokens(req)), OutputTokens: int64(domain.EstimateTokens(reply))},
	}, nil
}

func (r *Runner) turn(ctx context.Context, req tangent.RunRequest, last string) (string, error) {
	// Chat merges neighbouring user messages (an earlier message whose reply
	// failed is left out of the history), so only the newest paragraph is
	// this turn's own message.
	if i := strings.LastIndex(last, "\n\n"); i >= 0 {
		last = last[i+2:]
	}
	if strings.Contains(last, DirectiveRetry) && req.OnRetry != nil {
		req.OnRetry(tangent.Retry{Attempt: 1, MaxAttempts: 2, NextRetryAt: time.Now()})
	}
	if strings.Contains(last, DirectiveSlow) {
		if err := wait(ctx, r.cfg.SlowDelay); err != nil {
			return "", err
		}
	}
	if match := waitDirective.FindStringSubmatch(last); match != nil {
		if d, err := time.ParseDuration(match[1]); err == nil {
			if err := wait(ctx, min(d, r.cfg.MaxWait)); err != nil {
				return "", err
			}
		}
	}
	if strings.Contains(last, DirectiveError) {
		return "", &tangent.RunnerError{Public: "the fake runner was told to fail"}
	}
	if strings.Contains(last, DirectiveReasoning) {
		req.OnDelta(domain.Delta{Kind: domain.DeltaReasoning, Text: "Thinking about it (fake)."})
	}
	reply := "Fake reply to: " + truncate(strings.TrimSpace(last), echoMaxRunes)
	if err := r.stream(ctx, req.OnDelta, reply); err != nil {
		return "", err
	}
	if strings.Contains(last, DirectiveSuggest) {
		reply += "\n" + domain.BranchSuggestMarker + `{"purpose":"Look into the trade-offs","kind":"investigate"}`
	}
	if strings.Contains(last, DirectiveTopic) {
		reply += "\n" + domain.TopicMarker + `{"title":"Fake topic"}`
	}
	if strings.Contains(last, DirectiveChapter) {
		reply += "\n" + domain.ChapterCutMarker + `{"title":"Fake chapter"}`
	}
	return reply, nil
}

// stream sends the reply in ChunkRunes pieces, ChunkDelay apart.
func (r *Runner) stream(ctx context.Context, onDelta func(domain.Delta), reply string) error {
	runes := []rune(reply)
	for start := 0; start < len(runes); start += r.cfg.ChunkRunes {
		if start > 0 {
			if err := wait(ctx, r.cfg.ChunkDelay); err != nil {
				return err
			}
		}
		end := min(start+r.cfg.ChunkRunes, len(runes))
		onDelta(domain.Delta{Kind: domain.DeltaText, Text: string(runes[start:end])})
	}
	return ctx.Err()
}

// jobReply answers a job by the marker its prompt asks for.
func jobReply(prompt string) string {
	switch {
	case strings.Contains(prompt, domain.MemoryExtractMarker):
		return domain.MemoryExtractMarker + memoryExtraction(prompt)
	case strings.Contains(prompt, domain.MemoryConsolidateMarker):
		return domain.MemoryConsolidateMarker + `{"action":"merge","kind":"fact","text":"One memory for both (fake runner).","importance":6,"reason":"They say the same (fake runner)."}`
	case strings.Contains(prompt, domain.DivergeMarker):
		return domain.DivergeMarker + divergeDirections(prompt)
	case strings.Contains(prompt, domain.ConvergeMarker):
		return domain.ConvergeMarker + convergence(prompt)
	case strings.Contains(prompt, domain.IbisTagMarker):
		return domain.IbisTagMarker + ibisTags(prompt)
	case strings.Contains(prompt, domain.FoldSummaryMarker):
		return domain.FoldSummaryMarker + `{"summary":"This stretch of the conversation is folded (fake runner)."}`
	case strings.Contains(prompt, domain.GoalProposeMarker):
		return domain.GoalProposeMarker + `{"goal":"Settle what this conversation set out to decide (fake runner)."}`
	case strings.Contains(prompt, domain.DriftCheckMarker) && strings.Contains(prompt, DirectiveDrift):
		return domain.DriftCheckMarker + `{"drift":true,"kind":"investigate","purpose":"Follow the side topic (fake runner)","reason":"It moved away from the goal (fake runner)."}`
	case strings.Contains(prompt, domain.DriftCheckMarker):
		return domain.DriftCheckMarker + `{"drift":false}`
	case strings.Contains(prompt, domain.RelationSuggestMarker) && strings.Contains(prompt, "> B1: "):
		return domain.RelationSuggestMarker + `{"relations":[{"to":"B1","label":"Related (fake runner)"}]}`
	case strings.Contains(prompt, domain.RelationSuggestMarker):
		return domain.RelationSuggestMarker + `{"relations":[]}`
	case strings.Contains(prompt, domain.GroupSummaryMarker):
		return domain.GroupSummaryMarker + `{"summary":"These branches settle one question together (fake runner)."}`
	case strings.Contains(prompt, domain.GroupSuggestMarker):
		return domain.GroupSuggestMarker + groupSuggestion(prompt)
	case strings.Contains(prompt, domain.LeafDraftMarker):
		return domain.LeafDraftMarker + `{"kind":"conclusion","line":"The branch settled its question (fake runner).","body":"Drafted by the fake runner."}`
	case strings.Contains(prompt, domain.BranchCardMarker) && strings.Contains(prompt, "noteChanges"):
		return domain.BranchCardMarker + `{"question":"What did this branch settle?","conclusion":"The branch reached a conclusion (fake runner).","openItems":["Confirm with a real model"],` +
			`"noteChanges":[{"op":"add","section":"decided","text":"The branch reached a conclusion (fake runner)."}]}`
	case strings.Contains(prompt, domain.BranchCardMarker):
		return domain.BranchCardMarker + `{"question":"What did this branch settle?","conclusion":"The branch reached a conclusion (fake runner).","openItems":["Confirm with a real model"]}`
	case strings.Contains(prompt, domain.SummaryMarker):
		return domain.SummaryMarker + `{"topic":"The conversation so far (fake summary)","decisions":[],"openQuestions":[],"files":[]}`
	}
	return "Fake job output."
}

func lastUserMessage(messages []domain.ChatMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == domain.ChatRoleUser {
			return messages[i].Content
		}
	}
	return ""
}

func promptTokens(req tangent.RunRequest) int {
	total := domain.EstimateTokens(req.System)
	for _, m := range req.Messages {
		total += domain.EstimateTokens(m.Content)
	}
	return total
}

func truncate(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}

func wait(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// memoryExtraction remembers the first quoted line of a memory_extract
// prompt's source as a fact.
func memoryExtraction(prompt string) string {
	_, source, _ := strings.Cut(prompt, "## Source")
	for _, line := range strings.Split(source, "\n") {
		if text, ok := strings.CutPrefix(line, "> "); ok && strings.TrimSpace(text) != "" {
			quoted, _ := json.Marshal("Remembered: " + text + " (fake runner)")
			return `{"memories":[{"action":"add","kind":"fact","text":` + string(quoted) + `,"importance":6}]}`
		}
	}
	return `{"memories":[]}`
}

// exactlyN is the number of directions a diverge prompt asks for.
var exactlyN = regexp.MustCompile(`exactly (\d+) directions`)

// divergeDirections proposes the number of directions a diverge prompt
// asks for: "Direction 1 (fake runner)", ….
func divergeDirections(prompt string) string {
	n := 2
	if m := exactlyN.FindStringSubmatch(prompt); m != nil {
		fmt.Sscan(m[1], &n)
	}
	items := []string{}
	for i := range n {
		items = append(items, fmt.Sprintf(`{"purpose":"Direction %d (fake runner)","why":"It is one way to go (fake runner)."}`, i+1))
	}
	return `{"directions":[` + strings.Join(items, ",") + `]}`
}

// convergence scores every option a converge prompt lists ("### O1: …") on
// its criteria (the operator's, or one of its own): the first option best,
// and recommends it.
func convergence(prompt string) string {
	options, criteria, inCriteria := []string{}, []string{}, false
	for _, line := range strings.Split(prompt, "\n") {
		switch {
		case strings.HasPrefix(line, "### O"):
			key, _, _ := strings.Cut(strings.TrimPrefix(line, "### "), ":")
			options = append(options, key)
		case strings.HasPrefix(line, "## Criteria"):
			inCriteria = true
		case inCriteria && strings.HasPrefix(line, "> "):
			criteria = append(criteria, strings.TrimPrefix(line, "> "))
		}
	}
	if len(criteria) == 0 {
		criteria = []string{"Fit (fake runner)"}
	}
	scores := []string{}
	for _, c := range criteria {
		for i, o := range options {
			scores = append(scores, fmt.Sprintf(`{"criterion":%q,"option":%q,"score":%d,"why":"Scored by the fake runner."}`, c, o, max(5-i, 1)))
		}
	}
	quoted := make([]string, 0, len(criteria))
	for _, c := range criteria {
		quoted = append(quoted, fmt.Sprintf("%q", c))
	}
	return `{"criteria":[` + strings.Join(quoted, ",") + `],"scores":[` + strings.Join(scores, ",") +
		`],"recommendation":{"option":"O1","reason":"The first option fits best (fake runner)."}}`
}

// ibisTags tags every message an ibis_tag prompt lists ("> M1 (operator):
// …"): the operator's as questions, the assistant's as ideas.
func ibisTags(prompt string) string {
	tags := []string{}
	for _, line := range strings.Split(prompt, "\n") {
		key, rest, ok := strings.Cut(strings.TrimPrefix(line, "> "), " (")
		if !ok || !strings.HasPrefix(line, "> M") {
			continue
		}
		kind := "idea"
		if strings.HasPrefix(rest, "operator)") {
			kind = "question"
		}
		tags = append(tags, `{"message":"`+key+`","kind":"`+kind+`"}`)
	}
	return `{"tags":[` + strings.Join(tags, ",") + `]}`
}

// groupSuggestion groups the first two ended and the first two open
// branches a group_suggest prompt lists ("> B1 (ended): …").
func groupSuggestion(prompt string) string {
	ended, open := []string{}, []string{}
	for _, line := range strings.Split(prompt, "\n") {
		key, rest, ok := strings.Cut(strings.TrimPrefix(line, "> "), " (")
		if !ok || !strings.HasPrefix(line, "> B") {
			continue
		}
		if strings.HasPrefix(rest, "ended)") {
			ended = append(ended, key)
		} else {
			open = append(open, key)
		}
	}
	groups := []string{}
	if len(ended) >= 2 {
		groups = append(groups, `{"title":"Ended together (fake runner)","members":["`+ended[0]+`","`+ended[1]+`"],"conflicts":[{"branch":"`+ended[0]+
			`","other":"`+ended[1]+`","branchClaim":"the first one says yes","otherClaim":"the second one says no"}]}`)
	}
	if len(open) >= 2 {
		groups = append(groups, `{"title":"Open together (fake runner)","members":["`+open[0]+`","`+open[1]+`"]}`)
	}
	return `{"groups":[` + strings.Join(groups, ",") + `]}`
}
