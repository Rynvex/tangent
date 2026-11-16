package domain

// Tree rebalancing hints (the rebalance feature): when a branch has taken
// over the conversation, suggest promoting it or spinning it off. Only a
// hint: nothing changes until the operator accepts.

// Reasons a branch is due.
const (
	// RebalanceReasonShare: enough turns since the fork and at least
	// ShareFactor times the parent's since then.
	RebalanceReasonShare = "share"
	// RebalanceReasonRecent: the conversation's last RecentTurns turns all
	// happened in this branch.
	RebalanceReasonRecent = "recent"
)

// RebalanceSignals is what is measured of a branch after one of its turns.
type RebalanceSignals struct {
	// BranchTurns counts the branch's finished replies; ParentTurns the
	// parent's finished replies after the fork.
	BranchTurns int `json:"branchTurns"`
	ParentTurns int `json:"parentTurns"`
	// RecentInBranch: the tree's last RecentTurns finished replies are all
	// this branch's.
	RecentInBranch bool `json:"recentInBranch"`
}

// RebalanceDue reports whether a branch should be suggested for promotion
// or spinoff, and why.
func RebalanceDue(s RebalanceSignals, l RebalanceLimits) (string, bool) {
	l = l.orDefault()
	if s.BranchTurns >= l.MinBranchTurns && s.BranchTurns >= l.ShareFactor*s.ParentTurns {
		return RebalanceReasonShare, true
	}
	if s.RecentInBranch && s.BranchTurns >= l.RecentTurns {
		return RebalanceReasonRecent, true
	}
	return "", false
}

// SuggestionTargetBranch is the target key of a suggestion about a branch.
func SuggestionTargetBranch(lineID string) string { return "branch:" + lineID }
