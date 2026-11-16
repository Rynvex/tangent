package cli

import (
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// fallbackSystem replaces an empty system prompt: a CLI given none would
// fall back to its own coding-agent prompt.
const fallbackSystem = "You are a helpful assistant in a conversation with an operator. Answer the operator's message."

// systemText is the request's system prompt (or the fallback).
func systemText(req tangent.RunRequest) string {
	if text := strings.TrimSpace(req.System); text != "" {
		return text
	}
	return fallbackSystem
}

// transcript renders the chat as one text, the way domain.Prompt.Text lays
// a conversation out for CLI agents: a single message as it is; otherwise
// the earlier messages under "## Conversation so far" (operator: / agent:)
// and the last one under "## Operator's message".
func transcript(messages []domain.ChatMessage) string {
	switch len(messages) {
	case 0:
		return ""
	case 1:
		return strings.TrimSpace(messages[0].Content) + "\n"
	}
	var b strings.Builder
	b.WriteString("## Conversation so far\n\n")
	for _, m := range messages[:len(messages)-1] {
		b.WriteString(speaker(m.Role) + ": " + m.Content + "\n\n")
	}
	b.WriteString("## Operator's message\n\n" + strings.TrimSpace(messages[len(messages)-1].Content) + "\n")
	return b.String()
}

func speaker(role string) string {
	if role == domain.ChatRoleAssistant {
		return "agent"
	}
	return "operator"
}

// singleText is the whole prompt as one text, for a CLI that takes no
// separate system prompt: the system part, then the conversation.
func singleText(req tangent.RunRequest) string {
	return systemText(req) + "\n\n" + transcript(req.Messages)
}
