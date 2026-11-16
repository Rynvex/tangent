package domain

import (
	"strings"
	"time"
	"unicode/utf8"
)

// Memos: notes on a node that never go to the AI (the memo feature, B13).
// Unlike the notes page they are not sent with any turn, not shown in a
// turn's preview and not read by any job. They are not private: everyone
// who can read the conversation reads its memos.

// Errors of memos.
var (
	// ErrMemoNotFound: no such memo for this tenant.
	ErrMemoNotFound = NewError(CodeMemoNotFound, "memo not found", nil)
	// ErrMemoLimit: the conversation holds as many memos as it may.
	ErrMemoLimit = NewError(CodeMemoLimit, "this conversation has reached its limit of memos", nil)
)

// Memo is one memo, written on a node (a line) of a conversation.
type Memo struct {
	ID         string `json:"id"`
	RootLineID string `json:"rootLineId"`
	// LineID is the node it was written on; "" once that line is gone
	// (the memo stays, named by SourceLabel).
	LineID string `json:"lineId"`
	// SourceLabel is the node's name when the memo was written (the notes'
	// rules: "主線", "查證・purpose"…); a snapshot that a rename leaves alone.
	SourceLabel string    `json:"sourceLabel"`
	Text        string    `json:"text"`
	CreatedBy   string    `json:"createdBy"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// NormalizeMemoText trims a memo's text and checks it: not empty, within
// the limit. Line breaks are kept (a memo may be several lines); Windows
// line ends become "\n".
func NormalizeMemoText(text string, l MemoLimits) (string, error) {
	l = l.orDefault()
	clean := strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
	if clean == "" {
		return "", NewError(CodeInvalidInput, "a memo must not be empty", nil)
	}
	if utf8.RuneCountInString(clean) > l.TextMaxRunes {
		return "", CheckRunes("text", clean, l.TextMaxRunes)
	}
	return clean, nil
}
