package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// fisheyePinnedMax bounds the pinned messages one prompt reads beyond the
// history it scans.
const fisheyePinnedMax = 50

// Fisheye replaces the default history of a prompt with a fisheye view
// (DESIGN §12 B9): every message of the line and every other branch of the
// tree gets a score (its head start minus its distance) and a level: full,
// summary (one condensed line, or covered by the rolling summary),
// leaf_only (another branch's leaf in the "other branches' conclusions"
// block) or hidden, within what the shared budget left for the history.
// Head starts: a pin, a reference from a note or a card, being a card, a
// confirmed decision tag (while ibis is on); for
// branches, the leaf's kind. The line's own path (it and its ancestors) is
// carried by its pack, not by this. PreviewTurn reports every item. No
// model, on or off; needs leaf. Off: the default history.
func Fisheye() Feature {
	return &module{name: FeatureFisheye, configured: ModeAuto, requires: []string{FeatureLeaf}, attach: registerFisheye}
}

func registerFisheye(r *registry, _ *module) { r.setHistorySelector(fisheyeHistory) }

// FisheyeReport is what the fisheye chose for a prompt: every item with its
// level and score, the tokens they take and the history budget they had.
type FisheyeReport struct {
	Items  []domain.FisheyeItem `json:"items"`
	Tokens int                  `json:"tokens"`
	Budget int                  `json:"budget"`
}

// fisheyeHistory is the fisheye's HistorySelector.
func fisheyeHistory(ctx context.Context, e *Engine, _ Mode, pc *promptContext) error {
	history, err := e.fisheyeMessages(ctx, pc)
	if err != nil {
		return err
	}
	if e.cooperates(pc.modes, capIbisFisheye) {
		if err := e.store.AttachTags(ctx, history); err != nil {
			return err
		}
	}
	tree, err := e.store.FisheyeTree(ctx, pc.scope.Tenant, pc.line.ID)
	if err != nil {
		return err
	}
	referenced, err := e.fisheyeReferences(ctx, pc, tree.RootLineID, history)
	if err != nil {
		return err
	}
	branches := fisheyeBranches(tree.Branches, tree.RootLineID, pc.line.ID)
	if e.cooperates(pc.modes, capGroupFisheye) {
		if branches, err = e.withGroups(ctx, tree.RootLineID, branches); err != nil {
			return err
		}
	}
	in := domain.FisheyeInput{
		Messages: history, Referenced: referenced, Branches: branches,
		TokenBudget: pc.historyBudget, MessageTokenCap: e.limits.History.MessageTokenCap, Limits: e.limits,
	}
	if pc.in.Summary.HasContent() {
		in.SummaryUptoSeq = pc.in.SummaryUptoSeq
	}
	sel := domain.SelectFisheye(in)
	pc.in.Selection = &domain.HistorySelection{Full: sel.Full, Condensed: sel.Condensed}
	pc.in.BranchConclusions = domain.BuildBranchConclusions(sel.Conclusions, e.markers)
	pc.fisheye = &FisheyeReport{Items: sel.Items, Tokens: sel.Tokens, Budget: pc.historyBudget}
	return nil
}

// fisheyeMessages is the line's history before the turn (the newest
// HistoryScan messages) and its pinned messages older than that, as the
// history rewriters (folds) left them.
func (e *Engine) fisheyeMessages(ctx context.Context, pc *promptContext) ([]domain.Message, error) {
	limit, pendingID, userID := e.limits.HistoryScan, "", ""
	if pc.begun != nil {
		limit, pendingID, userID = limit+historyMargin, pc.begun.pendingID, pc.begun.userID
	}
	recent, err := e.store.RecentMessages(ctx, pc.scope.Tenant, pc.line.ID, limit)
	if err != nil {
		return nil, err
	}
	pinned, err := e.store.PinnedMessages(ctx, pc.scope.Tenant, pc.line.ID, fisheyePinnedMax)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(recent))
	for _, message := range recent {
		seen[message.ID] = true
	}
	for _, message := range pinned {
		if !seen[message.ID] {
			recent = append(recent, message)
		}
	}
	return e.rewriteHistory(ctx, pc, domain.HistoryBeforeTurn(recent, pendingID, userID))
}

