package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/url"
	"strings"
	"sync"
	"time"
)

// worker runs conversations one after another until the context ends: a
// main line, turns, branches and every way a branch ends, the features the
// server has on (the inbox, leaves, seeds, spinoffs, goals, relations,
// groups, tags, folds, diverge / converge / decide, memories), then the
// tree is deleted or archived.
type worker struct {
	id    int
	c     *client
	rng   *rand.Rand
	inv   *invariants
	st    *counters
	feats features
	ops   []operation
}

// tree is the conversation a worker is on: its main line, the open lines
// (main first) it may act on, the outline as last read and the other
// conversations it made (spinoffs) that go with it at the end.
type tree struct {
	main     string
	lines    []string
	branches []branchView
	others   []string
}

func (w *worker) run(ctx context.Context) {
	w.ops = operationsFor(w.feats)
	for ctx.Err() == nil {
		w.conversation(ctx)
	}
}

// conversation is one tree's life.
func (w *worker) conversation(ctx context.Context) {
	var line lineView
	if err := w.c.call(ctx, "POST", "/lines", map[string]any{"title": fmt.Sprintf("soak %d 測試對話 %d", w.id, w.rng.IntN(1e6))}, &line); err != nil {
		w.st.classify("create line", err)
		sleep(ctx, time.Second)
		return
	}
	t := &tree{main: line.ID, lines: []string{line.ID}}
	steps := 15 + w.rng.IntN(25)
	for i := 0; i < steps && ctx.Err() == nil; i++ {
		w.step(ctx, t)
		if i%5 == 4 {
			w.checkTree(ctx, t)
		}
	}
	w.finish(context.WithoutCancel(ctx), t)
}

// step runs one weighted random operation on a random open line.
func (w *worker) step(ctx context.Context, t *tree) {
	line := t.lines[w.rng.IntN(len(t.lines))]
	pickOperation(w.ops, w.rng).run(w, ctx, t, line)
}

// sideCall is one of the cheaper calls: previews, renames, notes, compact,
// archive and back.
func (w *worker) sideCall(ctx context.Context, t *tree, line string) {
	switch roll := w.rng.IntN(100); {
	case roll < 25:
		w.preview(ctx, line)
	case roll < 45:
		if anchor, ok := w.anchor(ctx, line); ok {
			w.st.classify("preview branch", w.c.call(ctx, "POST", "/lines/"+line+"/branches/preview", map[string]any{"anchorMessageId": anchor, "kind": "investigate", "includeLater": true}, nil))
		}
	case roll < 60:
		if line != t.main {
			w.st.classify("rename", w.c.call(ctx, "PATCH", "/lines/"+line+"/branch", map[string]any{"purpose": fmt.Sprintf("renamed %d", w.rng.IntN(1000))}, nil))
		}
	case roll < 80:
		w.st.classify("note", w.c.call(ctx, "POST", "/lines/"+t.main+"/notes", map[string]any{"section": "fact", "text": fmt.Sprintf("fact %d", w.rng.IntN(1e6))}, nil))
	case roll < 86:
		w.st.classify("compact", w.c.call(ctx, "POST", "/lines/"+line+"/compact", nil, nil))
	case roll < 92:
		if anchor, ok := w.anchor(ctx, line); ok {
			w.st.classify("milestone", w.c.call(ctx, "POST", "/lines/"+line+"/chapters/milestones", map[string]any{"messageId": anchor, "title": fmt.Sprintf("章節 %d", w.rng.IntN(1000))}, nil),
				"milestone_exists", "milestone_limit")
		}
	default:
		if w.st.classify("archive", w.c.call(ctx, "POST", "/lines/"+t.main+"/archive", nil, nil)) {
			w.st.classify("unarchive", w.c.call(ctx, "POST", "/lines/"+t.main+"/unarchive", nil, nil))
		}
	}
}

// turnContent is a message with random fake directives: plain, slow,
// waits, failures, retries, suggestions and a draft that will fail.
func (w *worker) turnContent() string {
	options := []string{
		"今天的進度如何？", "What are the trade-offs here?", "混合 mixed 內容 with English",
		"[fake:wait=%dms] take your time", "[fake:slow] a slow one", "[fake:error] this one fails",
		"[fake:retry] retry once", "[fake:suggest] maybe branch", "[fake:reasoning] think first",
		"[fake:job-error] drafts from here fail", "By the way, something else entirely [fake:drift]", longMessage,
	}
	text := options[w.rng.IntN(len(options))]
	if text == options[3] {
		text = fmt.Sprintf(text, 50+w.rng.IntN(4000))
	}
	return text + fmt.Sprintf(" #%d", w.rng.IntN(1e6))
}

