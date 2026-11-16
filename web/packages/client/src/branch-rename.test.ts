import { describe, expect, it } from "vitest";
import { canRenameBranch } from "./branch-promote";

describe("canRenameBranch (B13, the server's rule)", () => {
  it("allows open and ended branches", () => {
    for (const status of ["open", "merged", "discarded"] as const) expect(canRenameBranch({ status, origin: "button" })).toBe(true);
  });

  it("refuses a promoted branch and the previous main line", () => {
    expect(canRenameBranch({ status: "promoted", origin: "button" })).toBe(false);
    expect(canRenameBranch({ status: "discarded", origin: "previous_main_line" })).toBe(false);
  });
});
