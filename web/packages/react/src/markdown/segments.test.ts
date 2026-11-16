import { describe, expect, it } from "vitest";
import { findOpenBlockOffset, splitSegments } from "./segments";

describe("splitSegments", () => {
  it("separates prose from closed fences and keeps every character", () => {
    const source = "intro\n```go\nx := 1\n```\noutro\n";
    const segments = splitSegments(source);
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "fence", "text"]);
    expect(segments.map((segment) => segment.text).join("")).toBe(source);
    expect(segments[1]).toMatchObject({ start: 6, isClosed: true });
  });

  it("marks an unterminated fence as open", () => {
    const segments = splitSegments("a\n```mermaid\ngraph TD\n");
    expect(segments[1]).toMatchObject({ kind: "fence", isClosed: false });
  });

  it("does not close a fence on a shorter or different marker", () => {
    expect(splitSegments("````\n```\n~~~\n")[0]?.isClosed).toBe(false);
  });
});

describe("findOpenBlockOffset", () => {
  it("is -1 when everything is closed", () => {
    expect(findOpenBlockOffset("```js\nx\n```\n\n$$\na\n$$\n")).toBe(-1);
  });

  it("returns the start of an unclosed fence", () => {
    const source = "text\n```mermaid\ngraph TD\n";
    expect(findOpenBlockOffset(source)).toBe(source.indexOf("```"));
  });

  it("returns the start of an unclosed display formula", () => {
    const source = "text\n$$\na^2 + b^2";
    expect(findOpenBlockOffset(source)).toBe(source.indexOf("$$"));
  });
});
