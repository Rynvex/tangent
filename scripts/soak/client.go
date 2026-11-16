package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// client calls the reference server's API with the writer token.
type client struct {
	base  string
	token string
	http  *http.Client
	stats *counters
}

// apiError is a refusal the API answered with its envelope.
type apiError struct {
	Status int
	Code   string
	Body   string
}

func (e *apiError) Error() string { return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Body) }

// call sends one API request (path under /api) and decodes a 2xx JSON
// answer into out (when not nil). A non-2xx answer is an *apiError; the
// counters record it.
func (c *client) call(ctx context.Context, method, path string, body, out any) error {
	return c.do(ctx, method, "/api"+path, body, out)
}

// do is call for any path of the server.
func (c *client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	parent := ctx
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	started := time.Now()
	resp, err := c.http.Do(req)
	if err != nil {
		if parent.Err() != nil {
			return errStopped // the run ended, not the server
		}
		c.stats.transport(method + " " + routeOf(path))
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	route := method + " " + routeOf(path)
	c.stats.latency(route, time.Since(started))
	return c.answer(route, resp.StatusCode, raw, out)
}

// answer turns a response into the call's result: a non-2xx is an
// *apiError (recorded), a 2xx body must be one JSON object that decodes
// into out (a *shapeError otherwise).
func (c *client) answer(route string, status int, raw []byte, out any) error {
	if status/100 != 2 {
		var envelope struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(raw, &envelope)
		failure := &apiError{Status: status, Code: envelope.Code, Body: truncate(string(raw), 300)}
		c.stats.refusal(route, failure)
		return failure
	}
	if len(raw) == 0 {
		if status != http.StatusNoContent && out != nil {
			return &shapeError{route: route, problem: "an empty body"}
		}
		return nil
	}
	if !jsonObject(raw) {
		return &shapeError{route: route, problem: "not a JSON object: " + truncate(string(raw), 200)}
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return &shapeError{route: route, problem: err.Error()}
		}
	}
	return nil
}

// shapeError is a 2xx answer whose body is not what the API promises.
type shapeError struct{ route, problem string }

func (e *shapeError) Error() string { return "malformed answer of " + e.route + ": " + e.problem }

// jsonObject reports whether raw is one JSON object.
func jsonObject(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{' && json.Valid(trimmed)
}

// errStopped is a request cut off because the run ended.
var errStopped = errors.New("stopped: the run ended")

// requestTimeout bounds one API request.
const requestTimeout = 30 * time.Second

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// Shapes of the API this driver reads.
type (
	message struct {
		ID        string    `json:"id"`
		LineID    string    `json:"lineId"`
		Seq       int64     `json:"seq"`
		Role      string    `json:"role"`
		Kind      string    `json:"kind"`
		Status    string    `json:"status"`
		Content   string    `json:"content"`
		Pinned    bool      `json:"pinned"`
		Tag       *tagView  `json:"tag"`
		CreatedAt time.Time `json:"createdAt"`
	}
	tagView struct {
		Kind   string `json:"kind"`
		Source string `json:"source"`
		Status string `json:"status"`
	}
	lineView struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	branchView struct {
		LineID           string    `json:"lineId"`
		ParentLineID     string    `json:"parentLineId"`
		RootLineID       string    `json:"rootLineId"`
		AnchorMessageID  string    `json:"anchorMessageId"`
		Status           string    `json:"status"`
		Kind             string    `json:"kind"`
		Origin           string    `json:"origin"`
		Depth            int       `json:"depth"`
		DraftStatus      string    `json:"draftStatus"`
		LineStatus       string    `json:"lineStatus"`
		MergedIntoLineID string    `json:"mergedIntoLineId"`
		Leaf             *leafView `json:"leaf"`
	}
	leafView struct {
		Kind   string `json:"kind"`
		Line   string `json:"line"`
		Status string `json:"status"`
	}
	branchDetail struct {
		Branch             branchView     `json:"branch"`
		ParentTipMessageID string         `json:"parentTipMessageId"`
		Draft              map[string]any `json:"draft"`
	}
)
