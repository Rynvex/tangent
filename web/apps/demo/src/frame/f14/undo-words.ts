/**
 * The words of 復原這次匯入 (F14 decision #8): the toast's and the banner's
 * button and what it says when done. The frame owns the undo, so they load
 * with it; the import dialog uses the same ones.
 */
import { useBundleT, type MessageBundle } from "@tangent/react";

const en = {
  "done.undo": "Undo this import",
  "done.undone": "Undone: the {n} main lines this import made are deleted",
  "done.undoFailed": "{n} main lines could not be deleted; delete them from the list.",
  "done.undoneKept": "Undone: the {n} main lines this import made are deleted; {m} were attached to other conversations and stay there",
};

export type UndoWordKey = keyof typeof en;

const zhTW: Record<UndoWordKey, string> = {
  "done.undo": "復原這次匯入",
  "done.undone": "已復原：這次匯入的 {n} 條主線已刪除",
  "done.undoFailed": "有 {n} 條主線沒有刪掉，請從清單刪除。",
  "done.undoneKept": "已復原：這次匯入的 {n} 條主線已刪除；{m} 條已併入其他對話，保留在那裡",
};

const ja: Record<UndoWordKey, string> = {
  "done.undo": "このインポートを取り消す",
  "done.undone": "取り消しました：今回インポートした {n} 本のメインラインを削除しました",
  "done.undoFailed": "{n} 本のメインラインを削除できませんでした。一覧から削除してください。",
  "done.undoneKept": "取り消しました：今回インポートした {n} 本のメインラインを削除しました（他の会話に統合された {m} 本はそのまま残ります）",
};

export const UNDO_WORDS: MessageBundle<UndoWordKey> = { en, "zh-TW": zhTW, ja };

export const useUndoWords = () => useBundleT(UNDO_WORDS);

/** What an undo says: failed lines first, then the ones kept in another conversation (B20), else all deleted. */
export function undoText(result: { deleted: readonly string[]; kept: readonly string[]; failed: readonly string[] }, u: (key: UndoWordKey, params?: Record<string, number>) => string): string {
  if (result.failed.length > 0) return u("done.undoFailed", { n: result.failed.length });
  if (result.kept.length > 0) return u("done.undoneKept", { n: result.deleted.length, m: result.kept.length });
  return u("done.undone", { n: result.deleted.length });
}
