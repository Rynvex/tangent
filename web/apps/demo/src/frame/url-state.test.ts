import { describe, expect, it } from "vitest";
import { historyActionFor, readUrlState, urlWithState } from "./url-state";

describe("readUrlState", () => {
  it("reads the line and the message", () => {
    expect(readUrlState("?line=nas-b1&m=nas-m19")).toEqual({ line: "nas-b1", message: "nas-m19" });
  });

  it("has neither when the address names none", () => {
    expect(readUrlState("")).toEqual({ line: null, message: null });
    expect(readUrlState("?frame=embed&focus=1")).toEqual({ line: null, message: null });
  });

  it("treats empty values as absent", () => {
    expect(readUrlState("?line=&m=")).toEqual({ line: null, message: null });
  });

  it("ignores a message that has no line", () => {
    expect(readUrlState("?m=nas-m19")).toEqual({ line: null, message: null });
  });
});

describe("urlWithState", () => {
  const base = "http://localhost:5183/app?frame=embed&focus=1&lang=zh-TW#top";

  it("writes line and message and keeps every other parameter and the hash", () => {
    const url = new URL(urlWithState(base, { line: "okr", message: "okr-m2" }), base);
    expect(url.pathname).toBe("/app");
    expect(url.hash).toBe("#top");
    expect(Object.fromEntries(url.searchParams)).toEqual({ frame: "embed", focus: "1", lang: "zh-TW", line: "okr", m: "okr-m2" });
  });

  it("replaces an earlier line and message", () => {
    const url = new URL(urlWithState("http://x/?line=a&m=a1&theme=dark", { line: "b", message: null }), "http://x/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ line: "b", theme: "dark" });
  });

  it("takes both off for no line, even when a message is given", () => {
    const url = new URL(urlWithState("http://x/?line=a&m=a1&frame=app", { line: null, message: "a1" }), "http://x/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ frame: "app" });
  });

  it("leaves a plain path without a trailing question mark", () => {
    expect(urlWithState("http://x/?line=a", { line: null, message: null })).toBe("/");
  });

  it("encodes ids", () => {
    const url = new URL(urlWithState("http://x/", { line: "a b&c", message: null }), "http://x/");
    expect(url.searchParams.get("line")).toBe("a b&c");
  });
});

describe("historyActionFor", () => {
  const at = (line: string | null, message: string | null = null) => ({ line, message });

  it("pushes when the line changes", () => {
    expect(historyActionFor(at("a"), at("b"))).toBe("push");
    expect(historyActionFor(at(null), at("b"))).toBe("push");
    expect(historyActionFor(at("a", "a1"), at("b", "b1"))).toBe("push");
  });

  it("replaces when only the message changes", () => {
    expect(historyActionFor(at("a"), at("a", "a1"))).toBe("replace");
    expect(historyActionFor(at("a", "a1"), at("a", "a2"))).toBe("replace");
    expect(historyActionFor(at("a", "a1"), at("a"))).toBe("replace");
  });

  it("does nothing when nothing changes", () => {
    expect(historyActionFor(at("a", "a1"), at("a", "a1"))).toBe("none");
    expect(historyActionFor(at(null), at(null))).toBe("none");
  });
});
