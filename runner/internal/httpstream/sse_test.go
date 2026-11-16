package httpstream

import (
	"errors"
	"io"
	"strings"
	"testing"
)

func TestSSE_ReadsEventsAcrossLineEndingsAndComments(t *testing.T) {
	input := ": hello\r\n" +
		"event: message_start\r\n" +
		"data: {\"a\":1}\r\n\r\n" +
		"data: first\n" +
		"data: second\n\n" +
		"id: 7\nretry: 100\nunknown: x\ndata:no-space\n\n" +
		"event: tail\ndata: unterminated"
	r := NewSSEReader(strings.NewReader(input), 0)
	want := []SSEEvent{
		{Name: "message_start", Data: `{"a":1}`},
		{Name: "", Data: "first\nsecond"},
		{Name: "", Data: "no-space"},
		{Name: "tail", Data: "unterminated"},
	}
	for i, w := range want {
		got, err := r.Next()
		if err != nil {
			t.Fatalf("event %d: %v", i, err)
		}
		if got != w {
			t.Fatalf("event %d = %+v, want %+v", i, got, w)
		}
	}
	if _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("end = %v, want EOF", err)
	}
}

func TestSSE_SkipsEventsWithoutDataAndRefusesHugeLines(t *testing.T) {
	r := NewSSEReader(strings.NewReader("event: ping\n\ndata: ok\n\n"), 0)
	if got, err := r.Next(); err != nil || got.Data != "ok" {
		t.Fatalf("got %+v %v", got, err)
	}
	long := "data: " + strings.Repeat("x", 100) + "\n\n"
	r = NewSSEReader(strings.NewReader(long), 32)
	if _, err := r.Next(); !errors.Is(err, ErrLineTooLong) {
		t.Fatalf("err = %v, want ErrLineTooLong", err)
	}
}