// fisheyeReferences are the messages the cards in the history and, while
// notes is on, the active notes point at.
func (e *Engine) fisheyeReferences(ctx context.Context, pc *promptContext, rootID string, history []domain.Message) (map[string]bool, error) {
	referenced := map[string]bool{}
	for _, message := range history {
		if message.Meta.Card != nil {
			for _, evidence := range message.Meta.Card.Evidence {
				referenced[evidence.MessageID] = true
			}
		}
	}
	if pc.modes.of(FeatureNotes) == ModeOff {
		return referenced, nil
	}
	notes, err := e.store.ActiveNotes(ctx, rootID)
	if err != nil {
		return nil, err
	}
	for _, note := range notes {
		if note.SourceMessageID != "" {
			referenced[note.SourceMessageID] = true
		}
	}
	return referenced, nil
}

// fisheyeBranches are the tree's branches as the fisheye weighs them from
// the current line: every branch off its path (it and its ancestors), with
// its distance in edges and its leaf (or its card's conclusion line).
func fisheyeBranches(branches []store.FisheyeTreeBranch, rootID, currentID string) []domain.FisheyeBranch {
	parent := map[string]string{}
	neighbours := map[string][]string{}
	for _, b := range branches {
		parent[b.LineID] = b.ParentLineID
		neighbours[b.LineID] = append(neighbours[b.LineID], b.ParentLineID)
		neighbours[b.ParentLineID] = append(neighbours[b.ParentLineID], b.LineID)
	}
	onPath := map[string]bool{rootID: true}
	for id := currentID; id != "" && !onPath[id]; id = parent[id] {
		onPath[id] = true
	}
	distance := treeDistances(neighbours, currentID)
	out := make([]domain.FisheyeBranch, 0, len(branches))
	for _, b := range branches {
		d, reached := distance[b.LineID]
		if onPath[b.LineID] || !reached {
			continue
		}
		kind, line := b.LeafKind, b.LeafLine
		if line == "" {
			kind, line = "", b.ConclusionLine
		}
		out = append(out, domain.FisheyeBranch{LineID: b.LineID, Purpose: b.Purpose, LeafKind: kind, Line: line, Distance: d})
	}
	return out
}

// treeDistances is every line's distance in edges from start (breadth
// first over the tree's parent links).
func treeDistances(neighbours map[string][]string, start string) map[string]int {
	distance := map[string]int{start: 0}
	queue := []string{start}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, next := range neighbours[id] {
			if _, seen := distance[next]; !seen {
				distance[next] = distance[id] + 1
				queue = append(queue, next)
			}
		}
	}
	return distance
}

// withGroups replaces the members of the tree's ready groups by one item
// per group: its summary, at the distance of its closest member (members
// on the line's own path are not items, so a group of only those is not
// either).
func (e *Engine) withGroups(ctx context.Context, rootID string, branches []domain.FisheyeBranch) ([]domain.FisheyeBranch, error) {
	groups, err := e.store.ReadyGroups(ctx, rootID)
	if err != nil || len(groups) == 0 {
		return branches, err
	}
	byLine := make(map[string]domain.FisheyeBranch, len(branches))
	for _, b := range branches {
		byLine[b.LineID] = b
	}
	taken := map[string]bool{}
	out := []domain.FisheyeBranch{}
	for _, g := range groups {
		closest := -1
		for _, id := range g.MemberLineIDs {
			taken[id] = true
			if b, ok := byLine[id]; ok && (closest < 0 || b.Distance < closest) {
				closest = b.Distance
			}
		}
		if closest >= 0 {
			out = append(out, domain.FisheyeBranch{LineID: g.ID, Purpose: g.Title, LeafKind: domain.FisheyeGroupKind, Line: g.Summary, Distance: closest})
		}
	}
	for _, b := range branches {
		if !taken[b.LineID] {
			out = append(out, b)
		}
	}
	return out, nil
}
