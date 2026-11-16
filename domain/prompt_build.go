package domain

import (
	"fmt"
	"strings"
)

const (
	// historyLineLimit caps each condensed line of older history.
	historyLineLimit = 120
	// historySummaryLimit caps the whole condensed-history paragraph.
	historySummaryLimit = 2000
	// historyRoleOverheadTokens approximates the "operator: " prefix per line.
	historyRoleOverheadTokens = 4
)

// PromptInput is everything the prompt builder needs.
type PromptInput struct {
	// Instructions, AgentName and Role describe the assistant; all optional.
	Instructions string
	AgentName    string
	Role         string
	// History is the line's messages before this turn (HistoryBeforeTurn);
	// it is ordered by seq here.
	History     []Message
	UserMessage string
	// Branch is set for a branch line: its purpose and stored pack.
	Branch *BranchPromptInfo
	// Goal is the conversation's goal ("" without one), rendered after the
	// rules.
	Goal string
	// OriginCapsule is a spun-off main line's capsule text (fixed once the
	// line exists).
	OriginCapsule string
	// Cards are the confirmed conclusion cards no turn has carried yet; they
	// open both the full and the resume prompt.
	Cards []BranchCardNoticeItem
	// NotesBlock is the rendered conversation notes ("" when none are active).
	// A resume prompt carries it only when NotesChanged.
	NotesBlock   string
	NotesChanged bool
	// Summary stands for every message up to SummaryUptoSeq; those leave the
	// history. A summary without a cursor is not used.
	Summary        Summary
	SummaryUptoSeq int64
	// Selection, when set, is a history selector's choice (the fisheye):
	// Full verbatim and Condensed as the condensed paragraph, in place of the
	// budget split of History; the rolling summary still stands for what it
	// covers (the selector left those messages out).
	Selection *HistorySelection
	// BranchConclusions is the fisheye's rendered block of other branches'
	// leaves ("" without one).
	BranchConclusions string
	// MemoryBlock is the recalled memories' block (the memory feature; ""
	// without one).
	MemoryBlock string
	// GlossaryBlock is the glossary's block of terms (the glossary feature;
	// "" without one).
	GlossaryBlock string
	// HostSections are the host's blocks, placed after the built-in rules. A
	// host key that collides with a built-in one is renamed "host:<key>".
	HostSections []PromptSection
	// ExtraMarkers are host protocol markers removed from every
	// library-rendered block (cards, rules, notes, pack, summary, condensed
	// history). Host sections and verbatim history are left as they are.
	ExtraMarkers []string
	// Limits bounds the history; zero means DefaultLimits().History.
	Limits HistoryLimits
	// OmitBranchSuggestRules leaves the [BRANCH-SUGGEST] rule out of the
	// rules (the host does not parse suggestions).
	OmitBranchSuggestRules bool
	// RequestTopicSummary asks for a [TOPIC] line (the line's first turn,
	// WantsTopicSummary); AllowChapterCut allows a [CHAPTER] line (the
	// chapters feature, main line only). Their rules form the trailing
	// SectionReplyLines, not the stable rules.
	RequestTopicSummary bool
	AllowChapterCut     bool
}

// HistorySelection is the history a selector chose: the verbatim messages
// and the ones condensed to a line each, both oldest first.
type HistorySelection struct {
	Full      []Message
	Condensed []Message
}

// BranchPromptInfo is what a branch line adds to its prompt.
type BranchPromptInfo struct {
	// Purpose is the branch's stated purpose (untrusted operator text).
	Purpose string
	// Pack is the stored pack text, exactly as shown to the operator.
	Pack string
	// Aside marks a one-question branch.
	Aside bool
	// Kind is the branch's kind (BranchKindInvestigate, BranchKindAlternative
	// or BranchKindAside); it adds that kind's rule. "" keeps the general
	// branch rules only.
	Kind string
	// SuggestBranches opts a branch into the [BRANCH-SUGGEST] rule. By default
	// only the main line carries it: inside a branch it costs tokens on every
	// turn and invites side lines of side lines. An aside never carries it.
	SuggestBranches bool
}

// isAside reports whether the branch is a one-question aside.
func (b *BranchPromptInfo) isAside() bool {
	return b.Aside || b.Kind == BranchKindAside
}

// BuildPrompt assembles the structured turn prompt.
func BuildPrompt(in PromptInput) Prompt {
	limits := in.Limits.orDefault()
	markers := hostMarkers(in.ExtraMarkers)
	prompt := Prompt{Sections: promptSections(in, markers), UserMessage: in.UserMessage, NotesChanged: in.NotesChanged, History: []ChatMessage{}}
	history := SortBySeq(in.History)
	if in.Summary.HasContent() && in.SummaryUptoSeq > 0 {
		summary := NormalizeSummary(CleanSummary(in.Summary, markers...))
		prompt.Summary = &summary
		history = messagesAfterSeq(history, in.SummaryUptoSeq)
	}
	earlier, entries := buildHistory(history, limits)
	if in.Selection != nil {
		earlier, entries = selectedHistory(*in.Selection, limits)
	}
	prompt.Earlier, prompt.History = StripMarkers(earlier, markers), entries
	return prompt
}

