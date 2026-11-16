// Package httpstream is what the HTTP runners share: a Server-Sent Events
// reader, the retry loop for 429 / 5xx answers and the mapping of provider
// failures to texts an operator may see.
package httpstream

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"strings"
)

// DefaultMaxLine bounds one SSE line (a streamed chunk of JSON).
const DefaultMaxLine = 1 << 20

// ErrLineTooLong refuses a stream line longer than the reader's bound.
var ErrLineTooLong = errors.New("httpstream: an event stream line is too long")

// SSEEvent is one dispatched event: its name ("" when the stream named
// none) and its data lines joined with "\n".
type SSEEvent struct {
	Name string
	Data string
}

// SSEReader parses text/event-stream incrementally. Comments, id and retry
// fields are ignored; an event without data is skipped.
type SSEReader struct {
	r       *bufio.Reader
	maxLine int
}

// NewSSEReader reads events from r; maxLine <= 0 means DefaultMaxLine.
func NewSSEReader(r io.Reader, maxLine int) *SSEReader {
	if maxLine <= 0 {
		maxLine = DefaultMaxLine
	}
	return &SSEReader{r: bufio.NewReaderSize(r, 64<<10), maxLine: maxLine}
}

// Next returns the next event; io.EOF when the stream ended (an event that
// was not terminated by a blank line is still returned first).
func (s *SSEReader) Next() (SSEEvent, error) {
	var name string
	var data []string
	for {
		line, err := s.line()
		if err != nil && !(errors.Is(err, io.EOF) && line != "") {
			if errors.Is(err, io.EOF) && len(data) > 0 {
				return SSEEvent{Name: name, Data: strings.Join(data, "\n")}, nil
			}
			return SSEEvent{}, err
		}
		if line == "" {
			if len(data) > 0 {
				return SSEEvent{Name: name, Data: strings.Join(data, "\n")}, nil
			}
			name = ""
			continue
		}
		field, value := splitField(line)
		switch field {
		case "event":
			name = value
		case "data":
			data = append(data, value)
		}
	}
}

// line reads one line without its terminator (LF, CRLF or a lone CR before
// LF), bounded by maxLine.
func (s *SSEReader) line() (string, error) {
	var buf bytes.Buffer
	for {
		chunk, isPrefix, err := s.r.ReadLine()
		buf.Write(chunk)
		if buf.Len() > s.maxLine {
			return "", ErrLineTooLong
		}
		if err != nil {
			return buf.String(), err
		}
		if !isPrefix {
			return strings.TrimSuffix(buf.String(), "\r"), nil
		}
	}
}

// splitField splits "field: value"; a line starting with ":" is a comment.
func splitField(line string) (string, string) {
	if strings.HasPrefix(line, ":") {
		return "", ""
	}
	field, value, found := strings.Cut(line, ":")
	if !found {
		return line, ""
	}
	return field, strings.TrimPrefix(value, " ")
}
