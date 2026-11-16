package main

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/Rynvex/tangent/domain"
)

// The import-convert mode turns a ChatGPT or Claude export into draft
// samples for the evaluation set: one file per conversation, one unit per
// user message with the replies after it, and a gold of one node per unit
// (no roles) that the labeller then merges and roles by hand.

// exportedConversation is one conversation of either export: ChatGPT's
// tree of mapping nodes, or Claude's flat chat_messages.
type exportedConversation struct {
	Title        string                     `json:"title"`
	Name         string                     `json:"name"`
	CurrentNode  string                     `json:"current_node"`
	Mapping      map[string]exportedMapNode `json:"mapping"`
	ChatMessages []exportedChatMessage      `json:"chat_messages"`
}

type exportedMapNode struct {
	Parent   string           `json:"parent"`
	Children []string         `json:"children"`
	Message  *exportedMessage `json:"message"`
}

type exportedMessage struct {
	Author struct {
		Role string `json:"role"`
	} `json:"author"`
	Content struct {
		Parts []any `json:"parts"`
	} `json:"content"`
}

type exportedChatMessage struct {
	Sender  string `json:"sender"`
	Text    string `json:"text"`
	Content []struct {
		Text string `json:"text"`
	} `json:"content"`
}

// exchange is one message of a conversation as a role and its text.
type exchange struct{ role, text string }

// readExport reads an export file: a list of conversations, or one.
func readExport(path string) ([]exportedConversation, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if bytes.HasPrefix(bytes.TrimSpace(raw), []byte("[")) {
		var list []exportedConversation
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, fmt.Errorf("%s: not a ChatGPT or Claude export: %w", path, err)
		}
		return list, nil
	}
	var one exportedConversation
	if err := json.Unmarshal(raw, &one); err != nil {
		return nil, fmt.Errorf("%s: not a ChatGPT or Claude export: %w", path, err)
	}
	return []exportedConversation{one}, nil
}

// title is the conversation's title (ChatGPT) or name (Claude).
func (c exportedConversation) title() string { return cmp.Or(c.Title, c.Name) }

// messages are the conversation's messages in order: ChatGPT's current
// branch (from current_node up to the root; without a known current_node,
// the branch of last children down from the root), or Claude's list.
func (c exportedConversation) messages() []exchange {
	if len(c.Mapping) > 0 {
		return c.mappingMessages()
	}
	out := []exchange{}
	for _, m := range c.ChatMessages {
		text := m.Text
		if strings.TrimSpace(text) == "" {
			parts := []string{}
			for _, part := range m.Content {
				parts = append(parts, part.Text)
			}
			text = strings.Join(parts, "\n")
		}
		role := map[string]string{"human": "user", "assistant": "assistant"}[m.Sender]
		if role != "" && strings.TrimSpace(text) != "" {
			out = append(out, exchange{role: role, text: text})
		}
	}
	return out
}

func (c exportedConversation) mappingMessages() []exchange {
	id := c.CurrentNode
	if _, ok := c.Mapping[id]; !ok {
		id = c.lastLeaf()
	}
	chain := []exchange{}
	for seen := map[string]bool{}; id != "" && !seen[id]; {
		seen[id] = true
		node, ok := c.Mapping[id]
		if !ok {
			break
		}
		if node.Message != nil {
			parts := []string{}
			for _, part := range node.Message.Content.Parts {
				if s, ok := part.(string); ok && strings.TrimSpace(s) != "" {
					parts = append(parts, s)
				}
			}
			role := node.Message.Author.Role
			if (role == "user" || role == "assistant") && len(parts) > 0 {
				chain = append(chain, exchange{role: role, text: strings.Join(parts, "\n")})
			}
		}
		id = node.Parent
	}
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}
	return chain
}

