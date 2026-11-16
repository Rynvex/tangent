import type { enP3 } from "./en.p3";

/** Japanese translations of en.p3.ts. */
export const jaP3: Record<keyof typeof enP3, string> = {
  "message.foldFrom": "ここから折りたたむ…",
  "tag.kind.question": "疑問",
  "tag.kind.idea": "アイデア",
  "tag.kind.pro": "賛成",
  "tag.kind.con": "反対",
  "tag.kind.decision": "決定",
  "tag.anchor": "分岐タグ：「{kind}」",
  "map.nodeTag": "{name}・{tag}",
  "error.foldNotFound": "この折りたたみは見つかりませんでした。",
  "error.foldOverlap": "この範囲は別の折りたたみと重なっています。",
  "error.foldLimit": "このラインの折りたたみが上限（{limit} 件）に達しています。",
  "error.invalidFold": "折りたたみには完了済みのメッセージが2〜200件必要です。",
  "message.diverge": "複数の方向性を比較…",
  "error.comparisonNotFound": "この比較は見つかりませんでした。",
  "error.comparisonNotReady": "比較表はまだ作成中です。",
  "error.comparisonDecided": "この比較はすでに決定済みです。",
  "error.invalidComparison": "比較するには、同じ親ライン上の進行中ブランチを2〜5件選択してください。",
  "preview.block.memory": "長期メモリ（会話横断）",
  "error.memoryNotFound": "このメモリは見つかりませんでした。",
  "error.memorySuperseded": "このメモリはすでに置き換えられています。最新の項目を編集してください。",
  "error.embedderUnavailable": "メモリサービスが一時的に利用できません。しばらくしてから再試行してください。",
  "error.invalidMemory": "メモリには種別・内容、および 1〜10 の重要度が必要です。",
};
