package httpapi_test

import (
	"net/http"
	"testing"
)

// seeded is tenant A's data the route table works on: a main line with two
// exchanges, an open branch with one, a note and a milestone.
type seeded struct {
	main, reply, branch, note, milestone string
	// suggestion and seed are open ones of the main line's tree; relation
	// joins the main line's first reply and the branch.
	suggestion, seed, relation string
	// group groups two ended branches; free1 and free2 are two more ended
	// ones, open2 a second open branch beside branch.
	group, free1, free2, open2 string
	// fold folds the main line's first exchange (firstMessage is its
	// question); the second exchange (secondQuestion, secondReply) is free.
	fold, firstMessage, secondQuestion, secondReply string
	// diverged1 and diverged2 are a diverge of the main line's first reply;
	// comparison compares them (ready).
	diverged1, diverged2, comparison string
	// arena is a main line of its own with a reply (arenaReply), for the
	// cross-model diverge (B14).
	arena, arenaReply string
	// aside is an answered (ended) aside and discarded a discarded branch,
	// both on the arena line (B23).
	aside, discarded string
	// term is a glossary term of the main line (B24).
	term string
	// importBatch is an import batch of one imported conversation (B25).
	importBatch string
}

func (h *harness) seed() seeded {
	h.t.Helper()
	s := seeded{main: h.line()}
	s.reply = h.turn(s.main, "first question")
	h.turn(s.main, "second question")
	s.branch = h.branch(s.main, s.reply, "look closer")
	h.turn(s.branch, "in the branch")
	note := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+s.main+"/notes", map[string]any{"section": "fact", "text": "a fact"}))
	s.note = field(note, "note", "id").(string)
	milestone := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+s.main+"/chapters/milestones", map[string]any{"messageId": s.reply}))
	s.milestone = field(milestone, "milestone", "id").(string)
	s.suggestion, s.seed = h.p1Seed(s.main)
	s.relation = h.p2Seed(s)
	h.p2cSeed(&s)
	h.p3Seed(&s)
	h.p3bSeed(&s)
	h.b14Seed(&s)
	h.b23Seed(&s)
	h.termSeed(&s)
	h.importSeed(&s)
	return s
}

// routeCase is one route with a valid request and an invalid one.
type routeCase struct {
	name    string
	method  string
	path    string
	body    any
	write   bool
	feature string
	// lineScoped routes answer 404 to another tenant.
	lineScoped bool
	bad        badRequest
}

type badRequest struct {
	path   string // defaults to the route's path
	body   any
	status int
	code   string
}

const unknownID = "00000000-0000-4000-8000-0000000000aa"

func routeTable(s seeded) []routeCase {
	return append(append(append(append(append(append(coreRoutes(s), featureRoutes(s)...), p1Routes(s)...), p2Routes(s)...), p2cRoutes(s)...), p3Routes(s)...), append(append(append(p3bRoutes(s), b14Routes(s)...), b15Routes(s)...), append(append(b17Routes(s), b18Routes(s)...), append(append(b23Routes(s), termRoutes(s)...), importRoutes(s)...)...)...)...)
}

