/**
 * The delete-conversation dialog's wording (F7, demo-only): a bundle of its
 * own, so it loads with the dialog and never with the page.
 */
import { useBundleT, type MessageBundle } from "@tangent/react";

const en = {
  "delete.title": "Delete “{title}”?",
  "delete.permanent": "This cannot be undone.",
  "delete.tree": "The whole conversation goes: the main line, its {count} branches (open or ended alike) and every message, note and chapter in them.",
  "delete.treeNone": "The conversation goes with every message, note and chapter in it. It has no branches.",
  "delete.treeUnknown": "The whole conversation goes: the main line, all its branches and every message, note and chapter in them.",
  "delete.archiveHint": "Only want it out of the list? Archive it instead; you can restore it later.",
  "delete.archivedHint": "It is archived; once deleted it can no longer be restored.",
  "delete.cancel": "Cancel",
  "delete.archiveInstead": "Archive instead",
  "delete.confirm": "Delete conversation",
  "delete.deleting": "Deleting…",
  "delete.busy": "A reply is still running in this conversation. Wait for it to finish (or stop it), then delete.",
  "delete.failed": "Not deleted: {reason}",
  "delete.archiveFailed": "Not archived: {reason}",
} as const;

export type DeleteMessageKey = keyof typeof en;

const zhTW: Record<DeleteMessageKey, string> = {
  "delete.title": "刪除「{title}」？",
  "delete.permanent": "刪除後不能復原。",
  "delete.tree": "會刪掉整棵對話：主線、{count} 條支線（不論開著或已結束），以及其中所有訊息、紀要與章節。",
  "delete.treeNone": "會刪掉這段對話與其中所有訊息、紀要與章節。它沒有支線。",
  "delete.treeUnknown": "會刪掉整棵對話：主線、所有支線，以及其中所有訊息、紀要與章節。",
  "delete.archiveHint": "只是不想在清單上看到它？改用封存，之後還能解除封存。",
  "delete.archivedHint": "它已封存；刪除後就不能再解除封存。",
  "delete.cancel": "取消",
  "delete.archiveInstead": "改為封存",
  "delete.confirm": "刪除對話",
  "delete.deleting": "正在刪除…",
  "delete.busy": "這段對話裡還有正在回覆的回合。等它結束（或先停止）再刪除。",
  "delete.failed": "沒有刪除：{reason}",
  "delete.archiveFailed": "沒有封存：{reason}",
};

const ja: Record<DeleteMessageKey, string> = {
  "delete.title": "「{title}」を削除しますか？",
  "delete.permanent": "この操作は取り消せません。",
  "delete.tree": "会話ツリー全体（メインライン、進行中・終了済みを問わず {count} 本のブランチ、およびすべてのメッセージ・ノート・チャプター）が削除されます。",
  "delete.treeNone": "この会話とすべてのメッセージ・ノート・チャプターが削除されます（ブランチはありません）。",
  "delete.treeUnknown": "会話ツリー全体（メインライン、すべてのブランチ、メッセージ・ノート・チャプター）が削除されます。",
  "delete.archiveHint": "一覧から隠したいだけの場合は、後から復元できるアーカイブをご利用ください。",
  "delete.archivedHint": "すでにアーカイブ済みです。削除すると復元できなくなります。",
  "delete.cancel": "キャンセル",
  "delete.archiveInstead": "代わりにアーカイブ",
  "delete.confirm": "会話を削除",
  "delete.deleting": "削除中…",
  "delete.busy": "この会話ではまだ応答を処理中です。完了するか停止してから削除してください。",
  "delete.failed": "削除できませんでした：{reason}",
  "delete.archiveFailed": "アーカイブできませんでした：{reason}",
};

export const DELETE_MESSAGES: MessageBundle<DeleteMessageKey> = { en, "zh-TW": zhTW, ja };

export function useDeleteT() {
  return useBundleT(DELETE_MESSAGES);
}
