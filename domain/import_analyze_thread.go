package domain

import (
	"fmt"
	"strings"
)

// The deterministic import analysis (AnalyzeImportDeterministic): threading
// units into topic clusters, then roles. The web client's analyzeImportLocal
// (web/packages/client/src/import-analyze-local.ts) is the same algorithm;
// keep them equal.

const (
	// analyzeUnitReplyRunes are the answer runes counted into a unit's words.
	analyzeUnitReplyRunes = 300
	// analyzeCoreMessages makes a one-unit cluster a core topic (two rounds or more).
	analyzeCoreMessages = 4
	// analyzeEndingRunes caps a heuristic conclusion (the client's ENDING_RUNES).
	analyzeEndingRunes = 120
)

// analyzeCluster is one topic while units are threaded: its units in order,
// the words of all its questions (what the topic is about), the words
// (question and answer) of its latest units only (its answers are short
// memory, so a reply's words do not snowball) and its size.
type analyzeCluster struct {
	units    []int
	asked    map[string]bool
	latest   []map[string]bool
	messages int
	replied  bool
}

func newAnalyzeCluster() *analyzeCluster { return &analyzeCluster{asked: map[string]bool{}} }

func (c *analyzeCluster) first() int { return c.units[0] }
func (c *analyzeCluster) last() int  { return c.units[len(c.units)-1] }

func (c *analyzeCluster) add(i int, unit ImportAnalyzeUnit) {
	c.units = append(c.units, i)
	for term := range importTermSet(analyzeAskedText(unit)) {
		c.asked[term] = true
	}
	c.latest = append(c.latest, importTermSet(analyzeUnitText(unit, analyzeUnitReplyRunes)))
	if len(c.latest) > analyzeRecentUnits {
		c.latest = c.latest[len(c.latest)-analyzeRecentUnits:]
	}
	c.messages += unit.MessageCount
	c.replied = c.replied || unit.Answer != ""
}

// recent reports whether one of the cluster's latest units used the word.
func (c *analyzeCluster) recent(term string) bool {
	for _, terms := range c.latest {
		if terms[term] {
			return true
		}
	}
	return false
}

// analyzeUnitText is a unit's title, question and the head of its answer.
func analyzeUnitText(unit ImportAnalyzeUnit, replyRunes int) string {
	return unit.Title + "\n" + unit.Question + "\n" + headRunes(unit.Answer, replyRunes)
}

// analyzeAskedText is what a unit asks: its title and question.
func analyzeAskedText(unit ImportAnalyzeUnit) string { return unit.Title + "\n" + unit.Question }

func headRunes(text string, n int) string {
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	return string(runes[:n])
}

// threadAnalyzeUnits puts every unit in a cluster (see AnalyzeImportDeterministic).
func threadAnalyzeUnits(title string, units []ImportAnalyzeUnit) []*analyzeCluster {
	weights := analyzeTermWeights(title, units)
	clusters := []*analyzeCluster{}
	current := -1
	for i, unit := range units {
		target := -1
		if current >= 0 {
			target = threadTarget(unit, clusters, current, weights)
		}
		if target < 0 {
			clusters = append(clusters, newAnalyzeCluster())
			target = len(clusters) - 1
		}
		clusters[target].add(i, unit)
		current = target
	}
	return clusters
}

// threadTarget is the cluster a unit joins (see AnalyzeImportDeterministic).
// A unit before any reply, one without topic words, or one whose every
// word the current cluster has (Docker 第 10 題 in a Docker chat) stays
// with the current cluster. One that reads as going on (continuesTopic: a follow-up
// opening, a short report-back, a pointer back) stays unless another
// cluster could take it by its words. Otherwise the cluster sharing the
// most weight with the question wins (the current one on a tie, else the
// most recent), if that reaches its threshold (lower for the current
// cluster than for coming back to an earlier one); -1 starts a new one.
func threadTarget(unit ImportAnalyzeUnit, clusters []*analyzeCluster, current int, weights analyzeWeights) int {
	cur := clusters[current]
	if !cur.replied {
		return current
	}
	asked := importTopicTermsAt(analyzeAskedText(unit))
	if len(asked) == 0 {
		return current
	}
	joins := joinScores(asked, clusters, weights)
	if joins[current].shared == len(asked) {
		return current
	}
	if continuesTopic(unit.Question) && !anotherClaims(joins, clusters, current) {
		return current
	}
	return bestJoin(joins, clusters, current)
}

