import type { BranchView } from "@tangent/client";
import type { MessageKey } from "../i18n";
import { STATUS_KEYS } from "./models";

/** F11 §1: an aside (順口問) is a terminal leaf: one question, one answer, nothing forks from it. */
export function isAsideLeaf(branch: Pick<BranchView, "kind"> | null | undefined): boolean {
  return branch?.kind === "aside";
}

/**
 * A branch's status word: an aside reads 回答中 while its turn runs and 單輪葉節點 once answered (never 未帶回);
 * an open aside whose turn is not running (it failed, the retry is still to come) keeps the plain open status.
 */
export function branchStatusKey(branch: Pick<BranchView, "kind" | "status" | "lineStatus">): MessageKey {
  if (branch.kind !== "aside" || branch.status !== "open") return branch.kind === "aside" ? "branch.asideLeaf" : STATUS_KEYS[branch.status];
  return branch.lineStatus === "thinking" ? "branch.asideAnswering" : STATUS_KEYS.open;
}
