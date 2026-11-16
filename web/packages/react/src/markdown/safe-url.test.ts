import { describe, expect, it } from "vitest";
import { safeHref } from "./safe-url";

describe("safeHref", () => {
  it.each(["https://example.com/a?b=1", "http://example.com", "mailto:a@example.com"])("allows %s", (href) => {
    expect(safeHref(href)).not.toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "  JavaScript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:x",
    "/relative/path",
    "#anchor",
    "",
  ])("rejects %j", (href) => {
    expect(safeHref(href)).toBeNull();
  });

  it("rejects missing values", () => {
    expect(safeHref(undefined)).toBeNull();
  });
});

describe("resolveLanguage", () => {
  it("ignores prototype names such as constructor or __proto__", async () => {
    const { resolveLanguage } = await import("./highlight");
    expect(resolveLanguage("constructor")).toBeNull();
    expect(resolveLanguage("__proto__")).toBeNull();
    expect(resolveLanguage("toString")).toBeNull();
    expect(resolveLanguage("TS")).toBe("typescript");
  });
});