// longMessage makes chapters long enough for fold to suggest folding them.
var longMessage = strings.Repeat("A long message about storage layouts, backups and 備份策略. ", 12)

// turn sends a message, sometimes cancels it, waits for the reply and
// retries a failure most of the time.
func (w *worker) turn(ctx context.Context, line string) {
	var started struct {
		TurnID      string  `json:"turnId"`
		UserMessage message `json:"userMessage"`
	}
	err := w.c.call(ctx, "POST", "/lines/"+line+"/messages", map[string]any{"content": w.turnContent()}, &started)
	if !w.st.classify("send", err) || err != nil {
		return
	}
	w.st.outcome("turn started")
	if w.rng.IntN(10) == 0 {
		sleep(ctx, time.Duration(w.rng.IntN(1500))*time.Millisecond)
		w.st.classify("cancel", w.c.call(ctx, "POST", "/lines/"+line+"/cancel", nil, nil))
	}
	final := w.waitReply(ctx, line, started.UserMessage.Seq, started.TurnID)
	w.st.outcome("turn " + final)
	if final == "error" && w.rng.IntN(10) < 7 {
		var retried struct {
			TurnID string `json:"turnId"`
		}
		if err := w.c.call(ctx, "POST", "/lines/"+line+"/retry", nil, &retried); w.st.classify("retry", err) && err == nil {
			w.st.outcome("retry " + w.waitReply(ctx, line, started.UserMessage.Seq, retried.TurnID))
		}
	}
}

// waitReply polls the line until the reply is no longer pending and
// returns its status ("timeout" after replyTimeout).
func (w *worker) waitReply(ctx context.Context, line string, afterSeq int64, turnID string) string {
	deadline := time.Now().Add(replyTimeout)
	for time.Now().Before(deadline) {
		messages, err := w.messages(ctx, line, afterSeq-1)
		if err != nil {
			return "gone"
		}
		for _, m := range messages {
			if m.ID == turnID && m.Status != "pending" {
				return m.Status
			}
		}
		sleep(ctx, 150*time.Millisecond)
	}
	w.inv.violate("turn %s on line %s stayed pending for %v", turnID, line, replyTimeout)
	return "timeout"
}

// replyTimeout is longer than any scripted wait plus a busy dispatcher.
const replyTimeout = 3 * time.Minute

// messages reads a line after a seq and checks the page.
func (w *worker) messages(ctx context.Context, line string, afterSeq int64) ([]message, error) {
	var page struct {
		Messages []message `json:"messages"`
	}
	path := fmt.Sprintf("/lines/%s/messages?limit=500&afterSeq=%d", line, max(afterSeq, 0))
	if err := w.c.call(ctx, "GET", path, nil, &page); err != nil {
		return nil, err
	}
	w.inv.observeMessages(line, page.Messages)
	return page.Messages, nil
}

// doubleSend races two messages on one line: one may start, the other
// must be refused (turn_pending) or both refused while busy. Each scripts a
// wait of doubleSendWait, so the first cannot have finished within half of
// it: two starts closer than that ran at once.
func (w *worker) doubleSend(ctx context.Context, line string) {
	var wg sync.WaitGroup
	results := make([]error, 2)
	starts := make([]message, 2)
	for i := range results {
		wg.Go(func() {
			var started struct {
				UserMessage message `json:"userMessage"`
			}
			content := fmt.Sprintf("[fake:wait=%dms] race %d", doubleSendWait.Milliseconds(), i)
			results[i] = w.c.call(ctx, "POST", "/lines/"+line+"/messages", map[string]any{"content": content}, &started)
			starts[i] = started.UserMessage
		})
	}
	wg.Wait()
	started := 0
	for _, err := range results {
		if err == nil {
			started++
			continue
		}
		// A refusal is expected; a request cut off because the run ended is not a failure.
		w.st.classify("double send", err)
	}
	if started > 1 {
		gap := starts[1].CreatedAt.Sub(starts[0].CreatedAt).Abs()
		if gap < doubleSendWait/2 {
			w.inv.violate("two turns started at once on line %s (%v apart)", line, gap)
		} else {
			w.st.outcome("double send 2 started one after the other")
		}
	}
	w.st.outcome(fmt.Sprintf("double send %d started", started))
	w.st.op("double send", fmt.Sprintf("%d started", started))
}

// doubleSendWait is the scripted wait of a raced message.
const doubleSendWait = 400 * time.Millisecond

// search runs a search in one of three languages.
func (w *worker) search(ctx context.Context) {
	queries := []string{"進度", "trade-offs", "mixed 內容", "soak", "fake reply"}
	q := queries[w.rng.IntN(len(queries))]
	w.st.classify("search", w.c.call(ctx, "GET", "/search?limit=20&q="+url.QueryEscape(q), nil, nil))
}

func sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
