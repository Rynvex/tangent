import { describe, expect, it } from "vitest";
import { escapeCurrencyDollars } from "./math-guard";

describe("escapeCurrencyDollars", () => {
  it("escapes prices so they cannot open a formula", () => {
    expect(escapeCurrencyDollars("It costs $5 and $10 total")).toBe("It costs \\$5 and \\$10 total");
    expect(escapeCurrencyDollars("range $5-$10")).toBe("range \\$5-\\$10");
    expect(escapeCurrencyDollars("only $5")).toBe("only \\$5");
  });

  it("keeps real inline and display formulas", () => {
    expect(escapeCurrencyDollars("let $x^2$ be")).toBe("let $x^2$ be");
    expect(escapeCurrencyDollars("single $x$ here")).toBe("single $x$ here");
    expect(escapeCurrencyDollars("$$\na^2\n$$")).toBe("$$\na^2\n$$");
  });

  it("handles a price next to a formula", () => {
    expect(escapeCurrencyDollars("pay $5 for $x+1$")).toBe("pay \\$5 for $x+1$");
  });

  it("leaves code spans and fences alone", () => {
    expect(escapeCurrencyDollars("run `echo $5 and $10`")).toBe("run `echo $5 and $10`");
    expect(escapeCurrencyDollars("```sh\necho $5 and $10\n```\n$5")).toBe("```sh\necho $5 and $10\n```\n\\$5");
  });

  it("does not double-escape", () => {
    expect(escapeCurrencyDollars("already \\$5 here")).toBe("already \\$5 here");
  });

  it("returns text without dollars untouched", () => {
    expect(escapeCurrencyDollars("plain")).toBe("plain");
  });
});
