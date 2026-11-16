/**
 * Incremental `text/event-stream` parser (WHATWG HTML §9.2.6). Feed it decoded
 * text in chunks of any size; it calls `onMessage` once per dispatched event.
 * `retry:` is ignored (the subscriber owns its backoff).
 */
export interface SseMessage {
  /** The `event:` field, or "message" when the event had none. */
  event: string;
  data: string;
  /** The last `id:` seen on the stream ("" until one arrives). */
  id: string;
}

export interface SseParser {
  push(chunk: string): void;
}

const DEFAULT_EVENT = "message";
const BOM = "﻿";

export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  let buffer = "";
  let started = false;
  let data: string[] = [];
  let event = "";
  let lastId = "";

  const dispatch = (): void => {
    if (data.length > 0) onMessage({ event: event || DEFAULT_EVENT, data: data.join("\n"), id: lastId });
    data = [];
    event = "";
  };

  const field = (line: string): void => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (name) {
      case "data":
        data = [...data, value];
        break;
      case "event":
        event = value;
        break;
      case "id":
        if (!value.includes("\0")) lastId = value;
        break;
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      if (!started && buffer.length > 0) {
        started = true;
        if (buffer.startsWith(BOM)) buffer = buffer.slice(BOM.length);
      }
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match) return;
        // A trailing "\r" may be the first half of "\r\n"; wait for the next chunk.
        if (match[0] === "\r" && match.index === buffer.length - 1) return;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        field(line);
      }
    },
  };
}
