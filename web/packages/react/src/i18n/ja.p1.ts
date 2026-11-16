import type { enP1 } from "./en.p1";

/** Always-loaded P1 strings in Japanese. */
export const jaP1: Record<keyof typeof enP1, string> = {
  "leaf.kind.conclusion": "結論",
  "leaf.kind.decision": "決定",
  "leaf.kind.answer": "回答",
  "leaf.kind.dead_end": "行き止まり",
  "leaf.kind.to_continue": "要継続",
  "leaf.kindPrefix": "{kind}：",
  "parking.parked": "保留しました・token 消費なし",
  "parking.emptyComposer": "先に入力欄へ思いつきを書いてから「保留」を押してください。",
  "parking.tooLong": "保留トピックは最大 {limit} 文字までです。少し短くしてください。",
  "parking.failed": "保留できませんでした：{reason}",
  "feature.suggestions": "提案ボックス",
  "error.seedNotOpen": "このトピックはすでに展開・ノート保存・破棄のいずれかが実行されています。",
  "error.seedNotFound": "このトピックは見つかりませんでした。",
  "error.seedLimit": "保留ボックスがいっぱいです（上限 {limit} 件）。既存の項目を展開・整理してから追加してください。",
  "error.suggestionNotOpen": "この提案はすでに処理されたか期限切れです。",
  "error.suggestionNotFound": "この提案は見つかりませんでした。",
  "error.leafNotFound": "このブランチには完了マーカーがありません。",
  "error.invalidLeaf": "完了マーカーが無効です。種類と文字数を確認してください。",
  "message.spunOff": "新しい会話へ独立",
  "marker.spunOffLink": "独立済み →「{title}」",
  "spinoff.from": "独立元：{title}",
  "message.spinoff": "ここから新しい会話を作成",
  "spinoff.fromGone": "独立元：{title}（会話は削除済み）",
  "marker.spunOffGone": "独立済み →「{title}」（会話は削除済み）",
};