// coreRoutes are the routes every engine mounts.
func coreRoutes(s seeded) []routeCase {
	line, branch := "/lines/"+s.main, "/lines/"+s.branch
	badLine := badRequest{path: "/lines/not-a-uuid", status: http.StatusNotFound, code: "line_not_found"}
	withBadLine := func(suffix string) badRequest {
		return badRequest{path: "/lines/not-a-uuid" + suffix, status: http.StatusNotFound, code: "line_not_found"}
	}
	return []routeCase{
		{name: "capabilities", method: "GET", path: "/capabilities"},
		{name: "list lines", method: "GET", path: "/lines", bad: badRequest{path: "/lines?limit=0", status: 400, code: "invalid_input"}},
		{name: "create line", method: "POST", path: "/lines", body: map[string]any{"title": "x"}, write: true,
			bad: badRequest{body: map[string]any{"hostMeta": map[string]any{"a": 1}}, status: 400, code: "invalid_input"}},
		{name: "get line", method: "GET", path: line, lineScoped: true, bad: badLine},
		{name: "update line", method: "PATCH", path: line, body: map[string]any{"title": "y"}, write: true, lineScoped: true,
			bad: badRequest{body: map[string]any{}, status: 400, code: "invalid_input"}},
		{name: "delete line", method: "DELETE", path: line, write: true, lineScoped: true, bad: badLine},
		{name: "archive", method: "POST", path: line + "/archive", write: true, lineScoped: true,
			bad: badRequest{path: branch + "/archive", status: 409, code: "branch_not_main_line"}},
		{name: "unarchive", method: "POST", path: line + "/unarchive", write: true, lineScoped: true, bad: withBadLine("/unarchive")},
		{name: "read", method: "POST", path: line + "/read", write: true, lineScoped: true, bad: withBadLine("/read")},
		{name: "list messages", method: "GET", path: line + "/messages", lineScoped: true,
			bad: badRequest{path: line + "/messages?afterSeq=-1", status: 400, code: "invalid_input"}},
		{name: "send message", method: "POST", path: line + "/messages", body: map[string]any{"content": "hi"}, write: true, lineScoped: true,
			bad: badRequest{body: map[string]any{"content": "  "}, status: 400, code: "invalid_input"}},
		{name: "stream", method: "GET", path: line + "/stream", lineScoped: true,
			bad: badRequest{path: line + "/stream?afterSeq=x", status: 400, code: "invalid_input"}},
		{name: "retry", method: "POST", path: line + "/retry", write: true, lineScoped: true,
			bad: badRequest{status: 409, code: "nothing_to_retry"}},
		{name: "cancel", method: "POST", path: line + "/cancel", write: true, lineScoped: true, bad: withBadLine("/cancel")},
		{name: "compact", method: "POST", path: line + "/compact", write: true, lineScoped: true, feature: "summary", bad: withBadLine("/compact")},
		{name: "preview", method: "POST", path: line + "/preview", body: map[string]any{"content": "x"}, lineScoped: true,
			bad: badRequest{body: `["not an object"]`, status: 400, code: "invalid_input"}},
		{name: "list branches", method: "GET", path: line + "/branches", lineScoped: true,
			bad: badRequest{path: line + "/branches?includeAside=maybe", status: 400, code: "invalid_input"}},
		{name: "create branch", method: "POST", path: line + "/branches", body: map[string]any{"anchorMessageId": s.reply, "purpose": "p", "kind": "investigate"},
			write: true, lineScoped: true, bad: badRequest{body: map[string]any{"anchorMessageId": s.reply, "purpose": "p", "kind": "nope"}, status: 400, code: "kind_unsupported"}},
		{name: "move", method: "POST", path: line + "/branches/move", body: map[string]any{"count": 2, "purpose": "p"}, write: true, lineScoped: true,
			bad: badRequest{body: map[string]any{"count": 0, "purpose": "p"}, status: 400, code: "invalid_count"}},
		{name: "preview branch", method: "POST", path: line + "/branches/preview", body: map[string]any{"anchorMessageId": s.reply, "kind": "investigate"},
			lineScoped: true, bad: badRequest{body: map[string]any{"anchorMessageId": unknownID, "kind": "investigate"}, status: 404, code: "anchor_not_found"}},
		{name: "get branch", method: "GET", path: branch + "/branch", lineScoped: true,
			bad: badRequest{path: line + "/branch", status: 404, code: "branch_not_found"}},
		{name: "rename branch", method: "PATCH", path: branch + "/branch", body: map[string]any{"purpose": "look even closer"}, write: true, lineScoped: true,
			bad: badRequest{body: map[string]any{"purpose": " "}, status: 400, code: "invalid_input"}},
		{name: "draft", method: "POST", path: branch + "/branch/draft", write: true, lineScoped: true, feature: "card_draft",
			bad: badRequest{path: line + "/branch/draft", status: 404, code: "branch_not_found"}},
		{name: "merge", method: "POST", path: branch + "/branch/merge", body: map[string]any{"card": map[string]any{"question": "q", "conclusion": "c"}, "parentTipMessageId": s.reply},
			write: true, lineScoped: true, bad: badRequest{body: map[string]any{"card": "text", "parentTipMessageId": s.reply}, status: 422, code: "invalid_card"}},
		{name: "discard", method: "POST", path: branch + "/branch/discard", write: true, lineScoped: true,
			bad: badRequest{path: line + "/branch/discard", status: 404, code: "branch_not_found"}},
		{name: "promote", method: "POST", path: branch + "/branch/promote", body: map[string]any{"confirm": true}, write: true, lineScoped: true,
			bad: badRequest{body: map[string]any{"confirm": false}, status: 400, code: "invalid_input"}},
	}
}

