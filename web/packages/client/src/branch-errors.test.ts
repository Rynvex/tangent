import { describe, expect, it } from "vitest";
import { describeBranchError, isBranchStateError, isDepthSoftLimit } from "./branch-errors";
import { BRANCH_MOVE_MAX } from "./branch-move";
import { TangentError } from "./errors";
import { echoT as t } from "./test-helpers";

function failure(status: number, message: string, code = "", extra: Record<string, unknown> = {}): TangentError {
  return new TangentError(status, message, code, extra);
}

describe("describeBranchError", () => {
  it.each([
    ["anchor_not_found", "branch.errorAnchorNotFound"],
    ["parent_closed", "branch.errorParentClosed"],
    ["archived", "branch.errorArchived"],
    ["kind_unsupported", "branch.errorKindUnsupported"],
    ["branch_closed", "branch.errorBranchClosed"],
    ["branch_drafting", "branch.errorBranchDrafting"],
    ["not_enough_messages", "branch.errorNotEnoughMessages"],
    ["move_must_start_with_user", "branch.errorMoveStartUser"],
    ["move_protected_message", "branch.errorMoveProtected"],
    ["move_no_anchor", "branch.errorMoveNoAnchor"],
    ["source_busy", "branch.errorSourceBusy"],
    ["parent_busy", "branch.errorParentBusy"],
    ["branch_busy", "branch.errorBranchBusy"],
    ["promote_not_top_level", "branch.errorPromoteNotTop"],
    ["open_branches_on_old_tail", "branch.errorOpenOnOldTail"],
    ["branch_not_main_line", "branch.errorNotMainLine"],
    ["session_busy", "branch.errorSessionBusy"],
    ["aside_answered", "branch.errorAsideAnswered"],
    ["suggestion_not_found", "branch.errorSuggestionNotFound"],
    ["note_limit", "branch.errorNoteLimit"],
  ] as const)("explains %s", (code, key) => {
    expect(describeBranchError(failure(409, "server text", code), t).message).toBe(t(key));
  });

  it("quotes the limits the server sent, or the defaults", () => {
    expect(describeBranchError(failure(409, "x", "branch_limit", { limit: 5 }), t).message).toBe(t("branch.errorBranchLimit", { limit: 5 }));
    expect(describeBranchError(failure(409, "x", "branch_limit"), t).message).toBe(t("branch.errorBranchLimit", { limit: 8 }));
    expect(describeBranchError(failure(409, "x", "tree_limit"), t).message).toBe(t("branch.errorTreeLimit", { limit: 200 }));
    expect(describeBranchError(failure(400, "x", "invalid_count", { max: 12 }), t).message).toBe(t("branch.errorInvalidCount", { max: 12 }));
  });

  it("interpolates the depth and limit of a soft limit", () => {
    const error = failure(409, "deep", "depth_soft_limit", { depth: 4, limit: 3 });
    expect(describeBranchError(error, t).message).toBe(t("branch.depthBody", { depth: 4, limit: 3 }));
    expect(isDepthSoftLimit(error)).toBe(true);
  });

  it("states the hard limit without offering to continue", () => {
    const error = failure(409, "too deep", "depth_hard_limit", { limit: 6 });
    expect(describeBranchError(error, t).message).toBe(t("branch.errorDepthHard", { limit: 6 }));
    expect(isDepthSoftLimit(error)).toBe(false);
  });

  it("shows the backend text of a 400 and falls back for unknown errors", () => {
    expect(describeBranchError(failure(400, "purpose is required", "invalid_input"), t).message).toBe("purpose is required");
    expect(describeBranchError(new Error("boom"), t).message).toBe(t("branch.errorUnknown"));
    expect(describeBranchError(failure(409, "weird", "something_new"), t).message).toBe("weird");
    expect(describeBranchError(failure(403, "", ""), t).message).toBe(t("branch.errorViewer"));
    expect(describeBranchError(failure(409, "", "host_gate"), t).message).toBe(t("branch.errorUnknown"));
  });
});

describe("isBranchStateError", () => {
  it("is true for the codes that mean the branch changed under the user", () => {
    for (const code of ["branch_closed", "archived", "branch_drafting", "aside_answered"]) {
      expect(isBranchStateError(failure(409, "x", code))).toBe(true);
    }
    expect(isBranchStateError(failure(409, "x", "branch_busy"))).toBe(false);
    expect(isBranchStateError(new Error("x"))).toBe(false);
  });
});

describe("host-defined codes (DESIGN §12)", () => {
  it("show the server's text unless the host translated the code", () => {
    const error = failure(409, "the daemon is offline", "daemon_offline");
    expect(describeBranchError(error, t).message).toBe("the daemon is offline");
    expect(describeBranchError(error, t, (code) => (code === "daemon_offline" ? "守護程式離線" : undefined)).message).toBe("守護程式離線");
  });

  it("never let the host override a built-in code", () => {
    expect(describeBranchError(failure(409, "x", "parent_busy"), t, () => "host").message).toBe(t("branch.errorParentBusy"));
  });

  it("quote the move cap from branch-move when the error has none (review M7)", () => {
    expect(describeBranchError(failure(400, "x", "invalid_count"), t).message).toBe(t("branch.errorInvalidCount", { max: BRANCH_MOVE_MAX }));
  });
});