// selectedHistory renders a selector's choice: the condensed paragraph and
// the verbatim entries (each capped like any history message).
func selectedHistory(sel HistorySelection, limits HistoryLimits) (string, []ChatMessage) {
	earlier := ""
	if len(sel.Condensed) > 0 {
		earlier = condenseHistory(SortBySeq(sel.Condensed), 0)
	}
	entries := []ChatMessage{}
	for _, message := range SortBySeq(sel.Full) {
		if message.Status == MessageDone && historyShowsMessage(message) {
			entries = append(entries, historyEntry(message, limits.MessageTokenCap))
		}
	}
	return earlier, entries
}

// EstimateInputTokens estimates the blocks of a prompt input that vary with
// the conversation (pack, capsule, card notice, notes, goal, summary, host
// sections, branch conclusions); the history, the rules and the operator's
// message are not counted. The engine's shared budget measures each
// feature's share with it.
func EstimateInputTokens(in PromptInput) int {
	total := EstimateTokens(in.OriginCapsule) + EstimateTokens(in.NotesBlock) + EstimateTokens(BuildGoalBlock(in.Goal)) +
		EstimateTokens(in.BranchConclusions) + EstimateTokens(in.MemoryBlock) + EstimateTokens(in.GlossaryBlock) + EstimateTokens(BuildBranchCardNotice(in.Cards))
	if in.Branch != nil {
		total += EstimateTokens(in.Branch.Pack)
	}
	if in.Summary.HasContent() && in.SummaryUptoSeq > 0 {
		total += EstimateTokens(renderPromptSummary(NormalizeSummary(in.Summary)))
	}
	for _, section := range in.HostSections {
		total += EstimateTokens(renderSection(section))
	}
	return total
}

// builtInSectionKeys are the keys BuildPrompt reserves.
var builtInSectionKeys = map[string]bool{
	SectionBranchCards: true, SectionInstructions: true, SectionRules: true, SectionNotes: true, SectionBranchPack: true,
	SectionOriginCapsule: true, SectionGoal: true, SectionBranchConclusions: true, SectionMemory: true,
	SectionGlossary: true, SectionReplyLines: true,
}

// promptSections lists the built-in sections and the host's, in order. The
// host's extra markers are removed from the built-in ones.
func promptSections(in PromptInput, markers []string) []PromptSection {
	sections := []PromptSection{}
	builtIn := func(key, body string) {
		sections = append(sections, PromptSection{Key: key, Body: StripMarkers(body, markers)})
	}
	if notice := BuildBranchCardNotice(in.Cards); notice != "" {
		builtIn(SectionBranchCards, notice)
	}
	if instructions := strings.TrimSpace(in.Instructions); instructions != "" {
		sections = append(sections, PromptSection{Key: SectionInstructions, Body: "Agent instructions:\n" + instructions})
	}
	builtIn(SectionRules, promptRules(in))
	if goal := BuildGoalBlock(in.Goal); goal != "" {
		builtIn(SectionGoal, goal)
	}
	for _, section := range in.HostSections {
		if builtInSectionKeys[section.Key] {
			section.Key = "host:" + section.Key
		}
		sections = append(sections, section)
	}
	if in.NotesBlock != "" {
		builtIn(SectionNotes, in.NotesBlock)
	}
	if in.Branch != nil {
		builtIn(SectionBranchPack, in.Branch.Pack)
	}
	if strings.TrimSpace(in.OriginCapsule) != "" {
		builtIn(SectionOriginCapsule, in.OriginCapsule)
	}
	if strings.TrimSpace(in.BranchConclusions) != "" {
		builtIn(SectionBranchConclusions, in.BranchConclusions)
	}
	if strings.TrimSpace(in.MemoryBlock) != "" {
		sections = append(sections, PromptSection{Key: SectionMemory, Body: in.MemoryBlock})
	}
	if strings.TrimSpace(in.GlossaryBlock) != "" {
		sections = append(sections, PromptSection{Key: SectionGlossary, Body: in.GlossaryBlock})
	}
	if block := BuildReplyLinesBlock(in); block != "" {
		builtIn(SectionReplyLines, block)
	}
	return sections
}

// promptRules is the standing rule set of a conversation.
func promptRules(in PromptInput) string {
	who := strings.TrimSpace(in.AgentName)
	if who == "" {
		who = "the agent"
	}
	role := strings.TrimSpace(in.Role)
	if role != "" {
		role = " (role: " + role + ")"
	}
	rules := "You are " + who + role + " in an interactive conversation with an operator. Rules:\n" +
		"- Be concise and concrete; answer the operator's question first.\n"
	if in.Branch != nil {
		rules += branchRules(in.Branch)
	}
	if !in.OmitBranchSuggestRules && (in.Branch == nil || (in.Branch.SuggestBranches && !in.Branch.isAside())) {
		rules += BranchSuggestRules
	}
	return rules
}

