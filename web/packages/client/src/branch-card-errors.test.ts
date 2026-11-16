import { describe, expect, it } from "vitest";
import { classifyReturnError, firstProblemField, problemsByField } from "./branch-card-errors";
import { TangentError } from "./errors";

const err = (status: number, code: string, extra: Record<string, unknown> = {}) => new TangentError(status, "backend text", code, extra);

describe("classifyReturnError", () => {
  it("maps invalid_card problems to field paths", () => {
    const failure = classifyReturnError(
      err(422, "invalid_card", {
        problems: [
          { field: "evidence[0].messageId", message: "not found" },
          { field: "excerpts[1].text", message: "not verbatim" },
          { field: "card", message: "too big" },
          { field: 3, message: "dropped" },
        ],
      }),
    );
    expect(failure.kind).toBe("invalid_card");
    if (failure.kind !== "invalid_card") return;
    const grouped = problemsByField(failure.problems);
    expect(grouped["evidence[0].messageId"]).toEqual(["not found"]);
    expect(grouped["excerpts[1].text"]).toEqual(["not verbatim"]);
    expect(grouped.card).toEqual(["too big"]);
    expect(firstProblemField(failure.problems)).toBe("evidence[0].messageId");
  });

  it("maps every refusal by its code, and 413 by status", () => {
    expect(classifyReturnError(err(409, "parent_busy")).kind).toBe("parent_busy");
    expect(classifyReturnError(err(409, "parent_moved", { movedMessages: 3, movedCards: 1 }))).toEqual({ kind: "parent_moved", movedMessages: 3, movedCards: 1 });
    for (const code of ["branch_busy", "branch_closed", "parent_closed", "archived"] as const) {
      expect(classifyReturnError(err(409, code))).toEqual({ kind: "state", code });
    }
    expect(classifyReturnError(err(422, "invalid_parent_tip")).kind).toBe("invalid_parent_tip");
    expect(classifyReturnError(err(400, "invalid_parent_tip")).kind).toBe("invalid_parent_tip");
    expect(classifyReturnError(new TangentError(413, "too large")).kind).toBe("payload_too_large");
    expect(classifyReturnError(new TangentError(500, "boom"))).toEqual({ kind: "other", message: "boom" });
    expect(classifyReturnError(new Error("plain"))).toEqual({ kind: "other", message: "plain" });
  });

  it("has no field to scroll to without problems", () => {
    expect(firstProblemField([])).toBeNull();
    expect(firstProblemField([{ field: "card", message: "m" }])).toBe("card");
  });
});
