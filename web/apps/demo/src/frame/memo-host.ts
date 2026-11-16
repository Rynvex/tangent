import { cutChars, DEFAULT_MEMO_LIMITS } from "@tangent/client";
import { describeError, useCreateMemo, useTangent, useUiT } from "@tangent/react";

export interface MemoSaverOptions {
  rootLineId: string | null;
  /** The line on screen: the memo is written on it. */
  lineId: string | null;
  /** The memo feature is on and the user can write. */
  enabled: boolean;
  toast: (message: string) => void;
  /** After a memo was written: the frame shows it (紀要 → 備忘). */
  onSaved: () => void;
}

/** Resolves true once written, false when refused (the toast says why); never rejects. */
export type SaveMemo = (text: string) => Promise<boolean>;

/**
 * 記成備忘 (B13, F10 everywhere in normal mode): the selection toolbar, a
 * message's menu and the composer write a memo on the line on screen, cut
 * to the memo limit; the toast confirms it and the frame shows it.
 */
export function useMemoSaver({ rootLineId, lineId, enabled, toast, onSaved }: MemoSaverOptions): SaveMemo | undefined {
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const create = useCreateMemo(rootLineId ?? "");
  if (!enabled || !rootLineId || !lineId) return undefined;
  return (text) => {
    const trimmed = text.trim();
    if (trimmed === "") return Promise.resolve(false);
    return create.mutateAsync({ lineId, text: cutChars(trimmed, DEFAULT_MEMO_LIMITS.maxRunes) }).then(
      () => {
        toast(t("memo.saved"));
        onSaved();
        return true;
      },
      (error: unknown) => {
        toast(t("memo.saveFailed", { reason: describeError(error, t, hostErrorText) }));
        return false;
      },
    );
  };
}
