import { describe, expect, it } from "vitest";
import { ASK_TEMPLATES, askSubject, askTemplatesFor, classifyExcerpt, askPurposeHead } from "./ask-templates";

describe("classifyExcerpt", () => {
  it("calls a short phrase without sentence punctuation a term", () => {
    expect(classifyExcerpt("豪斯多夫維度")).toBe("term");
    expect(classifyExcerpt("Weierstrass 函數")).toBe("term");
    expect(classifyExcerpt("CAP 定理")).toBe("term");
    expect(classifyExcerpt("  「碎形」 ")).toBe("term");
    expect(classifyExcerpt("Node.js")).toBe("term");
  });

  it("calls anything longer or punctuated a sentence", () => {
    expect(classifyExcerpt("碎形的維度可以不是整數。")).toBe("sentence");
    expect(classifyExcerpt("為什麼，這樣")).toBe("sentence");
    expect(classifyExcerpt("one line\nanother")).toBe("sentence");
    expect(classifyExcerpt("It works. Mostly")).toBe("sentence");
    expect(classifyExcerpt("字".repeat(26))).toBe("sentence");
    expect(classifyExcerpt("字".repeat(25))).toBe("term");
    expect(classifyExcerpt("   ")).toBe("sentence");
  });
});

describe("askSubject", () => {
  it("trims and takes off matching outer quotes or brackets, nested too", () => {
    expect(askSubject("  『「碎形」』 ")).toBe("碎形");
    expect(askSubject('"CAP"')).toBe("CAP");
    expect(askSubject("（附註）")).toBe("附註");
    expect(askSubject("「不成對")).toBe("「不成對");
    expect(askSubject("「a」與「b」")).toBe("「a」與「b」");
  });

  it("folds whitespace runs into one space", () => {
    expect(askSubject("a\n\n  b")).toBe("a b");
  });
});

describe("askPurposeHead", () => {
  it("keeps the first 28 characters and marks the cut", () => {
    expect(askPurposeHead("短句")).toBe("短句");
    expect(askPurposeHead("字".repeat(28))).toBe("字".repeat(28));
    expect(askPurposeHead("字".repeat(30))).toBe(`${"字".repeat(28)}…`);
    expect(askPurposeHead("😀".repeat(30))).toBe(`${"😀".repeat(28)}…`);
  });
});

describe("askTemplatesFor", () => {
  it("offers four templates per kind, the first the default", () => {
    expect(askTemplatesFor("term")).toEqual(ASK_TEMPLATES.term);
    expect(ASK_TEMPLATES.term).toEqual(["explain", "use", "principle", "compare"]);
    expect(ASK_TEMPLATES.sentence).toEqual(["why", "example", "challenge", "apply"]);
    expect(ASK_TEMPLATES.general).toEqual(["detail", "example", "challenge", "alternatives"]);
  });
});