// lastLeaf is the leaf reached from the root by always taking the last
// child (ChatGPT keeps the current branch last); "" without a root.
func (c exportedConversation) lastLeaf() string {
	root := ""
	for key, node := range c.Mapping {
		if _, hasParent := c.Mapping[node.Parent]; !hasParent && (root == "" || key < root) {
			root = key
		}
	}
	id := root
	for seen := map[string]bool{}; id != "" && !seen[id]; {
		seen[id] = true
		children := c.Mapping[id].Children
		if len(children) == 0 {
			return id
		}
		id = children[len(children)-1]
	}
	return ""
}

// draftSample is the conversation as a sample: one unit per user message
// with the replies after it joined, one gold node per unit.
func draftSample(name, source string, c exportedConversation) domain.ImportAnalyzeEvalSample {
	units := []domain.ImportAnalyzeUnit{}
	for _, m := range c.messages() {
		if m.role == "user" || len(units) == 0 {
			if m.role != "user" {
				continue
			}
			units = append(units, domain.ImportAnalyzeUnit{Key: fmt.Sprintf("u%d", len(units)+1), Question: m.text, MessageCount: 1})
			continue
		}
		last := &units[len(units)-1]
		last.Answer = strings.TrimSpace(last.Answer + "\n" + m.text)
		last.MessageCount++
	}
	gold := make([]domain.ImportAnalyzeGoldNode, 0, len(units))
	for _, unit := range units {
		gold = append(gold, domain.ImportAnalyzeGoldNode{UnitKeys: []string{unit.Key}})
	}
	return domain.ImportAnalyzeEvalSample{Name: name, Source: source, Draft: true, Title: c.title(), Units: units, Gold: gold}
}

// sampleFileName is "<n>-<ascii words of the title>.json".
func sampleFileName(n int, title string) string {
	words := strings.FieldsFunc(strings.ToLower(title), func(r rune) bool { return !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9') })
	slug := strings.Join(words, "-")
	if len(slug) > 40 {
		slug = slug[:40]
	}
	if slug = strings.Trim(slug, "-"); slug == "" {
		return fmt.Sprintf("%02d.json", n)
	}
	return fmt.Sprintf("%02d-%s.json", n, slug)
}

// convertExport writes one draft sample per conversation of the export
// into dir and reports what it wrote; conversations without any user
// message are skipped, and a file already there is left alone (it may hold
// a labelled gold).
func convertExport(exportPath, dir string, stdout io.Writer) error {
	conversations, err := readExport(exportPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	written := 0
	for i, c := range conversations {
		file := sampleFileName(i+1, c.title())
		sample := draftSample(strings.TrimSuffix(file, ".json"), filepath.Base(exportPath)+" "+c.title(), c)
		if len(sample.Units) == 0 {
			fmt.Fprintf(stdout, "skipped %q: no user message\n", c.title())
			continue
		}
		raw, err := json.MarshalIndent(sample, "", " ")
		if err != nil {
			return err
		}
		path := filepath.Join(dir, file)
		err = writeNew(path, append(raw, '\n'))
		switch {
		case errors.Is(err, fs.ErrExist):
			fmt.Fprintf(stdout, "kept %s: it exists\n", path)
			continue
		case err != nil:
			return err
		}
		fmt.Fprintf(stdout, "wrote %s (%d units) from %q: merge its gold nodes, set their roles and remove \"draft\"\n", path, len(sample.Units), sample.Title)
		written++
	}
	if written == 0 {
		return fmt.Errorf("%s: no conversation with a user message", exportPath)
	}
	return nil
}

// writeNew writes a file that does not exist yet (fs.ErrExist otherwise).
func writeNew(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// runImportConvert is the import-convert mode.
func runImportConvert(o options, stdout io.Writer) int {
	if o.exportPath == "" || o.convertDir == "" {
		fmt.Fprintln(stdout, "tangent-eval: -mode import-convert needs -export <file> and -out-dir <dir>")
		return 2
	}
	if err := convertExport(o.exportPath, o.convertDir, stdout); err != nil {
		fmt.Fprintln(stdout, "tangent-eval:", err)
		return 2
	}
	return 0
}