// branchKindRules is the one extra rule of each kind of (non-aside) branch.
var branchKindRules = map[string]string{
	BranchKindInvestigate: "- This branch investigates one question: verify it, and keep what the background or evidence confirms apart from " +
		"unconfirmed guesses. End each reply with one or two sentences to bring back to the main line.\n",
	BranchKindAlternative: "- This branch explores an alternative to the approach at the branch point: compare the assumptions behind each, " +
		"the main differences, pros and cons and when to choose which. Do not restate background the main line has already settled.\n",
}

// branchRules tells a branch's model where it is. The purpose is operator
// text, so it is flattened to one line and stripped of protocol markers.
func branchRules(branch *BranchPromptInfo) string {
	if branch.isAside() {
		return "- This is a quick aside: the operator asks one question and you answer it once. Keep the answer short and self-contained; do not ask follow-up questions and do not suggest side lines. " +
			"The purpose of this aside is: " + branchLine(branch.Purpose) + "\n"
	}
	return "- You are in a side branch of the operator's main conversation; the branch background below is a snapshot of it. " +
		"The purpose of this branch is: " + branchLine(branch.Purpose) + "\n" +
		"- Stay on that purpose.\n" +
		"- Keep conclusions short and cite main-line message ids when you rely on them. The main line may have moved on since the snapshot.\n" +
		branchKindRules[branch.Kind]
}

// buildHistory keeps the recent finished messages that fit the token budget
// verbatim and condenses everything older into one paragraph from the newest
// backwards. Pending placeholders, failed replies and undelivered cards are
// not part of the window.
func buildHistory(history []Message, limits HistoryLimits) (string, []ChatMessage) {
	finished := make([]Message, 0, len(history))
	for _, message := range history {
		if message.Status == MessageDone && historyShowsMessage(message) {
			finished = append(finished, message)
		}
	}
	entries := []ChatMessage{}
	if len(finished) == 0 {
		return "", entries
	}
	start, recent := splitHistory(finished, limits.TokenBudget)
	earlier := ""
	if start > 0 {
		earlier = summarizeOlderHistory(finished[:start])
	}
	for _, message := range recent {
		entries = append(entries, historyEntry(message, limits.MessageTokenCap))
	}
	return earlier, entries
}

// splitHistory takes finished messages from the newest backwards until the
// next one would push the estimate over budget; the newest message is always
// kept. It returns the cut index and the recent tail.
func splitHistory(finished []Message, budget int) (int, []Message) {
	start := len(finished)
	total := 0
	have := false
	for i := len(finished) - 1; i >= 0; i-- {
		cost := EstimateTokens(finished[i].Content) + historyRoleOverheadTokens
		if have && total+cost > budget {
			break
		}
		total += cost
		start = i
		have = true
	}
	return start, finished[start:]
}

// historyEntry renders one verbatim message, truncating (and annotating) a
// message that exceeds tokenCap tokens. A delivered card is re-rendered with
// its fixed framing; any other system message carries its "system: " label.
func historyEntry(message Message, tokenCap int) ChatMessage {
	if message.IsCard() {
		return ChatMessage{Role: ChatRoleSystem, Content: renderHistoryBranchCard(message)}
	}
	if message.IsFold() {
		return ChatMessage{Role: ChatRoleSystem, Content: renderFoldEntry(message)}
	}
	content := strings.TrimSpace(message.Content)
	if EstimateTokens(content) > tokenCap {
		runes := []rune(content)
		if maxRunes := tokenCap * 4; len(runes) > maxRunes {
			content = string(runes[:maxRunes])
		}
		content += fmt.Sprintf(" … [truncated; full text is message %s]", message.ID)
	}
	switch message.Role {
	case RoleUser:
		return ChatMessage{Role: ChatRoleUser, Content: content}
	case RoleAssistant:
		return ChatMessage{Role: ChatRoleAssistant, Content: content}
	default:
		return ChatMessage{Role: ChatRoleSystem, Content: roleLabel(message.Role) + ": " + content}
	}
}

// summarizeOlderHistory condenses older messages into one bounded paragraph,
// filling from the newer end so the most relevant history is kept; the still
// omitted count is named in the header.
func summarizeOlderHistory(older []Message) string {
	return condenseHistory(older, historySummaryLimit)
}

// condenseHistory is summarizeOlderHistory with a cap of limit runes (0: no
// cap, for a selector whose budget already bounds the lines).
func condenseHistory(older []Message, limit int) string {
	lines := make([]string, 0, len(older))
	total := 0
	omitted := 0
	for i := len(older) - 1; i >= 0; i-- {
		line := condensedHistoryLine(older[i])
		if limit > 0 && len(lines) > 0 && total+len([]rune(line)) > limit {
			omitted = i + 1
			break
		}
		lines = append(lines, line)
		total += len([]rune(line))
	}
	for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
		lines[i], lines[j] = lines[j], lines[i]
	}
	header := fmt.Sprintf("Earlier in this session (%d messages, condensed):", len(older))
	if omitted > 0 {
		header = fmt.Sprintf("Earlier in this session (%d messages, %d omitted, condensed):", len(older), omitted)
	}
	return header + strings.Join(lines, "")
}