// featureRoutes are the notes and chapters routes and /events.
func featureRoutes(s seeded) []routeCase {
	line := "/lines/" + s.main
	withBadLine := func(suffix string) badRequest {
		return badRequest{path: "/lines/not-a-uuid" + suffix, status: http.StatusNotFound, code: "line_not_found"}
	}
	return []routeCase{
		{name: "list notes", method: "GET", path: line + "/notes", lineScoped: true, feature: "notes", bad: withBadLine("/notes")},
		{name: "create note", method: "POST", path: line + "/notes", body: map[string]any{"section": "todo", "text": "t"}, write: true, lineScoped: true, feature: "notes",
			bad: badRequest{body: map[string]any{"section": "nope", "text": "t"}, status: 422, code: "invalid_note"}},
		{name: "update note", method: "PATCH", path: line + "/notes/" + s.note, body: map[string]any{"text": "t2"}, write: true, lineScoped: true, feature: "notes",
			bad: badRequest{path: line + "/notes/bad-id", body: map[string]any{"text": "t"}, status: 404, code: "note_not_found"}},
		{name: "supersede note", method: "POST", path: line + "/notes/" + s.note + "/supersede", body: map[string]any{"text": "t3"}, write: true, lineScoped: true, feature: "notes",
			bad: badRequest{path: line + "/notes/" + unknownID + "/supersede", body: map[string]any{"text": "t"}, status: 404, code: "note_not_found"}},
		{name: "list chapters", method: "GET", path: line + "/chapters", lineScoped: true, feature: "chapters", bad: withBadLine("/chapters")},
		{name: "add milestone", method: "POST", path: line + "/chapters/milestones", body: map[string]any{"messageId": s.reply, "title": "again"}, write: true, lineScoped: true, feature: "chapters",
			bad: badRequest{body: map[string]any{"messageId": unknownID}, status: 404, code: "message_not_found"}},
		{name: "delete milestone", method: "DELETE", path: line + "/chapters/milestones/" + s.milestone, write: true, lineScoped: true, feature: "chapters",
			bad: badRequest{path: line + "/chapters/milestones/x", status: 404, code: "milestone_not_found"}},
		{name: "search", method: "GET", path: "/search?q=question", feature: "search",
			bad: badRequest{path: "/search?q=q", status: 400, code: "invalid_input"}},
		{name: "events", method: "GET", path: "/events"},
	}
}

func TestRoutes_TheTableCoversEveryRoute(t *testing.T) {
	cases := routeTable(seeded{})
	if len(cases) != 102 {
		t.Fatalf("%d routes in the table; DESIGN §7 + /events + /capabilities + /preview + /retry + B5 (/search, /branches/preview, PATCH /branch) + B8 (3 suggestions, 4 leaf, 5 seeds, spinoff, its preview, links) + B9 (4 goal, 4 relations, open loops, 2 pin, 6 groups, combine) + B10 (2 tag, 4 folds, diverge, converge, 2 comparisons, decide) + B14 (export, diverge/models, seeds/batch) + B15 (tag-drafts) + B17 (suggestions/dismiss-all, PATCH /branch/card) + B18 (import, folders/rename, branches/extract, decompose) + B18.1 (lines/organization) + B20 (attach) + B22 (import-analyze) + B23 (branch/keep, branch/continue, DELETE /branch) + B24 (5 terms) + B25 (GET /imports, DELETE /imports/{bid}) has 102", len(cases))
	}
}

func TestRoutes_ValidationFailures(t *testing.T) {
	h := newHarness(t)
	s := h.seed()
	for _, rc := range routeTable(s) {
		if rc.bad.status == 0 {
			continue
		}
		path := rc.bad.path
		if path == "" {
			path = rc.path
		}
		body := rc.bad.body
		if body == nil {
			body = rc.body
		}
		h.wantError(h.do(rc.method, path, body), rc.bad.status, rc.bad.code)
	}
	for _, path := range []string{"/lines", "/lines/" + s.main + "/messages", "/lines/" + s.branch + "/branch/merge"} {
		h.wantError(h.do(http.MethodPost, path, "{not json"), http.StatusBadRequest, "invalid_input")
	}
}

func TestRoutes_ReadOnlyCallersChangeNothing(t *testing.T) {
	h := newHarness(t)
	s := h.seed()
	before := len(h.events.Events())
	for _, rc := range routeTable(s) {
		if rc.name == "events" {
			continue
		}
		r := h.do(rc.method, rc.path, rc.body, readOnly())
		if rc.write {
			h.wantError(r, http.StatusForbidden, "forbidden")
			continue
		}
		if r.status != http.StatusOK {
			t.Errorf("%s: a read-only caller may read: %d %s", rc.name, r.status, r.raw)
		}
	}
	if after := len(h.events.Events()); after != before {
		t.Fatalf("read-only requests published %d events", after-before)
	}
}

func TestRoutes_AnonymousCallersAreRefused(t *testing.T) {
	h := newHarness(t)
	s := h.seed()
	for _, rc := range routeTable(s) {
		h.wantError(h.do(rc.method, rc.path, rc.body, anonymous()), http.StatusUnauthorized, "unauthorized")
	}
}

func TestRoutes_AnotherTenantSeesNothing(t *testing.T) {
	h := newHarness(t)
	s := h.seed()
	before := len(h.events.Events())
	for _, rc := range routeTable(s) {
		if !rc.lineScoped {
			continue
		}
		r := h.do(rc.method, rc.path, rc.body, as(tenantB))
		if r.status != http.StatusNotFound {
			t.Errorf("%s: tenant B got %d %s", rc.name, r.status, r.raw)
		}
	}
	if after := len(h.events.Events()); after != before {
		t.Fatalf("tenant B's requests changed tenant A's data (%d events)", after-before)
	}
	page := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines", nil, as(tenantB)))
	if len(page["lines"].([]any)) != 0 {
		t.Fatalf("tenant B lists tenant A's lines: %v", page)
	}
	if body := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+s.main, nil)); body["title"] != "main" {
		t.Fatalf("tenant A's line is intact: %v", body)
	}
}
