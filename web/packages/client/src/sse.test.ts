import { describe, expect, it } from "vitest";
import { createSseParser, type SseMessage } from "./sse";

function parse(chunks: readonly string[]): SseMessage[] {
  const messages: SseMessage[] = [];
  const parser = createSseParser((message) => messages.push(message));
  for (const chunk of chunks) parser.push(chunk);
  return messages;
}

describe("createSseParser", () => {
  it("dispatches on a blank line, joining data lines and defaulting the event name", () => {
    expect(parse(["data: a\ndata: b\n\n", "event: x\ndata:c\n\n"])).toEqual([
      { event: "message", data: "a\nb", id: "" },
      { event: "x", data: "c", id: "" },
    ]);
  });

  it("accepts LF, CR and CRLF line ends, even split across chunks", () => {
    expect(parse(["data: 1\r", "\n\r", "\ndata: 2\r\r", "data: 3\n", "\n"])).toEqual([
      { event: "message", data: "1", id: "" },
      { event: "message", data: "2", id: "" },
      { event: "message", data: "3", id: "" },
    ]);
  });

  it("handles a message split in the middle of a field", () => {
    expect(parse(["ev", "ent: line.upd", "ated\nda", "ta: {\"a\":1}", "\n\n"])).toEqual([{ event: "line.updated", data: '{"a":1}', id: "" }]);
  });

  it("ignores comments, retry and unknown fields, keeps the last id and strips a BOM", () => {
    const messages = parse(["﻿: keep-alive\nretry: 10\nid: 7\nfoo: bar\ndata\n\n", "data: x\n\n"]);
    expect(messages).toEqual([
      { event: "message", data: "", id: "7" },
      { event: "message", data: "x", id: "7" },
    ]);
  });

  it("does not dispatch an event without data and resets the event name", () => {
    expect(parse(["event: lonely\n\n", "data: y\n\n"])).toEqual([{ event: "message", data: "y", id: "" }]);
  });

  it("keeps a second leading space as part of the value", () => {
    expect(parse(["data:  two\n\n"])[0]!.data).toBe(" two");
  });
});
