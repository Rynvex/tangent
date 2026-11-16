import type { enP2 } from "./en.p2";

/** Always-loaded P2 strings in Japanese. */
export const jaP2: Record<keyof typeof enP2, string> = {
  "message.pin": "ピン留め",
  "message.unpin": "ピン留め解除",
  "message.pinned": "ピン留め済み",
  "message.pinnedSent": "ピン留め・毎ターン送信",
  "preview.block.branch_conclusions": "他ブランチの結論",
  "message.relate": "関連付け…",
  "result.mergedInto": "「{title}」へ統合されました。",
  "result.mergedIntoLink": "「{title}」を開く",
  "branch.mergedInto": "「{title}」へ統合済み",
  "branch.mergedIntoGone": "統合先のブランチは削除または移動されました",
  "pin.failed": "ピン留めできませんでした：{reason}",
  "error.goalNotFound": "この会話には目標が設定されていません。",
  "error.relationNotFound": "この関連付けは見つかりませんでした。",
  "error.relationExists": "この2つはすでに関連付けられています。",
  "error.relationLimit": "この会話の関連付けが上限（{limit} 件）に達しています。",
  "error.memoLimit": "この会話の個人メモが上限（{limit} 件）に達しています。不要なものを削除してください。",
};
