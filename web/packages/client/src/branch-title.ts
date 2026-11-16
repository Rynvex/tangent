import type { TranslateFn } from "./i18n-keys";
import type { BranchOrigin } from "./types";

/**
 * The name shown for a branch. The server stores the English "Previous main
 * line" for the ended old tail of a promotion; recognise it by `origin`.
 */
export function branchTitle(branch: { origin: BranchOrigin; purpose: string }, t: TranslateFn): string {
  return branch.origin === "previous_main_line" ? t("branch.previousMainLine") : branch.purpose;
}