// anotherClaims reports whether a cluster other than the current one
// reaches its threshold.
func anotherClaims(joins []analyzeJoin, clusters []*analyzeCluster, current int) bool {
	for j := range clusters {
		if j != current && joins[j].score >= joinThreshold(j, current) {
			return true
		}
	}
	return false
}

// bestJoin is the cluster with the highest join score at or over its
// threshold: the current one on a tie, else the most recent; -1 when none.
func bestJoin(joins []analyzeJoin, clusters []*analyzeCluster, current int) int {
	best, bestScore := -1, 0.0
	for j, c := range clusters {
		score := joins[j].score
		switch {
		case score < joinThreshold(j, current) || score < bestScore:
		case score > bestScore, j == current:
			best, bestScore = j, score
		case best != current && c.last() > clusters[best].last():
			best = j
		}
	}
	return best
}

// analyzeRoom is what the main tree holds so far while roles are given.
type analyzeRoom struct{ main, chapters, branches int }

func (r analyzeRoom) fitsChapter(count int) bool {
	return r.main+count <= ImportMaxMessages && r.chapters < ImportMaxChapterCuts
}

func (r analyzeRoom) fitsBranch(count int) bool {
	return count <= ImportMaxBranchMessages && r.branches < ImportMaxBranches
}

// roomyRole moves a wanted role the tree has no room for: a branch to a
// chapter (else its own conversation), a chapter to a branch (else its own
// conversation). must keeps a heuristic plan's first chapter a chapter.
func (r analyzeRoom) roomyRole(wanted string, must bool, count int) string {
	switch {
	case must:
		return ImportRoleChapter
	case isImportBranchRole(wanted) && !r.fitsBranch(count):
		if r.fitsChapter(count) {
			return ImportRoleChapter
		}
		return ImportRoleStandalone
	case wanted == ImportRoleChapter && !r.fitsChapter(count):
		if r.fitsBranch(count) {
			return ImportRoleMergedBranch
		}
		return ImportRoleStandalone
	}
	return wanted
}

func isImportBranchRole(role string) bool {
	return role == ImportRoleMergedBranch || role == ImportRoleOpenBranch
}

func (r analyzeRoom) with(role string, count int) analyzeRoom {
	switch role {
	case ImportRoleChapter:
		return analyzeRoom{main: r.main + count, chapters: r.chapters + 1, branches: r.branches}
	case ImportRoleMergedBranch, ImportRoleOpenBranch:
		return analyzeRoom{main: r.main, chapters: r.chapters, branches: r.branches + 1}
	}
	return r
}

func (c *analyzeCluster) core() bool { return len(c.units) >= 2 || c.messages >= analyzeCoreMessages }

// firstChapter is the cluster that is the plan's first chapter: the first
// core one, else the largest (the earliest on a tie). Opening small talk
// is not the chapter just for coming first.
func firstChapter(clusters []*analyzeCluster) int {
	largest := 0
	for i, c := range clusters {
		if c.core() {
			return i
		}
		if len(c.units) > len(clusters[largest].units) {
			largest = i
		}
	}
	return largest
}

// detourHost is the innermost chapter whose span holds the cluster's first
// unit strictly inside; -1 when none does.
func detourHost(c *analyzeCluster, clusters []*analyzeCluster, chapters []int) int {
	host := -1
	for _, h := range chapters {
		if clusters[h].first() < c.first() && c.first() < clusters[h].last() && (host < 0 || clusters[h].first() > clusters[host].first()) {
			host = h
		}
	}
	return host
}

