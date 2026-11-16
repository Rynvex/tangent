import { describe, expect, it } from "vitest";
import { branchTitle } from "./branch-title";
import { echoT as t } from "./test-helpers";

describe("branchTitle", () => {
  it("names the old tail of a promotion from its origin, not its stored English purpose", () => {
    expect(branchTitle({ origin: "previous_main_line", purpose: "Previous main line" }, t)).toBe(t("branch.previousMainLine"));
  });
  it("uses the purpose otherwise", () => {
    expect(branchTitle({ origin: "button", purpose: "why is it slow" }, t)).toBe("why is it slow");
  });
});
