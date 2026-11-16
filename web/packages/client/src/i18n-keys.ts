/**
 * The message keys the pure logic of this package produces. `@tangent/react`
 * ships the `en` and `zh-TW` text for every one of them; a host that renders
 * its own UI supplies a `TranslateFn` that knows them.
 */
export const CLIENT_MESSAGE_KEYS = [
  // Branch errors (branch-errors.ts).
  "branch.errorUnknown",
  "branch.errorViewer",
  "branch.errorKindUnsupported",
  "branch.errorAnchorNotFound",
  "branch.errorDepthHard",
  "branch.depthBody",
  "branch.errorBranchLimit",
  "branch.errorTreeLimit",
  "branch.errorParentClosed",
  "branch.errorArchived",
  "branch.errorBranchClosed",
  "branch.errorBranchDrafting",
  "branch.errorInvalidCount",
  "branch.errorNotEnoughMessages",
  "branch.errorMoveStartUser",
  "branch.errorMoveProtected",
  "branch.errorMoveNoAnchor",
  "branch.errorSourceBusy",
  "branch.errorParentBusy",
  "branch.errorBranchBusy",
  "branch.errorPromoteNotTop",
  "branch.errorOpenOnOldTail",
  "branch.errorNotMainLine",
  "branch.errorSessionBusy",
  "branch.errorAsideAnswered",
  "branch.errorSuggestionNotFound",
  "branch.errorNoteLimit",
  // Expanding a seed (B8): the same text as any other seed refusal.
  "error.seedNotOpen",
  "error.seedNotFound",
  // Branch titles (branch-title.ts).
  "branch.previousMainLine",
  // Chapter errors (chapters.ts).
  "chapters.errorUnknown",
  "chapters.errorMessageNotFound",
  "chapters.errorMilestoneNotFound",
  "chapters.errorExists",
  "chapters.errorLimit",
  "chapters.errorArchived",
  "chapters.errorInvalid",
  "chapters.errorViewer",
] as const;

export type ClientMessageKey = (typeof CLIENT_MESSAGE_KEYS)[number];

export type TranslateParams = Readonly<Record<string, string | number>>;

/** Translates a key, interpolating `{name}` slots from `params`. */
export type TranslateFn = (key: ClientMessageKey, params?: TranslateParams) => string;

/**
 * The host's own text for an error code, or undefined. Hosts add translations
 * for their own codes (e.g. a `TurnGate` refusal); without one the server's
 * text is shown (DESIGN §12).
 */
export type HostErrorText = (code: string) => string | undefined;