// lastUnitBefore is the key of the chapter's latest unit before index; "" when none.
func lastUnitBefore(units []ImportAnalyzeUnit, chapter *analyzeCluster, index int) string {
	key := ""
	for _, i := range chapter.units {
		if i < index {
			key = units[i].Key
		}
	}
	return key
}

// assignAnalyzeRoles makes the nodes of the clusters (see AnalyzeImportDeterministic).
func assignAnalyzeRoles(units []ImportAnalyzeUnit, clusters []*analyzeCluster) []ImportAnalyzeNode {
	nodes := make([]ImportAnalyzeNode, 0, len(clusters))
	chapters := []int{}
	room := analyzeRoom{}
	first := firstChapter(clusters)
	for ci, c := range clusters {
		host := detourHost(c, clusters, chapters)
		wanted := ImportRoleStandalone
		switch {
		case ci == first, host < 0 && c.core():
			wanted = ImportRoleChapter
		case host >= 0:
			wanted = ImportRoleMergedBranch
		}
		role := room.roomyRole(wanted, ci == first, c.messages)
		room = room.with(role, c.messages)
		node := analyzeNode(units, c)
		node.Role = role
		switch role {
		case ImportRoleChapter:
			chapters = append(chapters, ci)
		case ImportRoleMergedBranch:
			attach := host
			if attach < 0 {
				attach = chapters[len(chapters)-1]
			}
			node.AttachToKey = units[clusters[attach].first()].Key
			node.AttachAfterUnitKey = lastUnitBefore(units, clusters[attach], c.first())
			node.Conclusion = firstSentence(units[c.last()].Answer, analyzeEndingRunes)
		}
		node.Reason = analyzeReason(node, c, host >= 0 && role == ImportRoleMergedBranch)
		nodes = append(nodes, node)
	}
	return nodes
}

// analyzeNode is a cluster's node before its role: its units and title.
func analyzeNode(units []ImportAnalyzeUnit, c *analyzeCluster) ImportAnalyzeNode {
	keys := make([]string, 0, len(c.units))
	for _, i := range c.units {
		keys = append(keys, units[i].Key)
	}
	return ImportAnalyzeNode{Key: keys[0], UnitKeys: keys, Title: analyzeTitle(units[c.first()])}
}

// analyzeTitle is a node's title: its first unit's title, else its question,
// else the first sentence of its answer, else its key.
func analyzeTitle(unit ImportAnalyzeUnit) string {
	for _, text := range []string{unit.Title, unit.Question, firstSentence(unit.Answer, ImportAnalyzeNodeTitleRunes)} {
		if flat := FlattenUntrusted(text); flat != "" {
			return CutRunes(flat, ImportAnalyzeNodeTitleRunes)
		}
	}
	return CutRunes(unit.Key, ImportAnalyzeNodeTitleRunes)
}

// unitNumbers are a cluster's units as "#1、#3、#5" (1-based input order).
func unitNumbers(c *analyzeCluster) string {
	parts := make([]string, 0, len(c.units))
	for _, i := range c.units {
		parts = append(parts, fmt.Sprintf("#%d", i+1))
	}
	return strings.Join(parts, "、")
}

// analyzeReason says why a node holds its units and has its role.
func analyzeReason(node ImportAnalyzeNode, c *analyzeCluster, detour bool) string {
	threaded := ""
	if len(c.units) > 1 {
		threaded = fmt.Sprintf("跨段縫合 %s 的同主題問答；", unitNumbers(c))
	}
	switch node.Role {
	case ImportRoleChapter:
		return threaded + "貫穿對話的主題，作為主幹章節"
	case ImportRoleMergedBranch:
		if detour {
			return threaded + "穿插於主幹期間的延伸話題，掛為支線"
		}
		return threaded + "主幹放不下，改掛為支線"
	}
	return threaded + "不在主幹範圍內的單獨話題，另存為獨立對話"
}
