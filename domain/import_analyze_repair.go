package domain

// repairAnalyzeNodes makes the nodes of a model's reply valid (see
// ParseImportAnalyzeOutput): roles known and within the import's limits, at
// least one chapter, every branch on a chapter, texts flattened and cut,
// titles specific and in the questions' script (guardedAnalyzeTitle).
func repairAnalyzeNodes(nodes []planNode, units []ImportAnalyzeUnit) []ImportAnalyzeNode {
	roles := analyzeRolesWithinLimits(nodes, units)
	owner := map[int]int{}
	for ni, node := range nodes {
		for _, i := range node.units {
			owner[i] = ni
		}
	}
	out := make([]ImportAnalyzeNode, 0, len(nodes))
	for ni, node := range nodes {
		keys := make([]string, 0, len(node.units))
		for _, i := range node.units {
			keys = append(keys, units[i].Key)
		}
		item := ImportAnalyzeNode{
			Key: keys[0], UnitKeys: keys, Title: guardedAnalyzeTitle(CutRunes(FlattenUntrusted(node.raw.Title), ImportAnalyzeNodeTitleRunes), nodeUnits(units, node.units)),
			Role: roles[ni], Reason: CutRunes(FlattenUntrusted(node.raw.Reason), ImportAnalyzeReasonRunes),
		}
		if isImportBranchRole(item.Role) {
			item = attachRepaired(item, node, nodes, roles, owner, units)
		}
		out = append(out, item)
	}
	return out
}

// analyzeRolesWithinLimits are the nodes' roles: known ones (else chapter),
// the largest node a chapter when none is (the first unit is often small
// talk), then moved where the import has no room (roomyRole), and branches
// left without any chapter made standalone.
func analyzeRolesWithinLimits(nodes []planNode, units []ImportAnalyzeUnit) []string {
	roles := make([]string, len(nodes))
	hasChapter := false
	for i, node := range nodes {
		roles[i] = knownAnalyzeRole(node.raw.Role)
		hasChapter = hasChapter || roles[i] == ImportRoleChapter
	}
	if !hasChapter {
		roles[largestNode(nodes)] = ImportRoleChapter
	}
	room := analyzeRoom{}
	hasChapter = false
	for i, node := range nodes {
		count := analyzeMessages(units, node.units)
		roles[i] = room.roomyRole(roles[i], false, count)
		room = room.with(roles[i], count)
		hasChapter = hasChapter || roles[i] == ImportRoleChapter
	}
	if !hasChapter {
		for i := range roles {
			if isImportBranchRole(roles[i]) {
				roles[i] = ImportRoleStandalone
			}
		}
	}
	return roles
}

// attachRepaired hangs a branch node on a chapter: the one its attachToKey
// names, else the chapter it started inside, else the latest chapter before
// it, else the first. Its attachAfterUnitKey must be a unit of that chapter
// before the branch's first unit (else the chapter's latest unit before the
// branch; none when the chapter starts after it). A merged branch's
// conclusion is the reply's, else its last answer's first sentence.
func attachRepaired(item ImportAnalyzeNode, node planNode, nodes []planNode, roles []string, owner map[int]int, units []ImportAnalyzeUnit) ImportAnalyzeNode {
	host := -1
	if i, ok := unitIndex(node.raw.AttachToKey, units); ok && roles[owner[i]] == ImportRoleChapter {
		host = owner[i]
	}
	if host < 0 {
		host = fallbackHost(node.units[0], nodes, roles)
	}
	if host < 0 {
		item.Role = ImportRoleStandalone
		return item
	}
	chapter := &analyzeCluster{units: nodes[host].units}
	item.AttachToKey = units[nodes[host].units[0]].Key
	if i, ok := unitIndex(node.raw.AttachAfterUnitKey, units); ok && owner[i] == host && i < node.units[0] {
		item.AttachAfterUnitKey = units[i].Key
	} else {
		item.AttachAfterUnitKey = lastUnitBefore(units, chapter, node.units[0])
	}
	if item.Role == ImportRoleMergedBranch {
		item.Conclusion = CutRunes(FlattenUntrusted(node.raw.Conclusion), ImportAnalyzeConclusionRunes)
		if item.Conclusion == "" {
			item.Conclusion = firstSentence(units[node.units[len(node.units)-1]].Answer, analyzeEndingRunes)
		}
	}
	return item
}

// fallbackHost is the chapter a branch starting at first hangs on when its
// reply names none: the innermost chapter whose span holds it strictly, else
// the latest chapter starting before it, else the first chapter; -1 without
// any chapter.
func fallbackHost(first int, nodes []planNode, roles []string) int {
	inside, before, any := -1, -1, -1
	for ni, node := range nodes {
		if roles[ni] != ImportRoleChapter {
			continue
		}
		start, end := node.units[0], node.units[len(node.units)-1]
		if any < 0 {
			any = ni
		}
		if start < first {
			before = ni
			if first < end {
				inside = ni
			}
		}
	}
	switch {
	case inside >= 0:
		return inside
	case before >= 0:
		return before
	}
	return any
}

// largestNode is the index of the node with the most units; the earliest on a tie.
func largestNode(nodes []planNode) int {
	largest := 0
	for i, node := range nodes {
		if len(node.units) > len(nodes[largest].units) {
			largest = i
		}
	}
	return largest
}

// nodeUnits are the units of a node, in order.
func nodeUnits(units []ImportAnalyzeUnit, indices []int) []ImportAnalyzeUnit {
	out := make([]ImportAnalyzeUnit, 0, len(indices))
	for _, i := range indices {
		out = append(out, units[i])
	}
	return out
}
